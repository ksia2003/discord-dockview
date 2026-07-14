/*
 * Per-channel dock lifecycle (in-memory only).
 *
 * In the browser-like tab model the tab COLLECTION itself lives in engine/window.ts
 * (a per-channel list). This module owns only the channel-switch reaction: the dock is
 * ALWAYS visible (there is no show/hide state any more — the dock IS the right rail), so
 * a channel switch is purely NON-DESTRUCTIVE re-pointing — leaving a channel does
 * nothing to any tab list; entering one derives its strip, restores its last-active tab
 * (or leaves the empty-state body for an empty channel), and reseals the native panels.
 *
 * There is NO per-channel descriptor save/restore — a channel's whole tab set persists
 * in window.ts's channelTabs map for the session, so a return re-points the active
 * binding and the bodies re-show from cache (an evicted file lazily re-fetches on
 * activate). App restart clears everything (window.resetCollection), no disk write.
 */

import { requestRender } from "./forceRender";
import { hostActions } from "./hostBridge";
import { snapshotActiveView } from "./viewState";
import {
    activeIdFor, focusEmptyShell, getActiveWindow, reconcileActiveFromCache, setActiveWindow,
    setWindowChannelId
} from "./window";

let currentChannelId: string | null = null;

export function getCurrentChannelMemId(): string | null { return currentChannelId; }
export function setCurrentChannelMemId(id: string | null): void {
    currentChannelId = id;
    setWindowChannelId(id);
}

/**
 * React to a Discord channel switch. NON-DESTRUCTIVE: leaving a channel does NOTHING
 * to any tab list (a tab lives in exactly one channel's list and stays there for the
 * session). The dock is always visible, so this only: snapshots the outgoing tab's
 * view, switches the current channel, re-points the active window to the entering
 * channel's last-active tab (or a fresh empty-state shell for an empty channel), and
 * reseals the native member list / profile sidebar (they stay collapsed — the dock
 * holds the right slot permanently until Batch D does proper action interception).
 */
export function onChannelSelect(newId: string | null): void {
    if (newId === currentChannelId) return;
    const host = hostActions();

    // 1. Snapshot the outgoing active window's live view so returning to whatever tab
    //    it was reopens where it was.
    snapshotActiveView(getActiveWindow());

    // 2. Switch channel. window.ts derives every strip off this id, so set it FIRST.
    currentChannelId = newId;
    setWindowChannelId(newId);

    // 3. Re-point the active window to the entering channel's last-active tab (or its
    //    strip's last tab). An empty channel (no tabs — incl. @me) gets a fresh content-
    //    less scratch window so the empty-state body renders cleanly, not the previous
    //    channel's file.
    const activeId = activeIdFor(newId);
    if (activeId != null) {
        setActiveWindow(activeId);
        // A tab whose loader was superseded earlier hydrates from cache on activate.
        if (reconcileActiveFromCache()) getActiveWindow().content.seq += 1;
    } else {
        focusEmptyShell(newId);
    }

    if (newId == null) {
        // Going to @me / no real channel: tabs stay in their channels' lists (they
        // rehydrate when we return), but there is no host to show them.
        requestRender();
        return;
    }

    // 4. The dock is always open here: keep the native member list / profile sidebar
    //    collapsed (the dock holds the right slot) and reflect the layout.
    host.closeNativeChannelSidebar();
    host.ensureHost();
    host.applyOpenState();
    host.syncNativeMemberList(true);
    host.syncNativeProfileSidebar(true);
    requestRender();
}
