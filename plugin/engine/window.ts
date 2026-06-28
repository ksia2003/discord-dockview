/*
 * The dock window + the window collection (pin-driven tabs).
 *
 * One DockWindow holds the entire per-window state (content + the per-viewer
 * view-states + the cross-cutting edit/gallery slots + the active descriptor/
 * cache key). `windows[]` is a module singleton (survives @me / channel switches):
 *   - PINNED windows: global, persist everywhere, each shows as a tab.
 *   - at most ONE TRANSIENT window: channel-bound, replaced on each file open.
 * `activeWindow` is a live binding to the currently-shown window (reassigned by
 * setActiveWindow), so engine call sites read/write whichever window the tab
 * strip has focused. The collection starts as a single transient window; the tab
 * strip is always rendered, so that lone window simply shows as one tab.
 *
 * `state.width` is a getter/setter PROXY onto the one global dock width in
 * host/layout — every window agrees on the width, switching tabs never changes it.
 * makeWindow asks each registered viewer for its createState() slice rather than
 * inlining a fat literal (zero viewers registered = an empty viewStates map,
 * which the engine tolerates).
 *
 * NO module-top React.createElement: makeWindow runs at runtime, so its element-
 * free literal is safe.
 */

import { allViewers } from "../viewers/registry";
import { getDockWidth, seedDockWidthFromLS, setDockWidth } from "../host/layout";
import { cacheTouch, getCacheEntry, mountFromCache, registerWindowRegistry } from "./cache";
import { LS_OPEN, lsGet } from "./persist";
import type { DockWindow } from "./types";

let windowSeq = 0;
function nextWindowId(): string {
    return `w${++windowSeq}`;
}

/** Build a fresh, empty DockWindow. `pinned`/`ownerChannelId` set by the caller.
 *  Every window shares the same persisted open/width (the dock chrome is one). */
export function makeWindow(opts: { pinned: boolean; ownerChannelId: string | null }): DockWindow {
    // Seed the global dock width from LS on the first window (safe here: the
    // persist mirror exists by the time any makeWindow runs, unlike module-init).
    seedDockWidthFromLS();

    // Ask every registered viewer for its own view-state slice, keyed by type.
    // Empty until viewers are wired up (P3+); the engine treats these as opaque.
    const viewStates: Record<string, unknown> = {};
    for (const v of allViewers()) viewStates[v.type] = v.createState();

    return {
        id: nextWindowId(),
        pinned: opts.pinned,
        ownerChannelId: opts.ownerChannelId,
        // `open` is genuinely per-window (a pinned tab stays open while a transient
        // may not); `width` is a PROXY onto the single global dockWidth so every
        // window agrees and switching tabs never changes the dock width.
        state: {
            open: lsGet(LS_OPEN) === "1",
            get width() { return getDockWidth(); },
            set width(w: number) { setDockWidth(w); }
        },
        content: {
            name: null,
            type: "html",
            html: null,
            frameHtml: null,
            pdf: { doc: null, pages: 0, renderToken: 0 },
            code: null,
            codeLang: "plaintext",
            url: null,
            loading: false,
            error: null,
            binary: false,
            seq: 0
        },
        viewStates,
        // Cross-cutting capability slots (owned by edit/ and viewers/image/, not by
        // a viewer). Their initial values match the old makeWindow literal exactly.
        editView: {
            mode: "view",
            editBuffer: null
        },
        gallery: {
            channelId: null,
            items: [],
            hasMoreBefore: false,
            hasMoreAfter: false,
            loading: false
        },
        isNewFile: false,
        newFileChannel: null,
        activeDescriptor: null,
        activeCacheKey: null
    };
}

// --- the window collection --------------------------------------------------
// The first window is created LAZILY on first access — NEVER at module-eval. A
// module-top makeWindow() calls allViewers(), and during the engine↔viewer import
// cycle (registry imports CodeViewer → CodeBody → back into this module) that runs
// BEFORE the registry's VIEWERS map is initialised, so `VIEWERS.values()` is read
// off undefined and the whole plugin fails to load. Deferring it past eval avoids
// the cycle entirely.
let windows: DockWindow[] = [];
let activeWindowId = "";
let activeWindow: DockWindow = null as unknown as DockWindow;

function ensureInit(): void {
    if (windows.length) return;
    const w = makeWindow({ pinned: false, ownerChannelId: null });
    windows = [w];
    activeWindowId = w.id;
    activeWindow = w;
}

export function getWindows(): DockWindow[] { ensureInit(); return windows; }
export function getActiveWindow(): DockWindow { ensureInit(); return activeWindow; }
export function getActiveWindowId(): string { ensureInit(); return activeWindowId; }

