/*
 * The per-file content LRU cache.
 *
 * Keyed by the file's load key (url|type). An entry holds the already-resolved
 * content (so a re-open needs no fetch) PLUS the saved view-state (scroll, zoom,
 * fit, page, image pan) so the file reopens EXACTLY where the user left it. The
 * currently-displayed file's entry is the one a window's `content` mirrors; we
 * snapshot its live view-state into the cache on every switch-away. Capacity is
 * small (most-recent files); eviction delegates resource release to the owning
 * viewer (only PDF actually needs it). Inline-html artifacts (no url) are never
 * cached (no stable key).
 *
 * Layering: cache is below window.ts (which imports it). To read the live window
 * set without a circular import, window.ts registers a tiny accessor at init via
 * registerWindowRegistry; the view-state restore that mountFromCache performs is
 * likewise an injected hook (engine/viewState fills it), so cache stays a low
 * dependency.
 */

import { getViewer } from "../viewers/registry";
import type { CacheEntry, ContentType, DockWindow } from "./types";

const CONTENT_CACHE_MAX = 3;

const contentCache = new Map<string, CacheEntry>();

// --- injected window access (set by window.ts at init, breaks the cycle) -----
interface WindowRegistry {
    getWindows(): DockWindow[];
    getActiveWindow(): DockWindow;
}
let windowRegistry: WindowRegistry | null = null;
export function registerWindowRegistry(reg: WindowRegistry): void {
    windowRegistry = reg;
}

// --- injected view-state restore (set by engine/viewState) -------------------
// mountFromCache restores the content payload here, then applies the cached
// view-state through this hook so the cache layer never imports the viewState
// module (which itself reads the cache).
let viewRestore: ((win: DockWindow, e: CacheEntry) => void) | null = null;
export function registerViewRestore(fn: (win: DockWindow, e: CacheEntry) => void): void {
    viewRestore = fn;
}

/** The cache key for a file: its url + content type (type disambiguates e.g. a
 *  .svg opened as image vs code, though in practice url is unique enough). */
export function cacheKeyFor(url: string | null, type: ContentType): string | null {
    return url ? `${type}|${url}` : null;
}

/** Look up an entry by key (null key = miss). */
export function getCacheEntry(key: string | null): CacheEntry | undefined {
    return key == null ? undefined : contentCache.get(key);
}

/** Insert a fresh entry under its key (used by showContent when a load begins). */
export function putCacheEntry(entry: CacheEntry): void {
    contentCache.set(entry.key, entry);
}

/** Drop an entry by key, disposing its resources. Used to clear a stale/errored
 *  entry before a re-fetch under the same key. */
export function dropCacheEntry(key: string): void {
    const e = contentCache.get(key);
    if (!e) return;
    contentCache.delete(key);
    disposeCacheEntry(e);
}

/** Destroy/release everything an evicted entry owns. The big resource is a pdf.js
 *  document (worker-side page caches); the PDF viewer's dispose() releases it.
 *  We do NOT revoke the entry's url — the plugin never creates object urls (it
 *  loads CDN http urls + the <img>/iframe stream them), so the url is owned by
 *  the caller and may be reused. */
export function disposeCacheEntry(e: CacheEntry): void {
    // The concrete release lives in the owning viewer (only pdf needs it); until
    // that viewer is registered this is a no-op, which is correct for the engine.
    getViewer(e.type)?.dispose?.(e);
}

/** The set of cache keys referenced by ANY live window (pinned tabs + transient).
 *  Every one of these MUST be non-evictable: each window's `content` still points
 *  at its entry's payloads (notably a live pdf.js doc), so evicting one would
 *  destroy a doc a hidden-but-live tab is still rendering. With several windows
 *  the active key alone is not enough — protect them all. */
export function liveCacheKeys(): Set<string> {
    const keys = new Set<string>();
    const windows = windowRegistry?.getWindows() ?? [];
    for (const w of windows) {
        if (w.activeCacheKey != null) keys.add(w.activeCacheKey);
    }
    return keys;
}

