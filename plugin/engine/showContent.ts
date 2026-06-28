/*
 * The content-type ROUTER.
 *
 * Given a descriptor (name/url/type), showContent computes the cache key, hits or
 * populates the cache, and — on a miss — hands the actual fetch+parse to the
 * format's viewer. The shared engine behind both load() (chip click) and
 * restoreDescriptor() (channel return). It does NOT touch open-state / channel
 * bookkeeping — the callers do that around it.
 *
 * ARCHITECTURAL CUT: the per-format parsing (loadPdf / loadCode / loadImage / …)
 * does NOT live here. The router calls getViewer(type)?.load(opts, token, entry,
 * ctx); each viewer owns its own loader (ported in P3+). When NO viewer is
 * registered for a type yet, the router lands the body on a graceful non-loading
 * state instead of hanging on `loading:true` forever — so the engine runs and
 * no-ops cleanly with zero viewers.
 *
 * VERBATIM: the load-token dual-write — a viewer loader ALWAYS writes its cache
 * `entry`, but only writes the live `content` while token.isCurrent(); a
 * superseded load still fills (and keeps alive, or disposes) its entry so nothing
 * leaks. The detectType round-trip on the descriptor (routing type ≠ render type
 * for retyped formats like xlsx/artifact) is preserved.
 */

import { getViewer } from "../viewers/registry";
import {
    cacheKeyFor, cacheTouch, disposeCacheEntry, getCacheEntry, mountFromCache, putCacheEntry
} from "./cache";
import { detectType } from "./detectType";
import { dvFetch } from "./fetch";
import { requestRender } from "./forceRender";
import { bump, nextToken } from "./loadToken";
import { setPendingScrollTop, snapshotActiveView } from "./viewState";
import { getActiveWindow } from "./window";
import type { CacheEntry, ContentType, LoadOpts, ViewerContext } from "./types";

export interface ShowOpts {
    name: string;
    html?: string | null;
    url?: string | null;
    type: ContentType;
    noCache?: boolean;
    id?: string | null;
}

/** Build the ViewerContext a loader (and its body) is handed by the engine —
 *  replaces the ambient `activeWindow` the old monolith reached for from inside
 *  components. `fetch` is the engine's dvFetch threaded through so a noCache retry
 *  bypasses the HTTP cache. */
function makeContext(win = getActiveWindow()): ViewerContext {
    return {
        window: win,
        content: win.content,
        requestRender,
        fetch: dvFetch
    };
}

/** Close the fullscreen image lightbox so switching files never strands the
 *  overlay over the wrong / a non-image body. The flag lives on the image
 *  viewer's view-state (P4); a no-op until then. */
function closeLightbox(win = getActiveWindow()): void {
    const img = win.viewStates["image"] as { fullscreen?: boolean } | undefined;
    if (img) img.fullscreen = false;
}

/** Show a file in the panel body. Returns "noop" (already shown), "cache"
 *  (restored from cache, no fetch) or "fetch" (a fresh load was kicked off). */
export function showContent(opts: ShowOpts): "noop" | "cache" | "fetch" {
    const win = getActiveWindow();
    const name = opts.name || "file";
    const type = opts.type;
    const url = opts.url ?? null;
    const key = opts.html != null ? null : cacheKeyFor(url, type);

    // --- same file already shown? -> no-op (keep DOM, scroll, zoom as-is) -----
    // A retry (noCache) skips the no-op shortcut so it actually re-fetches.
    if (!opts.noCache && key != null && key === win.activeCacheKey && win.content.name != null && win.content.error == null) {
        win.content.name = name;
        win.activeDescriptor = { name, url: url as string, type };
        return "noop";
    }

    // Leaving the current file: snapshot its live view-state into its entry.
    snapshotActiveView(win);
    // Switching to a DIFFERENT file (past the no-op guard) closes the lightbox so
    // we never strand the overlay over the wrong body.
    closeLightbox(win);

    // --- cache hit on a DIFFERENT file -> instant restore (no fetch) ----------
    const hit = !opts.noCache && key != null ? getCacheEntry(key) : null;
    if (hit && hit.error == null && !hit.loading) {
        bump(); // supersede any in-flight loader
        win.content.seq += 1; // new body identity (different file)
        hit.name = name; // honour the (possibly fresh) display name
        mountFromCache(win, hit);
        // The descriptor must re-PRODUCE this entry's cache key on a later restore,
        // so it carries the key's ROUTING type — not the entry's RENDER type. They
        // differ for a TSX `.artifact`: it's keyed/fetched as "html" (loadHtml re-
        // detects + re-wraps the source) but RENDERS as "mcpapp". Using hit.type
        // here would key a restore as "mcpapp|url" (miss → loadMcpApp with no html).
        win.activeDescriptor = { name, url: hit.url, type: detectType({ url: hit.url, name }) };
        return "cache";
    }

    // --- miss (or inline html / errored entry) -> fetch + populate cache ------
    const token = nextToken();
    win.content.name = name;
    win.content.url = url;
    win.content.error = null;
    win.content.loadingLabel = null; // a fresh load starts with the generic spinner
    win.content.binary = false;
    win.content.seq += 1;
    win.content.type = type;

    // Build a fresh cache entry for url-backed files (inline html isn't cached).
    let entry: CacheEntry | null = null;
    if (key != null && url != null) {
        // If a stale entry for this key exists (an errored one, or one whose fetch
        // is still in flight after we navigated away and came back), dispose it
        // first so its half-built doc can't leak when its loader resolves.
        const prior = getCacheEntry(key);
        if (prior) { disposeCacheEntry(prior); }
        entry = { key, name, type, url, codeLang: "plaintext", loading: true, view: {} };
        putCacheEntry(entry);
        win.activeCacheKey = key;
        cacheTouch(entry);
    } else {
        win.activeCacheKey = null;
    }
    // a brand-new load opens at the default view (no cached view to apply).
    setPendingScrollTop(null);

    // Hand the fetch+parse to the format's viewer. The load-token + cache entry go
    // with it: the viewer always writes `entry`, only writes `content` while
    // token.isCurrent(). With no viewer registered yet, land on a graceful state.
    const viewer = getViewer(type);
    const loadOpts: LoadOpts = { name, url, type, code: opts.html ?? null, noCache: opts.noCache };
    if (viewer) {
        viewer.load(loadOpts, token, entry, makeContext(win));
    } else {
        // No viewer for this type yet (engine running ahead of the viewers). Don't
        // hang on loading:true — show a non-loading body the UI can render as
        // unsupported. The entry is left non-loading too so a later return is a hit.
        win.content.loading = false;
        win.content.error = null;
        if (entry) entry.loading = false;
    }

    // Inline-html artifacts (no url) can't be re-loaded by descriptor, so they are
    // NOT remembered per-channel (a descriptor needs a url).
    win.activeDescriptor = url ? { name, url, type } : null;
    return "fetch";
}
