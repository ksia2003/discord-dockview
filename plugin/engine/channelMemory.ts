/*
 * Per-channel memory (in-memory only).
 *
 * Each channel id remembers the descriptor of whatever was last loaded into its
 * TRANSIENT window + whether the dock was open there. On a Discord channel switch
 * (CHANNEL_SELECT → onChannelSelect) we save the leaving channel's transient and
 * restore the entering channel's — re-loading its file by descriptor through
 * showContent (a return re-shows from cache instantly; only an evicted file
 * re-fetches). Pinned windows are global and persist across channels untouched.
 *
 * The model is in-memory only by design (it never persists to disk): the dock is
 * a transient view over the current session.
 */

import { getCurrentChannelId } from "../host/channel";
import { detectType } from "./detectType";
import { requestRender } from "./forceRender";
import { hostActions } from "./hostBridge";
import { LS_OPEN, lsSet } from "./persist";
import { showContent } from "./showContent";
import { snapshotActiveView } from "./viewState";
import {
    addWindow, getActiveWindow, getActiveWindowId, getWindows, makeWindow,
    reconcileActiveFromCache, removeWindow, setActiveWindow, transientWindow
} from "./window";
import type { ChannelDescriptor, ChannelMemory } from "./types";

const channelStates = new Map<string, ChannelMemory>();
let currentChannelId: string | null = null;

export function getChannelStates(): Map<string, ChannelMemory> { return channelStates; }
export function getCurrentChannelMemId(): string | null { return currentChannelId; }
export function setCurrentChannelMemId(id: string | null): void { currentChannelId = id; }
/** Forget a channel's transient memory (a transient tab close clears its channel). */
export function deleteChannelState(channelId: string): void { channelStates.delete(channelId); }

/** True when the dock has ANY window to show (≥1 exists): a pinned tab, or a
 *  transient with content. The "dock open" predicate for member-list exclusivity. */
export function dockHasWindows(): boolean {
    const windows = getWindows();
    if (windows.some(w => w.pinned)) return true;
    const t = transientWindow();
    return !!t && t.state.open;
}

/** Persist the TRANSIENT window's state for the current channel. Pinned windows
 *  are global (NOT per-channel), so they are never written here — only the lone
 *  channel-bound transient slot is remembered per channel. */
export function saveCurrentChannelState(): void {
    if (currentChannelId == null) return;
    const t = transientWindow();
    if (t && t.ownerChannelId === currentChannelId && t.state.open && t.activeDescriptor) {
        channelStates.set(currentChannelId, { open: true, descriptor: t.activeDescriptor });
    } else if (t && t.ownerChannelId === currentChannelId) {
        // transient bound to this channel but empty/closed → remember closed.
        channelStates.set(currentChannelId, { open: t.state.open, descriptor: t.activeDescriptor });
    }
    // (No transient for this channel → leave any prior memory untouched.)
}

/** Load a remembered descriptor WITHOUT re-saving channel state (avoid loops).
 *  Goes through the content cache via showContent: a returned channel re-shows its
 *  file from cache instantly; only an evicted file is re-fetched. */
function restoreDescriptor(d: ChannelDescriptor): void {
    const type = d.type || detectType({ url: d.url, name: d.name });
    showContent({ name: d.name || "file", url: d.url, type });
}

/**
 * React to a Discord channel switch. PINNED windows persist (stay in windows[],
 * shown as tabs in every channel). The TRANSIENT window is channel-bound: save it
 * for the leaving channel and drop it from windows[], then restore the entering
 * channel's transient (recreated from its remembered descriptor). The visible set
 * becomes pinned ∪ (this channel's transient). The active window defaults to the
 * channel's transient if present, else the last-active pinned. Width stays global.
 */
export function onChannelSelect(newId: string | null): void {
    if (newId === currentChannelId) return;
    const host = hostActions();
    // 1. snapshot the active window's live view + save the leaving channel's
    //    transient descriptor.
    snapshotActiveView(getActiveWindow());
    saveCurrentChannelState();

    // 2. drop the channel-bound transient window — it's recreated per channel.
    //    (Its content cache entry survives, so a return re-shows it instantly.)
    const leaving = transientWindow();
    if (leaving) removeWindow(leaving);

    // 3. switch channel.
    currentChannelId = newId;
    if (newId == null) {
        // Going to @me / no real channel: keep the pinned windows in windows[]
        // (they rehydrate when we return to a real channel), but there is no host
        // to show them. Pick a sensible active window if any remain.
        const windows = getWindows();
        if (!windows.some(w => w.id === getActiveWindowId())) {
            const fallback = windows[windows.length - 1];
            if (fallback) setActiveWindow(fallback);
        }
        requestRender();
        return;
    }

    // 4. restore the entering channel's transient (if it had an open file).
    const mem = channelStates.get(newId);
    if (mem && mem.open && mem.descriptor) {
        const t = makeWindow({ pinned: false, ownerChannelId: newId });
        addWindow(t);
        setActiveWindow(t);
        host.closeNativeChannelSidebar();
        t.state.open = true;
        lsSet(LS_OPEN, "1");
        restoreDescriptor(mem.descriptor);
    } else if (getWindows().some(w => w.pinned)) {
        // No transient here, but pinned tabs persist → show the last-active pinned.
        const pinned = getWindows().filter(w => w.pinned);
        if (!pinned.some(w => w.id === getActiveWindowId())) setActiveWindow(pinned[pinned.length - 1]);
        host.closeNativeChannelSidebar();
        getActiveWindow().state.open = true;
        lsSet(LS_OPEN, "1");
        // a pinned window whose loader was superseded earlier hydrates from cache.
        if (reconcileActiveFromCache()) getActiveWindow().content.seq += 1;
    } else {
        // Nothing pinned, nothing remembered here → the dock is closed. Recreate
        // an empty closed transient so the single-window invariants hold.
        const t = makeWindow({ pinned: false, ownerChannelId: newId });
        t.state.open = mem ? mem.open : false;
        addWindow(t);
        setActiveWindow(t);
        lsSet(LS_OPEN, t.state.open ? "1" : "0");
    }

    // 5. apply the resulting dock-open state.
    if (dockHasWindows()) {
        host.ensureHost();
        host.applyOpenState();
        host.syncNativeMemberList(true);
        host.syncNativeProfileSidebar(true);
    } else {
        host.applyOpenState();
        host.syncNativeMemberList(false);
        host.syncNativeProfileSidebar(false);
    }
    requestRender();
}
