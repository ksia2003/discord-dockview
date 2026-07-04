/*
 * The dock windows + the per-channel tab collection (browser-like tabs).
 *
 * One DockWindow holds the entire per-window state (content + the per-viewer
 * view-states + the cross-cutting edit/gallery slots + the active descriptor/
 * cache key). The COLLECTION around the windows is three module-singleton stores
 * (they survive @me / channel switches; a plugin stop clears them):
 *
 *   - `pinned[]`     — GLOBAL, ordered, leftmost. A pinned tab (ownerChannelId=null)
 *                      appears in EVERY channel's strip.
 *   - `channelTabs`  — Map channelId -> ordered list of THAT channel's own unpinned
 *                      tabs. A channel accumulates N; they are only ever read out of
 *                      THIS map entry, so they NEVER appear in another channel.
 *   - `activeByChannel` — Map channelId -> the id of the tab focused when you are in
 *                      that channel (a pinned id is a legal value).
 *
 * A channel's STRIP is `[...pinned, ...channelTabs.get(cur)]` (pinned first), deduped
 * at insert time (a file that is pinned is never also a channel tab). `getWindows()`
 * returns the CURRENT channel's strip — that is what the tab UI, the debug surface,
 * and the rig snapshot all read.
 *
 * `activeWindow` is a live binding to the currently-rendered window (reassigned by
 * setActiveWindow), so engine call sites read/write whichever window the strip has
 * focused. `state.width` is a getter/setter PROXY onto the one global dock width in
 * host/layout — every window agrees on the width, switching tabs never changes it.
 * makeWindow asks each registered viewer for its createState() slice rather than
 * inlining a fat literal (zero viewers registered = an empty viewStates map, which
 * the engine tolerates).
 *
 * NO module-top React.createElement: makeWindow runs at runtime, so its element-free
 * literal is safe.
 */

import { allViewers } from "../viewers/registry";
import { getDockWidth, seedDockWidthFromLS, setDockWidth } from "../host/layout";
import { cacheTouch, getCacheEntry, mountFromCache, registerWindowRegistry } from "./cache";
import { LS_OPEN, lsGet } from "./persist";
import { snapshotActiveView } from "./viewState";
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
        // `open` is genuinely per-window (a pinned tab stays open while a channel tab
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
            model3d: { object: null, renderToken: 0 },
            pptx: { presentation: null, renderToken: 0 },
            xlsx: { names: [], csv: [], formulas: [], charts: [], renderToken: 0 },
            code: null,
            codeLang: "plaintext",
            url: null,
            loading: false,
            loadingLabel: null,
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

// --- the per-channel tab collection -----------------------------------------
// Three stores. They start EMPTY; a channel's list is created lazily on first open.
// A module-top makeWindow() would call allViewers() during the engine↔viewer import
// cycle (registry imports CodeViewer → CodeBody → back into this module) before the
// registry's VIEWERS map exists, so nothing is created at module eval — windows are
// only ever born inside openTab / the F9 path at runtime.
let pinned: DockWindow[] = [];
const channelTabs = new Map<string, DockWindow[]>();
const activeByChannel = new Map<string, string>();
let currentChannelId: string | null = null;

let activeWindowId = "";
let activeWindow: DockWindow = null as unknown as DockWindow;

/** The current channel the dock is deriving its strip for. Set by the channel-switch
 *  flow (channelMemory.onChannelSelect) so window.ts needs no import of that module. */
export function getWindowChannelId(): string | null { return currentChannelId; }
export function setWindowChannelId(id: string | null): void { currentChannelId = id; }

/** This channel's own unpinned tab list (created lazily). */
function ownTabs(channelId: string | null): DockWindow[] {
    if (channelId == null) return [];
    let list = channelTabs.get(channelId);
    if (!list) { list = []; channelTabs.set(channelId, list); }
    return list;
}

/** The ordered strip for a channel: pinned first (left), then that channel's own
 *  tabs. Dedup is maintained at INSERT time (openTab / pin), so a pinned file is
 *  never also a channel tab. A null channel (@me) shows only the pinned tabs. */
export function stripFor(channelId: string | null): DockWindow[] {
    const own = channelId != null ? (channelTabs.get(channelId) ?? []) : [];
    return [...pinned, ...own];
}

/** The CURRENT channel's strip — the surface DockTabs / __dockView.windows / the rig
 *  snapshot all read. Returns a fresh array each call (a derived view). */
export function getWindows(): DockWindow[] { return stripFor(currentChannelId); }

/** The global pinned list (leftmost in every strip). Live reference; callers that
 *  reorder pinned tabs (drag) mutate it in place. */
export function getPinnedWindows(): DockWindow[] { return pinned; }

/** A channel's own unpinned tab list (live reference, created lazily). Drag-reorder
 *  writes back into this. */
export function getChannelTabs(channelId: string | null): DockWindow[] {
    return channelId != null ? ownTabs(channelId) : [];
}

