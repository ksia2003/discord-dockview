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

import { dockVisible, setChannelVisibility, setCurrentChannelMemId } from "../engine/channelMemory";
import { requestRender } from "../engine/forceRender";
import { registerHostActions } from "../engine/hostBridge";
import { focusEmptyShell, getActiveWindow, hasRealTab } from "../engine/window";
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

/** The full close (the far-right dock X): HIDE the dock for the current channel —
 *  flip its visibility off and let applyOpenState drop the .dockview-open class. Tabs
 *  are NOT destroyed: every pinned + preview window stays in the collection, so a
 *  re-open brings them all back. Restores the native sidebars / member list we
 *  collapsed (per the owed-restore set). */
export function closePanel(): void {
    closeLightbox();
    setChannelVisibility(getCurrentChannelId(), false);
    applyOpenState();
    syncNativeMemberList(false);
    syncNativeProfileSidebar(false);
    requestRender();
}

/** Vacate (hide) the dock because a native sidebar is taking the slot (reverse
 *  takeover). Same as closePanel MINUS the member-list restore — the user just asked
 *  for that sidebar, so we must NOT re-collapse it (the exclusivity module already
 *  dropped this channel's owed-restore entries before calling this). Tabs survive. */
function closeForExclusiveTakeover(): void {
    closeLightbox();
    setChannelVisibility(getCurrentChannelId(), false);
    applyOpenState(); // drops html.dockview-open → the sidebar is no longer CSS-hidden
    requestRender();
}

/** The dock toggle (F9 keybind + the far-right dock X): a PURE per-channel SHOW/HIDE.
 *  It flips this channel's visibility and NEVER destroys windows — pinned + channel
 *  tabs persist across a hide, so re-showing brings them all back (the fix for "F9 is
 *  a special action / it nukes my tabs"). Showing an empty channel (empty strip) just
 *  flips visibility on — the empty "Open a file…" shell is DERIVED (empty strip + dock
 *  visible), so we focus a fresh content-less active window for the empty card to read
 *  but add NO tab. Mirrors the open-side exclusivity (collapse member list like a
 *  thread) and the close-side restore via the per-channel owed-restore set. */
export function toggle(): void {
    const channelId = getCurrentChannelId();
    if (dockVisible()) {
        // HIDE — flip visibility off. Windows untouched; CSS hides via applyOpenState.
        setChannelVisibility(channelId, false);
        applyOpenState();
        syncNativeMemberList(false);
        syncNativeProfileSidebar(false);
    } else {
        // SHOW — flip visibility on. If nothing is worth a tab here, focus a fresh
        // content-less window (NOT a tab) so the empty shell body renders; the empty
        // shell is purely a visibility state (empty strip + dock visible).
        setChannelVisibility(channelId, true);
        if (!hasRealTab()) focusEmptyShell();
        closeNativeChannelSidebar();
        ensureHost();
        applyOpenState();
        syncNativeMemberList(true); // collapse the member list like a thread
        syncNativeProfileSidebar(true);
    }
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
