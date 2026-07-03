/*
 * Tab actions (pin-driven multi-window): pin / unpin / switch / close.
 *
 * The tab strip is ALWAYS shown (one window or many) — a lone window is just a
 * single tab. These actions mutate the window collection + the active binding and
 * ask the host to reflect the resulting open state into the DOM (via the host
 * bridge — a no-op until Phase 2 registers the real host actions).
 *
 * Split out of window.ts to match the design tree; window.ts owns the collection
 * primitives (makeWindow / setActiveWindow / reconcile), this owns the user-facing
 * tab verbs.
 */

import { getCurrentChannelId } from "../host/channel";
import { deleteChannelState, descriptorsMatch, getChannelState } from "./channelMemory";
import { getCacheEntry } from "./cache";
import { requestRender } from "./forceRender";
import { hostActions } from "./hostBridge";
import { bump } from "./loadToken";
import { setPendingScrollTop, snapshotActiveView } from "./viewState";
import {
    getActiveWindow, getActiveWindowId, getWindows, hasRealTab,
    reconcileActiveFromCache, removeWindow, setActiveWindow
} from "./window";
import type { DockWindow } from "./types";

/** Switch the visible tab to `id`: snapshot the leaving window's live view-state,
 *  bind the active window, restore the new window's saved scroll, re-render. */
export function switchToWindow(id: string): void {
    if (id === getActiveWindowId()) return;
    const target = getWindows().find(w => w.id === id);
    if (!target) return;
    snapshotActiveView(getActiveWindow());
    setLightboxClosed(getActiveWindow()); // never strand the lightbox over a hidden tab
    setActiveWindow(target);
    // the target keeps the dock open (a tab you can see is an open dock).
    target.state.open = true;
    bump(); // any in-flight loader from the old window must not write here
    // if this window's loader was superseded but its cache resolved, hydrate now.
    reconcileActiveFromCache();
    getActiveWindow().content.seq += 1; // force a fresh body identity for the new tab
    hostActions().applyOpenState();
    requestRender();
    // re-apply the target window's saved scroll once its body re-commits.
    const key = getActiveWindow().activeCacheKey;
    setPendingScrollTop(key != null ? (getCacheEntry(key)?.view.scrollTop ?? null) : null);
}

/** ⋯-menu pin: pin the ACTIVE window so it becomes a persistent tab that survives
 *  channel switches. If the active window was the (channel-bound) transient,
 *  pinning it frees the transient slot for the next file open. */
export function pinActiveWindow(w: DockWindow = getActiveWindow()): void {
    if (w.pinned) return;
    // The window was the channel-bound transient: its file is also remembered in
    // its owner channel's memory (saveCurrentChannelState writes the transient's
    // descriptor). Once pinned it's GLOBAL, no longer bound to that channel — so if
    // the remembered descriptor is the same file, forget it. Otherwise returning to
    // the owner channel would restore a transient for it AND show the pinned tab,
    // duplicating the file (design §11).
    const owner = w.ownerChannelId;
    if (owner && descriptorsMatch(getChannelState(owner)?.descriptor ?? null, w.activeDescriptor)) {
        deleteChannelState(owner);
    }
    w.pinned = true;
    w.ownerChannelId = null; // pinned windows are global, not per-channel
    w.state.open = true;
    requestRender();
}

/** ⋯-menu unpin: unpin the active window. It becomes the channel's transient again
 *  (bound to the current channel). A channel holds at most ONE non-pinned window, so
 *  any OTHER non-pinned windows are dropped — the user explicitly unpinned THIS
 *  window, so it's the designated survivor (we can't route through acquireTransient
 *  here: that keeps the active window, but unpin must keep `w` even when a different
 *  transient is the active one, and must not change the active binding). Dropping the
 *  whole other-non-pinned set (not just the first) keeps the invariant even if a stray
 *  duplicate ever slipped in. */
export function unpinActiveWindow(w: DockWindow = getActiveWindow()): void {
    if (!w.pinned) return;
    for (const other of getWindows().filter(x => !x.pinned && x !== w)) removeWindow(other);
    w.pinned = false;
    w.ownerChannelId = getCurrentChannelId();
    requestRender();
}

/** Close a tab (the ✕ on a tab acts on THAT window). A PINNED tab is removed
 *  entirely (globally — it's a global tab); a TRANSIENT tab is cleared (its content
 *  detached, the window removed) so its channel reopens empty. After removal the
 *  active window falls back to a sensible neighbour. Closing the LAST remaining real
 *  tab HIDES the dock for this channel (native sidebars restored) — it does NOT
 *  destroy any other (pinned) tabs, and never falls back to an empty open shell. */
export function closeTab(id: string): void {
    const windows = getWindows();
    const idx = windows.findIndex(w => w.id === id);
    if (idx < 0) return;
    const win = windows[idx];
    // snapshot the active window's view before any binding change.
    if (win.id === getActiveWindowId()) snapshotActiveView(getActiveWindow());
    // if it's the transient, also forget its per-channel memory so the channel
    // reopens empty (closing a transient = clearing it).
    if (!win.pinned && win.ownerChannelId) deleteChannelState(win.ownerChannelId);
    windows.splice(idx, 1);

    // Closing the last REAL tab leaves the dock with nothing worth showing → HIDE it
    // for this channel via closePanel (sets this channel's visibility off + restores
    // native sidebars). closePanel is hide-not-destroy, so any surviving content-less
    // transient (an unused F9 shell) stays in windows[]. Repoint the active binding
    // off the just-closed window first so nothing renders a detached tab.
    if (!hasRealTab()) {
        bump(); // any in-flight loader from the closed window must not write back
        const survivor = windows[windows.length - 1];
        if (survivor) setActiveWindow(survivor);
        hostActions().closePanel();
        return;
    }
    if (win.id === getActiveWindowId()) {
        // focus a neighbour (prefer the previous tab, else the first).
        const next = windows[Math.max(0, idx - 1)];
        setActiveWindow(next);
        next.state.open = true;
        bump();
        getActiveWindow().content.seq += 1;
    }
    hostActions().applyOpenState();
    requestRender();
}

// The fullscreen image lightbox must never be left stranded over a hidden tab.
// The flag lives on the image viewer's view-state (created by the image viewer in
// P4); until then there is nothing to clear, so this is a no-op-safe access.
function setLightboxClosed(win: DockWindow): void {
    const img = win.viewStates["image"] as { fullscreen?: boolean } | undefined;
    if (img) img.fullscreen = false;
}
