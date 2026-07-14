/*
 * Tab actions (browser-like per-channel tabs): switch / close.
 *
 * The tab strip is the current channel's flat STRIP (that channel's tabs). These
 * actions mutate the window store (via window.ts's remove primitive) + the active
 * binding and ask the host to reflect the resulting layout into the DOM (via the host
 * bridge). The dock is always open, so closing the last tab shows the empty-state body
 * (no auto-hide).
 *
 * Split out of window.ts to match the design tree; window.ts owns the collection
 * primitives (makeWindow / setActiveWindow / remove / openTab), this owns the
 * user-facing tab verbs.
 */

import { getCacheEntry } from "./cache";
import { requestRender } from "./forceRender";
import { hostActions } from "./hostBridge";
import { bump } from "./loadToken";
import { setPendingScrollTop, snapshotActiveView } from "./viewState";
import {
    focusEmptyShell, getActiveWindow, getActiveWindowId, getWindowChannelId, getWindows,
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

/** Close a tab (the ✕ on a tab acts on THAT window). The window is removed from its
 *  channel list. If the CLOSED tab was active, the RIGHT neighbour is activated (the
 *  tab that shifted left into this slot), else the left neighbour (it was rightmost).
 *  Closing the LAST tab in the current strip leaves the dock OPEN showing the empty-
 *  state body (the dock can no longer be closed) — a fresh content-less scratch window
 *  backs that empty card. */
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

    if (rest.length === 0) {
        // Last tab closed → the dock stays open showing the empty-state body. Focus a
        // fresh content-less window (NOT a tab) so the empty card renders cleanly.
        bump(); // any in-flight loader from the closed window must not write back
        focusEmptyShell(getWindowChannelId());
        hostActions().applyOpenState();
        requestRender();
        return;
    }

    if (wasActive) {
        // right-neighbour-else-left: after splicing at idx, the tab now AT idx is the
        // one that was to its right (prefer it); if idx is past the end (closed the
        // rightmost), fall to idx-1.
        const next = rest[idx] ?? rest[Math.max(0, idx - 1)];
        setActiveWindow(next);
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