export function getActiveWindow(): DockWindow { ensureActive(); return activeWindow; }
export function getActiveWindowId(): string { ensureActive(); return activeWindowId; }

// Give the cache a way to read the live window set / active window without importing
// this module (which imports the cache) — closes that loop one-way. getWindows here
// returns the current strip, which is enough for the cache's live-key protection
// (it protects the strip that is actually mounted).
registerWindowRegistry({ getWindows: allLiveWindows, getActiveWindow });

/** EVERY live window across all stores (pinned + every channel's list). The cache's
 *  live-key protection must see them ALL — a background channel's tab still owns its
 *  pdf.js doc even though it isn't in the current strip. (getWindows returns only the
 *  current strip, so the cache reads this fuller set instead.) */
function allLiveWindows(): DockWindow[] {
    const all: DockWindow[] = [...pinned];
    for (const list of channelTabs.values()) all.push(...list);
    return all;
}
export { allLiveWindows };

/** Ensure `activeWindow` points at a real window. With no windows anywhere it stays a
 *  harmless sentinel-free binding: callers guard via getActiveWindow()'s content
 *  fields. We lazily fabricate a detached scratch window so getActiveWindow() never
 *  dereferences null before the first open (mirrors the old ensureInit shell, but this
 *  scratch window is NOT in any store — it is never a tab). */
function ensureActive(): void {
    if (activeWindow) return;
    activeWindow = makeWindow({ pinned: false, ownerChannelId: null });
    activeWindowId = activeWindow.id;
}

/** A window is a REAL tab — worth a tab in the strip / worth keeping the dock open
 *  for — when it is PINNED, or carries content (loaded, loading, or errored). A bare
 *  content-less window (the scratch active window before the first open) is NOT a real
 *  tab; the strip shows no tab for it. Channel tabs always carry content, so they are
 *  always real. */
export function isRealTab(w: DockWindow): boolean {
    return w.pinned || w.content.name != null || w.content.loading || w.content.error != null;
}

/** True when the CURRENT channel's strip has ≥1 tab (pinned or channel-owned). This is
 *  the "is there anything worth showing here" predicate dockVisible() falls back to. */
export function hasRealTab(): boolean {
    return stripFor(currentChannelId).some(isRealTab);
}

/** Point `activeWindow`/`activeWindowId` at a window (by id or object) + record it as
 *  the current channel's active tab. Pure binding swap — does NOT render or touch the
 *  DOM; callers re-render. Searching by id looks across the current strip. */
export function setActiveWindow(w: DockWindow | string): void {
    const win = typeof w === "string" ? stripFor(currentChannelId).find(x => x.id === w) : w;
    if (!win) return;
    activeWindow = win;
    activeWindowId = win.id;
    if (currentChannelId != null) activeByChannel.set(currentChannelId, win.id);
}

/** Find an existing tab in the CURRENT strip whose file matches `url`+`type`
 *  (dedup-on-open). Returns the window or null. */
function findTabByFile(url: string | null, type: string): DockWindow | null {
    if (url == null) return null;
    for (const w of stripFor(currentChannelId)) {
        if (w.activeDescriptor && w.activeDescriptor.url === url && w.activeDescriptor.type === type) return w;
    }
    return null;
}

/** OPEN a file as a tab in the CURRENT channel. Dedup: if the file is already open as
 *  a tab in the strip (pinned OR channel-owned) that tab is focused and returned — the
 *  strip does NOT grow. Otherwise a fresh channel-owned window is appended to this
 *  channel's list, made active, and returned. The caller (load/showContent) fills the
 *  returned window's content; before the bind swap the outgoing active view is
 *  snapshotted so a tab we switch away from reopens where it was.
 *
 *  `url`/`type` are the file identity for the dedup check (the routing type, matching
 *  the descriptor). A null url (inline html) can't dedup, so it always appends. */
export function openTab(url: string | null, type: string): DockWindow {
    const existing = findTabByFile(url, type);
    if (existing) {
        if (activeWindow !== existing) snapshotActiveView(activeWindow);
        setActiveWindow(existing);
        return existing;
    }
    const w = makeWindow({ pinned: false, ownerChannelId: currentChannelId });
    ownTabs(currentChannelId).push(w);
    if (activeWindow) snapshotActiveView(activeWindow);
    setActiveWindow(w);
    return w;
}

/** Ensure a channel-owned scratch window exists + is active for the F9 empty shell
 *  path used to need. In the new model an empty shell is DERIVED (empty strip + dock
 *  visible), so this only makes the active binding a fresh content-less window bound to
 *  the current channel WITHOUT adding it to any list (it carries no content, so it is
 *  never a tab). Used by the F9 show path so getActiveWindow() has a clean window for
 *  the empty card to read. */
export function focusEmptyShell(): DockWindow {
    const w = makeWindow({ pinned: false, ownerChannelId: currentChannelId });
    if (activeWindow) snapshotActiveView(activeWindow);
    activeWindow = w;
    activeWindowId = w.id;
    return w;
}

