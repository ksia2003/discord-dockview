/*
 * The payload cache + per-window state overlays.
 *
 * A resolved payload (decoded PDF/model/workbook or pristine source text) is
 * shared by identity. Mutable view/edit state and derived edited HTML are kept
 * on the DockWindow that owns the view, so two windows can show the same file
 * without cross-contamination. `activeCacheEntry` is an exact payload pointer;
 * the key alone is insufficient when a retry replaces a shared entry while
 * another window still renders the older payload.
 */

import { getViewer } from "../viewers/registry";
import { contentIdentity } from "./contentIdentity";
import {
    collectRetiredEntries as collectRetired,
    moveToShutdown,
    replaceCacheEntry,
    trackLoading,
    touchCurrentCacheEntry
} from "./cacheOwnership";
import {
    getWindowCacheState,
    windowCacheEntry
} from "./cacheState";
import type { CacheEntry, ContentType, DockWindow } from "./types";

export {
    getWindowCacheState, setRenderPayload, updateSourceDescriptor, windowCacheEntry
} from "./cacheState";

const CONTENT_CACHE_MAX = 3;

const contentCache = new Map<string, CacheEntry>();
const retiredCacheEntries = new Set<CacheEntry>();
const shutdownCacheEntries = new Set<CacheEntry>();
const disposedCacheEntries = new WeakSet<CacheEntry>();

// --- injected window access (set by window.ts at init, breaks the cycle) -----
interface WindowRegistry {
    getWindows(): DockWindow[];
    getActiveWindow(): DockWindow;
    getAllWindows?(): DockWindow[];
}
let windowRegistry: WindowRegistry | null = null;
export function registerWindowRegistry(reg: WindowRegistry): void {
    windowRegistry = reg;
}

// --- injected view-state restore (set by engine/viewState) -------------------
let viewRestore: ((win: DockWindow, e: CacheEntry) => void) | null = null;
export function registerViewRestore(fn: (win: DockWindow, e: CacheEntry) => void): void {
    viewRestore = fn;
}

/** The cache key shared with window.ts tab deduplication. */
export function cacheKeyFor(url: string | null, type: ContentType): string | null {
    return contentIdentity(url, type);
}

/** Look up the current payload entry by key (null key = miss). */
export function getCacheEntry(key: string | null): CacheEntry | undefined {
    return key == null ? undefined : contentCache.get(key);
}

/** Return the exact payload entry currently owned by a window. */
export function getActiveCacheEntry(win: DockWindow): CacheEntry | undefined {
    if (win.activeCacheEntry?.key === win.activeCacheKey) return win.activeCacheEntry;
    return getCacheEntry(win.activeCacheKey);
}

/** Set both exact ownership fields together; the pointer is authoritative. */
export function activateCacheEntry(win: DockWindow, entry: CacheEntry): void {
    win.activeCacheKey = entry.key;
    win.activeCacheEntry = entry;
}

/** A load may replace the current entry while another window still owns the old
 * payload. This predicate keeps resource-bearing stale entries alive until their
 * last window releases them. */
export function isCacheEntryLive(entry: CacheEntry): boolean {
    return liveCacheEntries().has(entry);
}

/** Insert a fresh entry. Replaced entries become retired payloads rather than being
 * disposed immediately: another DockWindow may still hold their live PDF/model/blob. */
export function putCacheEntry(entry: CacheEntry): void {
    trackLoading(entry, collectRetiredEntries);
    replaceCacheEntry(contentCache, retiredCacheEntries, entry);
    collectRetiredEntries();
}

/** Drop the current entry, retaining it until no live window owns its payload. */
export function dropCacheEntry(key: string): void {
    const entry = contentCache.get(key);
    if (!entry) return;
    contentCache.delete(key);
    retiredCacheEntries.add(entry);
    collectRetiredEntries();
}

/** Destroy/release everything an entry owns. Source and render viewers are both
 * consulted for conversion entries (e.g. postscript→pdf), while same-type viewers
 * are invoked only once. */
export function disposeCacheEntry(entry: CacheEntry): void {
    if (disposedCacheEntries.has(entry)) return;
    disposedCacheEntries.add(entry);
    const sourceViewer = getViewer(entry.sourceType ?? entry.type);
    const renderViewer = getViewer(entry.renderType ?? entry.type);
    try { sourceViewer?.dispose?.(entry); } catch { /* disposal is best-effort */ }
    if (renderViewer && renderViewer !== sourceViewer) {
        try { renderViewer.dispose?.(entry); } catch { /* disposal is best-effort */ }
    }
}

function allWindows(): DockWindow[] {
    return windowRegistry?.getAllWindows?.() ?? windowRegistry?.getWindows() ?? [];
}

