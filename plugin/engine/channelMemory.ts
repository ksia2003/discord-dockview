/*
 * Per-channel dock lifecycle (in-memory only).
 *
 * In the browser-like tab model the tab COLLECTION itself lives in engine/window.ts
 * (a per-channel list). This module owns only the channel-switch reaction. A channel
 * switch is purely NON-DESTRUCTIVE re-pointing — it neither reveals nor hides the dock;
 * leaving a channel does nothing to any tab list, while entering one derives its strip,
 * restores its last-active tab, and reseals the native panels.
 *
 * There is NO per-channel descriptor save/restore — a channel's whole tab set persists
 * in window.ts's channelTabs map for the session, so a return re-points the active
 * binding and the bodies re-show from cache (an evicted file lazily re-fetches on
 * activate). App restart clears everything (window.resetCollection), no disk write.
 */

import { requestRender } from "./forceRender";
import { hostActions } from "./hostBridge";
import { snapshotActiveView } from "./viewState";
import { clearSealBypass, getContextView, seedContextView, setContextActive } from "./contextTab";
import { isGuildVoiceChannel } from "../host/channel";
import { selectThreadPortal } from "../viewers/thread/threadPortal";
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
 * session). This only snapshots the outgoing tab's view, switches the current channel,
 * re-points the active window to the entering
 * channel's last-active tab (or a fresh empty-state shell for an empty channel), and
 * reseals the native member list / profile sidebar (they stay collapsed — the dock
 * holds the right slot permanently until Batch D does proper action interception).
 */
export function onChannelSelect(newId: string | null): void {
    if (newId === currentChannelId) return;
    const host = hostActions();

    // 0. A seal bypass ("Open native panel" from the context error card) is one-shot —
    //    consumed on the next channel switch, so the seal reseals normally from here on.
    clearSealBypass();

    // 1. Snapshot the outgoing active window's live view so returning to whatever tab
    //    it was reopens where it was.
    snapshotActiveView(getActiveWindow());

    // 2. Switch channel. window.ts derives every strip off this id, so set it FIRST.
    currentChannelId = newId;
    setWindowChannelId(newId);

    // 3. Re-point the active window to the entering channel's last-active tab (or its
    //    strip's last tab). An empty channel (no file tabs — incl. @me) gets a fresh
    //    content-less scratch window backing the body when a file tab is the active view.
    //    The CONTEXT tab is the DEFAULT view for a channel with no remembered file tab, so
    //    a fresh channel shows the member list / profile, not the empty-state card.
    const activeId = activeIdFor(newId);
    if (activeId != null) {
        setActiveWindow(activeId);
        // A tab whose loader was superseded earlier hydrates from cache on activate.
        if (reconcileActiveFromCache()) getActiveWindow().content.seq += 1;
    } else {
        focusEmptyShell(newId);
        // A voice channel's call/screen-share surface stays in the main column; its
        // permanent dock CHAT is the useful default. Seed only once so a user who later
        // chooses CHANNEL keeps that choice when returning.
        seedContextView(newId, isGuildVoiceChannel(newId) ? "voice-chat" : "channel");
        // No file tab here → the context tab is the active view (its default). Only force
        // this when the channel has never recorded a file selection; isContextActive
        // already defaults true for an unseen channel, so a channel the user explicitly
        // put on a file tab keeps that choice if it still has tabs.
        setContextActive(newId, true);
    }

    if (newId == null) {
        // Going to @me / no real channel: tabs stay in their channels' lists (they
        // rehydrate when we return), but there is no host to show them.
        selectThreadPortal(null);
        requestRender();
        return;
    }

    const active = getActiveWindow();
    selectThreadPortal(
        getContextView(newId) == null && active.content.type === "thread"
            ? active.content.threadChannelId
            : null
    );

    // 4. Mount + reflect the existing visible/temporarily-hidden state. A passive channel
    //    switch must not reveal a dock the user hid with F9. applyOpenState still
    //    hide-marks any native member list Discord renders by default, except for the
    //    one-shot native-panel escape.
    host.ensureHost();
    host.applyOpenState();
    requestRender();
}
