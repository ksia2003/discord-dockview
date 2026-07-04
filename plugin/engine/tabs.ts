/*
 * Tab actions (browser-like per-channel tabs): pin / unpin / switch / close.
 *
 * The tab strip is the current channel's derived STRIP (pinned first, then this
 * channel's own tabs). These actions mutate the window stores (via window.ts's
 * move/remove primitives) + the active binding and ask the host to reflect the
 * resulting open state into the DOM (via the host bridge).
 *
 * Split out of window.ts to match the design tree; window.ts owns the collection
 * primitives (makeWindow / setActiveWindow / move / remove / openTab), this owns the
 * user-facing tab verbs.
 */

import { getCurrentChannelId } from "../host/channel";
import { getCacheEntry } from "./cache";
import { requestRender } from "./forceRender";
import { hostActions } from "./hostBridge";
import { bump } from "./loadToken";
import { setPendingScrollTop, snapshotActiveView } from "./viewState";
import {
    getActiveWindow, getActiveWindowId, getWindows, hasRealTab, moveToChannel, moveToPinned,
    reconcileActiveFromCache, removeWindowEverywhere, setActiveWindow
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

/** ⋯-menu pin: pin a window (default the active one). It MOVES from its channel's list
 *  into the global pinned list — a persistent tab that appears in every channel's
 *  strip. No copy, no descriptor bookkeeping (there is no per-channel descriptor any
 *  more). Dedup-on-open (openTab) plus move-not-copy keep a pinned file from ever also
 *  being a channel tab. */
export function pinActiveWindow(w: DockWindow = getActiveWindow()): void {
    if (w.pinned) return;
    moveToPinned(w);
    w.state.open = true;
    requestRender();
}

/** ⋯-menu unpin: unpin a window (default the active one). It MOVES from the global
 *  pinned list into the CURRENT channel's list — a channel-owned tab bound to the
 *  channel you are in. No "drop others": multiple channel tabs are legal now. */
export function unpinActiveWindow(w: DockWindow = getActiveWindow()): void {
    if (!w.pinned) return;
    moveToChannel(w, getCurrentChannelId());
    requestRender();
}

/** Close a tab (the ✕ on a tab acts on THAT window). The window is removed from
 *  whatever store holds it (pinned or a channel list). If the CLOSED tab was active,
 *  the RIGHT neighbour is activated (the tab that shifted left into this slot), else
 *  the left neighbour (it was rightmost). Closing the LAST tab in the current strip
 *  auto-HIDES the dock for this channel (like Chrome closing the window on its last
 *  tab) — it does NOT fall back to an empty shell. */
export function closeTab(id: string): void {
    const strip = getWindows();
    const idx = strip.findIndex(w => w.id === id);
    if (idx < 0) return;
    const win = strip[idx];
    const wasActive = win.id === getActiveWindowId();
    // snapshot the active window's view before any binding change.
    if (wasActive) snapshotActiveView(getActiveWindow());

    removeWindowEverywhere(win);

    // Recompute the strip AFTER removal.
    const rest = getWindows();

    // Closing the last tab in this channel's strip → HIDE the dock for this channel via
    // closePanel (sets this channel's visibility off + restores native sidebars). Note
    // this checks the *current channel's strip*, not any global set — a pinned tab that
    // stays visible in OTHER channels still counts as "there is a tab here".
    if (rest.length === 0 || !hasRealTab()) {
        bump(); // any in-flight loader from the closed window must not write back
        hostActions().closePanel();
        return;
    }

    if (wasActive) {
        // right-neighbour-else-left: after splicing at idx, the tab now AT idx is the
        // one that was to its right (prefer it); if idx is past the end (closed the
        // rightmost), fall to idx-1.
        const next = rest[idx] ?? rest[Math.max(0, idx - 1)];
        setActiveWindow(next);
        next.state.open = true;
        bump();
        reconcileActiveFromCache();
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