/** Exact payload pointers referenced by live tabs. */
export function liveCacheEntries(): Set<CacheEntry> {
    const entries = new Set<CacheEntry>();
    for (const win of allWindows()) {
        const entry = getActiveCacheEntry(win);
        if (entry) entries.add(entry);
    }
    for (const entry of contentCache.values()) if (entry.loading) entries.add(entry);
    for (const entry of retiredCacheEntries) if (entry.loading) entries.add(entry);
    return entries;
}

/** The set of cache identities referenced by any live window. Kept as a public
 * contract for diagnostics and the LRU floor; resource eviction uses exact entries. */
export function liveCacheKeys(): Set<string> {
    const keys = new Set<string>();
    for (const entry of liveCacheEntries()) keys.add(entry.key);
    return keys;
}

export function collectRetiredEntries(): void {
    const live = liveCacheEntries();
    collectRetired(retiredCacheEntries, live, disposeCacheEntry);
    const shutdownPending = new Set<CacheEntry>([...shutdownCacheEntries].filter(entry => entry.loading));
    collectRetired(shutdownCacheEntries, shutdownPending, disposeCacheEntry);
}

/** Insert/refresh an entry as most-recently-used and evict past capacity. Any
 * exact entry referenced by a live window (pinned or transient) is never evicted. */
export function cacheTouch(entry: CacheEntry): void {
    // A stale window may mount an exact retired entry after another window's retry
    // replaced the key. Reordering must not resurrect that retired payload globally.
    if (!touchCurrentCacheEntry(contentCache, entry)) {
        collectRetiredEntries();
        return;
    }
    const live = liveCacheEntries();
    const cap = Math.max(CONTENT_CACHE_MAX, live.size);
    while (contentCache.size > cap) {
        let victim: string | null = null;
        for (const [key, candidate] of contentCache) {
            if (!live.has(candidate)) { victim = key; break; }
        }
        if (victim == null) break;
        const candidate = contentCache.get(victim)!;
        contentCache.delete(victim);
        disposeCacheEntry(candidate);
    }
    collectRetiredEntries();
}

/** Drop the whole cache (plugin stop), releasing every current and retired payload. */
export function clearContentCache(): void {
    const entries = new Set([...contentCache.values(), ...retiredCacheEntries]);
    moveToShutdown(entries, shutdownCacheEntries, disposeCacheEntry, entry => entry.loading);
    contentCache.clear();
    retiredCacheEntries.clear();
    // `resetCollection()` normally ran just before this hook, so no live window
    // can keep a shutdown entry alive. The loading accessor retains it until the
    // deferred loader publishes its payload and flips loading=false.
    collectRetiredEntries();
    for (const win of allWindows()) {
        win.activeCacheKey = null;
        win.activeCacheEntry = null;
    }
}

/** Point a window's content at a cached payload WITHOUT any fetch. Restores the
 * window-specific view/edit/derived-render overlay through the injected hook. */
export function mountFromCache(win: DockWindow, entry: CacheEntry): boolean {
    const scoped = windowCacheEntry(win, entry);
    win.content.name = scoped.name;
    win.content.type = scoped.renderType ?? scoped.type;
    win.content.url = scoped.renderUrl ?? scoped.url;
    win.content.error = scoped.error ?? null;
    win.content.loading = scoped.loading;
    win.content.html = scoped.html ?? null;
    win.content.frameHtml = scoped.frameHtml ?? null;
    win.content.code = scoped.code ?? null;
    win.content.codeLang = scoped.codeLang ?? "plaintext";
    win.content.binary = scoped.binary ?? false;
    win.content.pdf = {
        doc: scoped.pdfDoc ?? null,
        pages: scoped.pdfPages ?? 0,
        renderToken: win.content.pdf.renderToken + 1
    };
    win.content.model3d = {
        object: scoped.model3dObject ?? null,
        renderToken: win.content.model3d.renderToken + 1
    };
    win.content.pptx = {
        presentation: scoped.pptxPresentation ?? null,
        renderToken: win.content.pptx.renderToken + 1
    };
    win.content.xlsx = {
        names: scoped.xlsxWorkbook?.names ?? [],
        csv: scoped.xlsxWorkbook?.csv ?? [],
        formulas: scoped.xlsxWorkbook?.formulas ?? [],
        charts: scoped.xlsxWorkbook?.charts ?? [],
        renderToken: win.content.xlsx.renderToken + 1
    };
    activateCacheEntry(win, entry);
    viewRestore?.(win, scoped);
    const restored = windowCacheEntry(win, entry);
    if (entry.renderType === "rasterimage") {
        getWindowCacheState(win, entry.key)!.renderUrl = restored.renderUrl;
    }
    win.content.type = restored.renderType ?? restored.type;
    win.content.url = restored.renderUrl ?? restored.url;
    cacheTouch(entry);
    return true;
}
