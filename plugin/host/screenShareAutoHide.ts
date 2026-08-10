/* Hide DockView once when Discord enters a screen-share participant viewer.
 *
 * A selected webcam is a USER participant. A selected screen share is a STREAM
 * participant and owns a `stream` descriptor, so semantic RTC-store state is more stable
 * than DOM classes or a guessed action payload.
 */

import { ChannelRTCStore } from "@vencord/types/webpack/common";

import { getCurrentChannelMemId } from "../engine/channelMemory";
import { hideDockTemporarily } from "./mount";

let listening = false;
let lastStreamSelection: string | null = null;

function selectedStreamIdentity(): string | null {
    const channelId = getCurrentChannelMemId();
    if (!channelId) return null;
    try {
        const participant: any = ChannelRTCStore?.getSelectedParticipant?.(channelId);
        if (!participant?.stream) return null;
        const identity = participant.id
            ?? participant.stream?.streamKey
            ?? participant.streamId
            ?? participant.stream?.ownerId;
        return identity == null ? `stream:${channelId}` : `${channelId}:${String(identity)}`;
    } catch {
        return null;
    }
}

/** Edge-triggered: while the same stream remains selected, F9 may reopen the dock and
 * unrelated speaking/video store changes must not hide it again. */
export function reconcileScreenShareSelection(): void {
    const next = selectedStreamIdentity();
    if (next && next !== lastStreamSelection) hideDockTemporarily();
    lastStreamSelection = next;
}

export function startScreenShareAutoHide(): void {
    if (listening) return;
    const store: any = ChannelRTCStore;
    if (!store || typeof store.addChangeListener !== "function") return;
    listening = true;
    lastStreamSelection = null;
    store.addChangeListener(reconcileScreenShareSelection);
    reconcileScreenShareSelection();
}

export function stopScreenShareAutoHide(): void {
    if (!listening) return;
    listening = false;
    try { (ChannelRTCStore as any)?.removeChangeListener?.(reconcileScreenShareSelection); }
    catch { /* Keep plugin teardown fail-safe if Discord already disposed the store. */ }
    lastStreamSelection = null;
}