/** Remove a window from whatever store holds it (pinned or a channel list). Returns
 *  true if found + removed. Also drops it as any channel's active pointer. */
export function removeWindowEverywhere(w: DockWindow): boolean {
    let found = false;
    const pi = pinned.indexOf(w);
    if (pi >= 0) { pinned.splice(pi, 1); found = true; }
    for (const list of channelTabs.values()) {
        const i = list.indexOf(w);
        if (i >= 0) { list.splice(i, 1); found = true; }
    }
    for (const [cid, id] of activeByChannel) if (id === w.id) activeByChannel.delete(cid);
    return found;
}

/** MOVE a window from its channel list into the global pinned list (pin). Splice out of
 *  the owner channel's list, push onto pinned, retype as global. No copy. */
export function moveToPinned(w: DockWindow): void {
    if (w.pinned) return;
    for (const list of channelTabs.values()) {
        const i = list.indexOf(w);
        if (i >= 0) { list.splice(i, 1); break; }
    }
    w.pinned = true;
    w.ownerChannelId = null;
    if (!pinned.includes(w)) pinned.push(w);
}

/** MOVE a window from the global pinned list into the CURRENT channel's list (unpin).
 *  Splice out of pinned, append to the channel's list, retype as channel-owned. */
export function moveToChannel(w: DockWindow, channelId: string | null): void {
    if (!w.pinned) return;
    const pi = pinned.indexOf(w);
    if (pi >= 0) pinned.splice(pi, 1);
    w.pinned = false;
    w.ownerChannelId = channelId;
    if (channelId != null) {
        const list = ownTabs(channelId);
        if (!list.includes(w)) list.push(w);
    }
}

/** Drag-reorder: move the tab `dragId` to sit at the strip position of `beforeId`
 *  (drop BEFORE that tab), writing the new order back into the store that owns it.
 *  Reorder only happens WITHIN a partition — pinned tabs reorder among the pinned
 *  list, channel tabs among the current channel's list — so pinned-first is preserved
 *  (a channel tab can never be dragged left of a pinned tab, and vice-versa). A cross-
 *  partition drop is clamped to the boundary (no reparent; pin/unpin is the only way to
 *  cross). Returns true if anything moved. */
export function reorderTab(dragId: string, beforeId: string | null): boolean {
    const strip = stripFor(currentChannelId);
    const drag = strip.find(w => w.id === dragId);
    if (!drag) return false;
    const list = drag.pinned ? pinned : ownTabs(currentChannelId);
    const from = list.indexOf(drag);
    if (from < 0) return false;

    // Resolve the target index WITHIN this partition's list.
    let to: number;
    if (beforeId == null) {
        to = list.length; // dropped at the far end of this partition
    } else {
        const before = list.find(w => w.id === beforeId);
        // Dropping before a tab in the OTHER partition clamps to this list's boundary:
        // a channel tab dropped before a pinned tab goes to the channel list's front
        // (index 0); a pinned tab dropped before a channel tab goes to pinned's end.
        if (!before) to = drag.pinned ? list.length : 0;
        else to = list.indexOf(before);
    }
    list.splice(from, 1);
    if (to > from) to -= 1; // account for the removed element shifting indices
    to = Math.max(0, Math.min(to, list.length));
    list.splice(to, 0, drag);
    return list.indexOf(drag) !== from || to !== from;
}

/** The id of the tab that should be active when entering `channelId` — its remembered
 *  active pointer if it still resolves in the strip, else the strip's last tab, else
 *  null. Used by the channel-switch restore. */
export function activeIdFor(channelId: string | null): string | null {
    const strip = stripFor(channelId);
    if (strip.length === 0) return null;
    const remembered = channelId != null ? activeByChannel.get(channelId) : undefined;
    if (remembered != null && strip.some(w => w.id === remembered)) return remembered;
    return strip[strip.length - 1].id;
}

/** Clear ALL three stores + the active binding (plugin stop / restart). No disk
 *  serialization — the collection is session-only by design. */
export function resetCollection(): void {
    pinned = [];
    channelTabs.clear();
    activeByChannel.clear();
    currentChannelId = null;
    activeWindow = null as unknown as DockWindow;
    activeWindowId = "";
}

/** If the active window's content is stuck loading (its in-flight loader was
 *  superseded by activity in another window — the load-token guard makes a loader
 *  write ONLY the cache entry once superseded) but its cache entry has since resolved,
 *  re-point content from the cache. This makes a window's body show its file the moment
 *  we show it again, even if its original loader never wrote back. Returns true if it
 *  reconciled. */
export function reconcileActiveFromCache(): boolean {
    const key = activeWindow?.activeCacheKey;
    if (key == null) return false;
    if (!activeWindow.content.loading && activeWindow.content.error == null) return false;
    const e = getCacheEntry(key);
    if (!e || e.loading || e.error != null) return false;
    mountFromCache(activeWindow, e);
    return true;
}

// Re-export so callers that touch a window's cache entry don't reach past here.
export { cacheTouch, getCacheEntry, mountFromCache };