/** Insert/refresh an entry as most-recently-used and evict past capacity. Any
 *  entry referenced by a LIVE window (pinned or transient) is never evicted — its
 *  pdf doc is in use by that window's content, even when the tab isn't visible. */
export function cacheTouch(entry: CacheEntry): void {
    // re-insert at the end (Map preserves insertion order = LRU order).
    contentCache.delete(entry.key);
    contentCache.set(entry.key, entry);
    // The cache must hold at least every live window's entry; if more windows are
    // live than CONTENT_CACHE_MAX, the live floor wins (never evict a live entry).
    const live = liveCacheKeys();
    const cap = Math.max(CONTENT_CACHE_MAX, live.size);
    while (contentCache.size > cap) {
        // evict the oldest entry NOT referenced by any live window.
        let victim: string | null = null;
        for (const k of contentCache.keys()) {
            if (!live.has(k)) { victim = k; break; }
        }
        if (victim == null) break; // only live entries remain — nothing evictable
        const e = contentCache.get(victim)!;
        contentCache.delete(victim);
        disposeCacheEntry(e);
    }
}

/** Drop the whole cache (plugin stop), releasing every doc. */
export function clearContentCache(): void {
    for (const e of contentCache.values()) disposeCacheEntry(e);
    contentCache.clear();
    const active = windowRegistry?.getActiveWindow();
    if (active) active.activeCacheKey = null;
}

/** Point a window's `content` at a cached entry WITHOUT any fetch. Returns true on
 *  hit. Restores the GENERIC content payload fields here; the per-viewer view-
 *  state (zoom/page/mode/edit-buffer) is re-applied through the registered
 *  viewRestore hook (engine/viewState → viewer.restore). The caller owns the
 *  open/render bookkeeping around this. */
export function mountFromCache(win: DockWindow, e: CacheEntry): boolean {
    // Re-point the live content at the cached entry's payloads. We do NOT destroy
    // the OUTGOING doc — a cached doc stays alive in its own entry; here we just
    // re-point, since the live doc belongs to its cache entry.
    win.content.name = e.name;
    win.content.type = e.type;
    win.content.url = e.url;
    win.content.error = e.error ?? null;
    win.content.loading = e.loading;
    // payloads
    win.content.html = e.html ?? null;
    win.content.frameHtml = e.frameHtml ?? null;
    win.content.code = e.code ?? null;
    win.content.codeLang = e.codeLang ?? "plaintext";
    win.content.binary = e.binary ?? false;
    // pdf: re-point the live doc to the cached one (no destroy, no re-fetch).
    win.content.pdf = {
        doc: e.pdfDoc ?? null,
        pages: e.pdfPages ?? 0,
        renderToken: win.content.pdf.renderToken + 1
    };
    // model3d: re-point the live object to the cached parsed root (no re-fetch,
    // no re-parse). The body re-frames the camera from the saved view-state.
    win.content.model3d = {
        object: e.model3dObject ?? null,
        renderToken: win.content.model3d.renderToken + 1
    };
    // pptx: re-point the live model to the cached parsed presentation (no re-fetch,
    // no re-parse); the body re-renders the deck and jumps to the saved slide.
    win.content.pptx = {
        presentation: e.pptxPresentation ?? null,
        renderToken: win.content.pptx.renderToken + 1
    };
    // xlsx: re-point the live workbook to the cached parsed sheets (no re-fetch, no
    // re-parse); the body feeds the saved sheet's CSV into the grid.
    win.content.xlsx = {
        names: e.xlsxWorkbook?.names ?? [],
        csv: e.xlsxWorkbook?.csv ?? [],
        renderToken: win.content.xlsx.renderToken + 1
    };
    // re-apply the saved view-state + any per-viewer re-derivation (csv delimiter,
    // tree kind) via the viewer dispatch in engine/viewState.
    viewRestore?.(win, e);
    win.activeCacheKey = e.key;
    cacheTouch(e);
    return true;
}
