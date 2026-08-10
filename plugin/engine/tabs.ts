/*
 * Tab actions (browser-like per-channel tabs): switch / close.
 *
 * The tab strip is the current channel's flat STRIP (that channel's tabs). These
 * actions mutate the window store (via window.ts's remove primitive) + the active
 * binding and ask the host to reflect the resulting layout into the DOM (via the host
 * bridge). Closing the last tab never changes the F9 visibility state; when shown, the
 * dock falls back to its permanent context body.
 *
 * Split out of window.ts to match the design tree; window.ts owns the collection
 * primitives (makeWindow / setActiveWindow / remove / openTab), this owns the
 * user-facing tab verbs.
 */

import { destroyThreadPortal, selectThreadPortal } from "../viewers/thread/threadPortal";
import { getActiveCacheEntry, windowCacheEntry } from "./cache";
import { setContextActive } from "./contextTab";
import { requestRender } from "./forceRender";
import { hostActions } from "./hostBridge";
import { setPendingScrollTop, snapshotActiveView } from "./viewState";
import {
    focusEmptyShell, getActiveWindow, getActiveWindowId, getWindowChannelId, getWindows,
    reconcileActiveFromCache, removeWindowEverywhere, setActiveWindow
} from "./window";
import type { DockWindow } from "./types";

function selectPortalForWindow(win: DockWindow | null): void {
    selectThreadPortal(win?.content.type === "thread" ? win.content.threadChannelId : null);
}

/** Switch the visible tab to `id`: snapshot the leaving window's live view-state,
 *  bind the active window, restore the new window's saved scroll, re-render. */
export function switchToWindow(id: string): void {
    if (id === getActiveWindowId()) {
        // The binding may still point at this thread while Channel info/Search masks it.
        // Re-selecting the same tab must reveal its retained portal synchronously.
        selectPortalForWindow(getActiveWindow());
        return;
    }
    const target = getWindows().find(w => w.id === id);
    if (!target) return;
    snapshotActiveView(getActiveWindow());
    setLightboxClosed(getActiveWindow()); // never strand the lightbox over a hidden tab
    setActiveWindow(target);
    // if this window's loader was superseded but its cache resolved, hydrate now.
    reconcileActiveFromCache();
    getActiveWindow().content.seq += 1; // force a fresh body identity for the new tab
    selectPortalForWindow(getActiveWindow());
    hostActions().applyOpenState();
    requestRender();
    // re-apply the target window's saved scroll once its body re-commits.
    const active = getActiveWindow();
    const entry = getActiveCacheEntry(active);
    setPendingScrollTop(
        entry ? (windowCacheEntry(active, entry).view.scrollTop ?? null) : null,
        active
    );
}

/** Close a tab (the ✕ on a tab acts on THAT window). The window is removed from its
 *  channel list. If the CLOSED tab was active, the RIGHT neighbour is activated (the
 *  tab that shifted left into this slot), else the left neighbour (it was rightmost).
 *  Closing the LAST tab in the current strip leaves the current F9 visibility state
 *  unchanged and activates the permanent context body — a fresh content-less scratch
 *  window backs that view. */
export function closeTab(id: string): void {
    const strip = getWindows();
    const idx = strip.findIndex(w => w.id === id);
    if (idx < 0) return;
    const win = strip[idx];
    const wasActive = win.id === getActiveWindowId();
    // snapshot the active window's view before any binding change.
    if (wasActive) snapshotActiveView(getActiveWindow());

    // A thread tab owns an isolated chat portal (document.body root) — tear it down so the
    // captured chat unmounts + its overlay node is removed (no leak / no ghost overlay).
    if (win.content.type === "thread" && win.content.threadChannelId) {
        destroyThreadPortal(win.content.threadChannelId);
    }

    removeWindowEverywhere(win);

    // Recompute the strip AFTER removal.
    const rest = getWindows();

    if (rest.length === 0) {
        // Last file tab closed → the CONTEXT tab becomes the active view (its default for
        // a channel with no file tabs — member list / profile, not the empty-state card).
        // Focus a fresh content-less window so nothing stale backs the (now hidden) file
        // body, and flag the context tab active for this channel.
        focusEmptyShell(getWindowChannelId());
        setContextActive(getWindowChannelId(), true);
        selectThreadPortal(null);
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
        reconcileActiveFromCache();
        getActiveWindow().content.seq += 1;
        selectPortalForWindow(getActiveWindow());
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
