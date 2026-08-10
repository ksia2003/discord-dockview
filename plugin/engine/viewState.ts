/*
 * View-state snapshot / restore / scroll.
 *
 * When you leave a file (tab switch, channel switch, open another file) we
 * snapshot its live view-state into its cache entry; when you return we re-apply
 * it so the file reopens at the same scroll / zoom / page / mode / edits.
 *
 * The old monolith had a per-type if-ladder here (pdf → page/zoom/fit, image →
 * scale/pan, csv → mode, structured → tree mode, code/markdown/… → edit buffer).
 * That ladder is gone: each viewer now owns its slice via viewer.snapshot() /
 * viewer.restore(), and this module dispatches to it. The only thing that stays
 * generic is the shared scrollTop of the active body scroller. Until a viewer is
 * registered the dispatch is a no-op and only the generic scrollTop is handled —
 * which is exactly right for the engine on its own.
 */

import { getViewer, } from "../viewers/registry";
import { getActiveCacheEntry, registerViewRestore, windowCacheEntry } from "./cache";
import type { CacheEntry, DockWindow, ViewerContext } from "./types";

const HOST_ID = "dockview-root";

/** The scrollable body element (px scroll position lives here by default). */
export function bodyScroller(): HTMLElement | null {
    return document.querySelector<HTMLElement>(`#${HOST_ID} .dockview-body`);
}

/** The scroller that actually owns vertical scroll for the CURRENT view. Almost
 *  always .dockview-body — EXCEPT views that scroll internally (the CSV grid, the
 *  structured tree, a CodeMirror editor). Those viewers declare their own scroller
 *  via viewer.scrollerSelector(); the snapshot/restore reads through here so a
 *  file reopens at the same spot. */
export function viewScroller(win: DockWindow): HTMLElement | null {
    const viewer = getViewer(win.content.type);
    const sel = viewer?.scrollerSelector?.(makeScrollCtx(win));
    if (sel) {
        return document.querySelector<HTMLElement>(`#${HOST_ID} ${sel}`) || bodyScroller();
    }
    return bodyScroller();
}

// A minimal ViewerContext for the scroller/snapshot/restore dispatch. These paths
// only read window/content, so requestRender/fetch are inert stand-ins (the real
// context with a live fetch is built in showContent for the loader path).
function makeScrollCtx(win: DockWindow): ViewerContext {
    return {
        window: win,
        content: win.content,
        requestRender: () => { },
        fetch: (url: string) => fetch(url)
    };
}

/** Snapshot the CURRENT live view-state of `win` into its active cache entry so
 *  reopening this file lands on the same spot. The shared scrollTop is handled
 *  here; everything type-specific is delegated to the viewer. */
export function snapshotActiveView(win: DockWindow): void {
    if (win.activeCacheKey == null) return;
    const e = getActiveCacheEntry(win);
    if (!e) return;
    const scoped = windowCacheEntry(win, e);
    const sc = viewScroller(win);
    scoped.view.scrollTop = sc ? sc.scrollTop : scoped.view.scrollTop;
    const renderType = scoped.renderType ?? scoped.type;
    getViewer(renderType)?.snapshot(win.viewStates[renderType], scoped, makeScrollCtx(win));
}

/** Where a freshly-restored body's saved scroll is parked until its content
 *  mounts (consumePendingScroll re-applies it). */
const pendingScrollTop = new WeakMap<DockWindow, number | null>();

export function getPendingScrollTop(win: DockWindow): number | null {
    return pendingScrollTop.get(win) ?? null;
}
export function setPendingScrollTop(v: number | null, win: DockWindow): void {
    pendingScrollTop.set(win, v);
}

/** Apply a cache entry's saved view-state into `win` so the body renderer opens
 *  at the remembered zoom/page/scroll/mode. The viewer restores its own slice;
 *  the shared scrollTop is parked for consumePendingScroll. */
export function applyCachedView(win: DockWindow, e: CacheEntry): void {
    const scoped = windowCacheEntry(win, e);
    const renderType = scoped.renderType ?? scoped.type;
    getViewer(renderType)?.restore(win.viewStates[renderType], scoped);
    pendingScrollTop.set(win, scoped.view.scrollTop ?? null);
}

/** After a restore, re-apply the saved scroll once the body has its content. */
export function consumePendingScroll(win: DockWindow): void {
    const target = pendingScrollTop.get(win);
    if (target == null) return;
    pendingScrollTop.delete(win);
    const sc = viewScroller(win);
    if (sc) sc.scrollTop = target;
}

// Let cache.mountFromCache re-apply view-state without importing this module
// (which reads the cache) — closes the cache⇄viewState loop with a one-way hook.
registerViewRestore(applyCachedView);
