/*
 * Per-channel dock lifecycle (in-memory only).
 *
 * In the browser-like tab model the tab COLLECTION itself lives in engine/window.ts
 * (a per-channel list + a global pinned list). This module owns only the two things
 * that are genuinely a per-channel *lifecycle* concern:
 *
 *   1. VISIBILITY — the per-channel dock show/hide (F9 / chip-open / last-tab-close),
 *      a map SEPARATE from content. It is the single source of truth for "is the dock
 *      shown here", driving applyOpenState / exclusivity / the resize handler.
 *   2. The channel-switch reaction (onChannelSelect) — now NON-DESTRUCTIVE: leaving a
 *      channel does nothing to any tab list; entering one just derives its strip,
 *      restores its last-active tab, and applies its visibility.
 *
 * There is NO per-channel descriptor save/restore any more — a channel's whole tab set
 * persists in window.ts's channelTabs map for the session, so a return re-points the
 * active binding and the bodies re-show from cache (an evicted file lazily re-fetches
 * on activate). App restart clears everything (window.resetCollection), no disk write.
 */

import { requestRender } from "./forceRender";
import { hostActions } from "./hostBridge";
import { snapshotActiveView } from "./viewState";
import {
    activeIdFor, getActiveWindow, getActiveWindowId, hasRealTab, reconcileActiveFromCache,
    setActiveWindow, setWindowChannelId, stripFor
} from "./window";

let currentChannelId: string | null = null;

// Explicit per-channel dock VISIBILITY (show/hide), kept SEPARATE from content.
// Absent for a channel = unset → the dock defaults to visible iff there's content to
// show (a global pinned tab or one of this channel's own tabs). In-memory only. This
// map is the single source of truth for "is the dock shown here", replacing the old
// conflation of "a pinned window exists" with "open".
const channelVisibility = new Map<string, boolean>();

/** Set (or clear via re-set) a channel's explicit dock visibility. F9 / chip-open /
 *  last-tab-close drive this; a channel switch reads it back through dockVisible(). */
export function setChannelVisibility(channelId: string | null, visible: boolean): void {
    if (channelId == null) return;
    channelVisibility.set(channelId, visible);
}
/** Drop all per-channel visibility (plugin stop — paired with resetCollection()). */
export function clearChannelVisibility(): void { channelVisibility.clear(); }

export function getCurrentChannelMemId(): string | null { return currentChannelId; }
export function setCurrentChannelMemId(id: string | null): void {
    currentChannelId = id;
    setWindowChannelId(id);
}

/** Is the dock VISIBLE in the current channel? Visibility is PER-CHANNEL and separate
 *  from content: an explicit show/hide (F9, chip-open, last-tab-close) wins; with no
 *  explicit choice the dock shows iff there's a tab worth showing here (a global pinned
 *  tab or one of this channel's own tabs = hasRealTab). This is the single "is the dock
 *  open" predicate driving applyOpenState (the .dockview-open class), exclusivity, and
 *  the resize handler. */
export function dockVisible(): boolean {
    const v = currentChannelId != null ? channelVisibility.get(currentChannelId) : undefined;
    if (v !== undefined) return v;
    return hasRealTab();
}

/**
 * React to a Discord channel switch. NON-DESTRUCTIVE: leaving a channel does NOTHING
 * to any tab list (a tab lives in exactly one channel's list and stays there for the
 * session). Entering a channel derives its strip (`pinned ∪ its own tabs`), re-points
 * the active window to that channel's last-active tab, and applies its visibility.
 * Pinned windows are global (they appear in every strip); width stays global.
 */
export function onChannelSelect(newId: string | null): void {
    if (newId === currentChannelId) return;
    const host = hostActions();

    // 1. Snapshot the outgoing active window's live view so returning to whatever tab
    //    it was reopens where it was.
    snapshotActiveView(getActiveWindow());

    // 1b. An EMPTY F9 shell — the dock explicitly shown (channelVisibility === true)
    //     with NO tab worth showing (empty strip) — is ephemeral: forget its visibility
    //     on leave so it does NOT reappear when the user returns to this channel.
    //     dockVisible() then falls back to hasRealTab() (false) and the dock comes back
    //     closed. Content/pinned-backed visibility and an explicit hide are untouched.
    if (currentChannelId != null && channelVisibility.get(currentChannelId) === true && !hasRealTab()) {
        channelVisibility.delete(currentChannelId);
    }

    // 2. Switch channel. window.ts derives every strip off this id, so set it FIRST.
    currentChannelId = newId;
    setWindowChannelId(newId);

    // 3. Re-point the active window to the entering channel's last-active tab (or its
    //    strip's last tab). A null channel (@me) has no channel tabs; only pinned show,
    //    with no host to render them — still pick a sensible active window.
    const activeId = activeIdFor(newId);
    if (activeId != null) {
        setActiveWindow(activeId);
        // A tab whose loader was superseded earlier hydrates from cache on activate.
        if (reconcileActiveFromCache()) getActiveWindow().content.seq += 1;
    }

    if (newId == null) {
        // Going to @me / no real channel: pinned tabs stay in pinned[] (they rehydrate
        // when we return to a real channel), but there is no host to show them.
        requestRender();
        return;
    }

    // 4. apply the entering channel's VISIBILITY (per-channel, separate from content).
    //    Exclusivity is recomputed here for the entered channel; the per-channel
    //    owed-restore set inside syncNative* keeps the member list / profile sidebar
    //    consistent across switches (no stranded global flag).
    if (dockVisible()) {
        host.closeNativeChannelSidebar();
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
