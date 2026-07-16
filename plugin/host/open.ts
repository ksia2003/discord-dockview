/*
 * The host registration seam.
 *
 * In the always-on rewrite the dock is the right rail itself — it has no show/hide
 * state, so the old open/close verbs (toggle / closePanel / closeForExclusiveTakeover)
 * are gone. This module now only wires the host into the engine bridge so the engine's
 * open/channel/tab paths drive the real DOM, and seeds the channel-memory id.
 */

import { registerHostActions } from "../engine/hostBridge";
import { setCurrentChannelMemId } from "../engine/channelMemory";
import { getCurrentChannelId } from "./channel";
import { applyHostWidth } from "./layout";
import { applyOpenState, ensureHost, startHost, stopHost } from "./mount";

/** Register the host with the engine bridge + seed the channel-memory id. Called once
 *  from index.tsx start() after the host starts. After this the engine's open/channel/
 *  tab paths drive the real DOM. */
export function registerHost(): void {
    registerHostActions({
        ensureHost,
        applyOpenState,
        applyHostWidth
    });
    // seed the per-channel memory with the channel we boot into (so the first save
    // targets the right channel, not "null").
    setCurrentChannelMemId(getCurrentChannelId());
}

// Re-export the host lifecycle so index.tsx imports one host module.
export { startHost, stopHost };