// Give the cache a way to read the live window set / active window without
// importing this module (which imports the cache) — closes that loop one-way.
registerWindowRegistry({ getWindows, getActiveWindow });

/** The current transient (un-pinned) window, or null if there is none. There is
 *  at most one (it's channel-bound; a pin frees the slot). */
export function transientWindow(): DockWindow | null {
    return getWindows().find(w => !w.pinned) || null;
}

/** A window is a REAL tab — worth a tab in the strip / worth keeping the dock open
 *  for — when it is PINNED, or carries content (loaded, loading, or errored). A
 *  bare content-less transient (the F9-opened empty shell, or a transient that only
 *  holds the dock's "open" state) is NOT a real tab: the strip shows no tab for it
 *  and closing the last real tab auto-hides the dock. */
export function isRealTab(w: DockWindow): boolean {
    return w.pinned || w.content.name != null || w.content.loading || w.content.error != null;
}

/** True when any window is a real tab (a content tab or a pinned tab). */
export function hasRealTab(): boolean {
    return getWindows().some(isRealTab);
}

/** Append a window to the collection (used by the open / channel-switch paths). */
export function addWindow(w: DockWindow): void {
    windows.push(w);
}

/** Remove a window from the collection by reference. Returns its old index, or -1. */
export function removeWindow(w: DockWindow): number {
    const i = windows.indexOf(w);
    if (i >= 0) windows.splice(i, 1);
    return i;
}

/** Remove ORPHAN transients: non-pinned, content-less windows that aren't the active
 *  one. They accumulate when ensureInit injects a placeholder while the collection is
 *  transiently empty during a channel switch; left behind, transientWindow() (which
 *  returns the FIRST non-pinned) can return an orphan instead of the real channel
 *  transient — so the switch removes the wrong window and that channel's preview leaks
 *  into the next channel. The only legitimate content-less transient is the active F9
 *  empty shell, which is excluded. */
export function pruneOrphanTransients(): void {
    ensureInit();
    for (let i = windows.length - 1; i >= 0; i--) {
        const w = windows[i];
        if (!w.pinned && !isRealTab(w) && w.id !== activeWindowId) windows.splice(i, 1);
    }
}

/** Point `activeWindow`/`activeWindowId` at a window (by id or object). Pure
 *  binding swap — does NOT render or touch the DOM; callers re-render. */
export function setActiveWindow(w: DockWindow | string): void {
    ensureInit();
    const win = typeof w === "string" ? windows.find(x => x.id === w) : w;
    if (!win) return;
    activeWindow = win;
    activeWindowId = win.id;
}

/** Collapse the window collection back to a SINGLE closed transient bound to
 *  `channelId`, dropping every pinned tab (the dock is being VACATED as a whole —
 *  the header-X close and the exclusive-takeover both use this, where "close" means
 *  no windows left and the dock yields the right slot). A lone transient is reused
 *  if one exists (so its identity/scroll survives), else a fresh one is made; it is
 *  marked closed + active. The engine owns this collection-reset primitive; the host
 *  drives the surrounding open-state/persist/sidebar side-effects.
 *
 *  Returns the surviving (closed) transient so the host can clear viewer-owned slots
 *  on it (e.g. the image lightbox) without reaching back into the collection. */
export function resetToClosedTransient(channelId: string | null): DockWindow {
    ensureInit();
    const existing = transientWindow();
    windows.length = 0;
    const t = existing || makeWindow({ pinned: false, ownerChannelId: channelId });
    t.pinned = false;
    t.ownerChannelId = existing ? t.ownerChannelId : channelId;
    t.state.open = false;
    windows.push(t);
    setActiveWindow(t);
    return t;
}

/** If the active window's content is stuck loading (its in-flight loader was
 *  superseded by activity in another window — the load-token guard makes a loader
 *  write ONLY the cache entry once superseded) but its cache entry has since
 *  resolved, re-point content from the cache. This makes a window's body show its
 *  file the moment we show it again, even if its original loader never wrote back.
 *  Returns true if it reconciled. */
export function reconcileActiveFromCache(): boolean {
    const key = activeWindow.activeCacheKey;
    if (key == null) return false;
    if (!activeWindow.content.loading && activeWindow.content.error == null) return false;
    const e = getCacheEntry(key);
    if (!e || e.loading || e.error != null) return false;
    mountFromCache(activeWindow, e);
    return true;
}

// Re-export so callers that touch a window's cache entry don't reach past here.
export { cacheTouch, getCacheEntry, mountFromCache };
