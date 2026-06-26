/*
 * The host-level open/close verbs: toggle (the F9 keybind + the far-right dock X),
 * the full close, and the exclusive-takeover vacate. Plus registering the host with the
 * engine bridge so the engine's open/close/channel/tab paths stop being no-ops.
 *
 * These sit ABOVE mount.ts (DOM reflection) + exclusivity.ts (sidebar sync) +
 * window.ts (the collection): they drive the window-collection reset, persist the
 * open flag, then fan out to mount/exclusivity to make the DOM + native sidebars
 * match. They are the host side of what the old monolith's toggle() / closePanel() /
 * closeForExclusiveTakeover() did.
 */

import { dockHasWindows, saveCurrentChannelState, setCurrentChannelMemId } from "../engine/channelMemory";
import { requestRender } from "../engine/forceRender";
import { registerHostActions } from "../engine/hostBridge";
import { LS_OPEN, lsSet } from "../engine/persist";
import {
    addWindow, getActiveWindow, makeWindow, resetToClosedTransient, setActiveWindow,
    transientWindow
} from "../engine/window";
import { getCurrentChannelId } from "./channel";
import {
    closeNativeChannelSidebar, registerVacateDock, syncNativeMemberList, syncNativeProfileSidebar
} from "./exclusivity";
import { applyHostWidth } from "./layout";
import { applyOpenState, ensureHost, startHost, stopHost } from "./mount";

/** Close the image lightbox on whatever window we're vacating (its flag lives on
 *  the image viewer's view-state, created in P4 — a no-op-safe access until then). */
function closeLightbox(win = getActiveWindow()): void {
    const img = win.viewStates["image"] as { fullscreen?: boolean } | undefined;
    if (img) img.fullscreen = false;
}

/** The full close: the dock vacates the right slot entirely (every tab — pinned +
 *  transient — is dropped, the collection collapses to one closed transient).
 *  Persists open:false, restores the native sidebars / member list we collapsed,
 *  and re-renders. (The far-right dock X drives this via toggle().) */
export function closePanel(): void {
    closeLightbox();
    resetToClosedTransient(getCurrentChannelId());
    lsSet(LS_OPEN, "0");
    saveCurrentChannelState();
    applyOpenState();
    syncNativeMemberList(false);
    syncNativeProfileSidebar(false);
    requestRender();
}

/** Vacate the whole dock because a native sidebar is taking the slot (reverse
 *  takeover). Same as closePanel MINUS the member-list restore — the user just
 *  asked for that sidebar, so we must NOT re-collapse it (the exclusivity module
 *  already cleared the owed-restore flags before calling this). */
function closeForExclusiveTakeover(): void {
    closeLightbox();
    resetToClosedTransient(getCurrentChannelId());
    lsSet(LS_OPEN, "0");
    saveCurrentChannelState();
    applyOpenState(); // drops html.dockview-open → the sidebar is no longer CSS-hidden
    requestRender();
}

/** The dock toggle (F9 keybind + the far-right dock X): open the lone transient (the
 *  toggle never resurrects pinned tabs that were closed — pin-driven tabs come from
 *  opening files + pinning) or fully close the dock. Mirrors the open-side
 *  exclusivity (collapse member list like a thread) and the close-side restore. */
export function toggle(): void {
    const open = !dockHasWindows();
    if (open) {
        closeNativeChannelSidebar();
        let t = transientWindow();
        if (!t) {
            t = makeWindow({ pinned: false, ownerChannelId: getCurrentChannelId() });
            addWindow(t);
        }
        t.state.open = true;
        setActiveWindow(t);
        ensureHost();
    } else {
        resetToClosedTransient(getCurrentChannelId());
    }
    lsSet(LS_OPEN, open ? "1" : "0");
    saveCurrentChannelState();
    applyOpenState();
    syncNativeMemberList(open); // collapse the member list like a thread / restore on close
    syncNativeProfileSidebar(open);
    requestRender();
}

/** Register the host with the engine bridge + the exclusivity vacate slot, and seed
 *  the channel-memory id. Called once from index.tsx start() after the host starts.
 *  After this the engine's open/close/channel/tab paths drive the real DOM. */
export function registerHost(): void {
    registerHostActions({
        ensureHost,
        applyOpenState,
        closePanel,
        closeNativeChannelSidebar,
        syncNativeMemberList,
        syncNativeProfileSidebar,
        applyHostWidth
    });
    // exclusivity's reverse-takeover handlers vacate the dock through this slot.
    registerVacateDock(closeForExclusiveTakeover);
    // seed the per-channel memory with the channel we boot into (so the first save
    // targets the right channel, not "null").
    setCurrentChannelMemId(getCurrentChannelId());
}

// Re-export the host lifecycle so index.tsx imports one host module.
export { startHost, stopHost };
