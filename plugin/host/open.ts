/*
 * The host registration seam.
 *
 * The dock is the right rail itself. It has no destructive open/close lifecycle; the
 * optional F9 hide mode only removes it from layout temporarily while its root and tabs
 * stay mounted. This module wires that host into the engine bridge and seeds the
 * channel-memory id.
 */

import { registerHostActions } from "../engine/hostBridge";
import { onChannelSelect } from "../engine/channelMemory";
import { getCurrentChannelId } from "./channel";
import { applyHostWidth } from "./layout";
import {
    activateCurrentNativeSearchView, deactivateNativeSearchView, isCurrentNativeSearchActive
} from "./searchResults";
import {
    applyOpenState, ensureHost, hideContextBody, isDockTemporarilyHidden, revealDock, startHost, stopHost
} from "./mount";

/** Register the host with the engine bridge + seed the channel-memory id. Called once
 *  from index.tsx start() after the host starts. After this the engine's open/channel/
 *  tab paths drive the real DOM. */
export function registerHost(): void {
    registerHostActions({
        ensureHost,
        applyOpenState,
        applyHostWidth,
        revealDock,
        isDockTemporarilyHidden,
        hideContextBody,
        deactivateSearchView: deactivateNativeSearchView,
        isSearchViewActive: isCurrentNativeSearchActive,
        activateSearchView: activateCurrentNativeSearchView
    });
    // Run the same entry path for the channel we boot into. A direct memory assignment
    // would skip fixed-view seeding, which made a Vesktop launched directly into a voice
    // channel select CHANNEL instead of its permanent CHAT default.
    onChannelSelect(getCurrentChannelId());
}

// Re-export the host lifecycle so index.tsx imports one host module.
export { startHost, stopHost };
