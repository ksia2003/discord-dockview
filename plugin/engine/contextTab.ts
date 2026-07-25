/*
 * The context tab — the dock's permanent leftmost "what am I looking at" view.
 *
 * The context surface is permanently present and not part of channelTabs. Ordinary
 * channels have one fixed "channel" view (guild channel information/member list, group-DM
 * members, or a DM profile). Guild voice channels add a second fixed "voice-chat" view:
 * Discord's text chat for that voice channel. Both are non-closable/non-draggable and
 * live before ordinary DockWindows in the strip.
 *
 * ACTIVE STATE: whether the context tab is the currently-shown view is a per-channel
 * flag here (contextActiveByChannel). It is the DEFAULT view for a channel with no
 * remembered file tab — replacing the old empty-state as the default. Selecting a file
 * tab clears the flag for that channel; selecting the context tab (or entering a channel
 * whose last view was the context tab / which has no file tabs) sets it.
 *
 * This module holds NO React and NO DOM — pure per-channel flags + the id sentinel. The
 * DockTabs strip / DockPanel body read these to decide what to render.
 */

/** The sentinel id of the context tab (never collides with a window id like "w3"). */
export const CONTEXT_TAB_ID = "__dockview-context__";
export const VOICE_CHAT_TAB_ID = "__dockview-voice-chat__";

export type ContextView = "channel" | "voice-chat";

// Per-channel: is the context tab the active view in this channel? A channel absent from
// the map has never had a file tab focused, so it defaults to the context tab.
const contextActiveByChannel = new Map<string, boolean>();
// The last fixed view selected in each channel. Kept separately from the active flag so
// selecting a file tab and returning to the fixed surface restores CHANNEL vs CHAT.
const contextViewByChannel = new Map<string, ContextView>();

/** True when the context tab is the active view for `channelId`. Default TRUE for a
 *  channel we've never recorded (the context tab is the default view). @me (null) has no
 *  context tab, so it's false. */
export function isContextActive(channelId: string | null): boolean {
    if (channelId == null) return false;
    const v = contextActiveByChannel.get(channelId);
    return v === undefined ? true : v;
}

/** Mark the context tab active (true) or a file tab active (false) for `channelId`. */
export function setContextActive(channelId: string | null, active: boolean): void {
    if (channelId == null) return;
    contextActiveByChannel.set(channelId, active);
}

/** The active fixed view, or null while a file/thread tab is active. An unseen channel
 * defaults to the ordinary channel view; channelMemory seeds a fresh voice channel to
 * voice-chat before its first render. */
export function getContextView(channelId: string | null): ContextView | null {
    if (!isContextActive(channelId) || channelId == null) return null;
    return contextViewByChannel.get(channelId) ?? "channel";
}

/** Select one of the fixed views and make the context surface active. */
export function setContextView(channelId: string | null, view: ContextView): void {
    if (channelId == null) return;
    contextViewByChannel.set(channelId, view);
    contextActiveByChannel.set(channelId, true);
}

/** Seed the preferred fixed view only once. A returning voice channel keeps the user's
 * last CHANNEL/CHAT choice instead of being forced back to CHAT on every entry. */
export function seedContextView(channelId: string | null, view: ContextView): void {
    if (channelId == null || contextViewByChannel.has(channelId)) return;
    contextViewByChannel.set(channelId, view);
}

/** Clear all per-channel context flags (plugin stop / restart). */
export function resetContextTab(): void {
    contextActiveByChannel.clear();
    contextViewByChannel.clear();
    bypassChannel = null;
}

// --- native bypass (the error-card fallback's "Open native panel" escape) ---
// When acquisition fails, the context tab shows an honest error card with an "Open
// native panel" action. That action one-shot bypasses the seal: it dispatches the native
// toggle and asks channelMemory to SKIP the re-collapse until the next channel select, so
// the user isn't stranded. The bypass is armed for exactly one channel and consumed on
// the next channel switch.
let bypassChannel: string | null = null;

/** Arm the seal bypass for `channelId` (the "Open native panel" escape). */
export function armSealBypass(channelId: string | null): void { bypassChannel = channelId; }

/** Is the seal bypass armed for `channelId`? channelMemory reads this to skip re-collapse
 *  for that one channel. */
export function isSealBypassed(channelId: string | null): boolean {
    return channelId != null && bypassChannel === channelId;
}

/** Clear the bypass (consumed on channel switch). */
export function clearSealBypass(): void { bypassChannel = null; }
