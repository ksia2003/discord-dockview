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
import { showContent } from "./showContent";
import { snapshotActiveView } from "./viewState";
import {
    addWindow, getActiveWindow, getActiveWindowId, getWindows, hasRealTab, makeWindow,
    pruneOrphanTransients, reconcileActiveFromCache, removeWindow, setActiveWindow, transientWindow
} from "./window";
import type { ChannelDescriptor, ChannelMemory } from "./types";

const channelStates = new Map<string, ChannelMemory>();
let currentChannelId: string | null = null;

// Explicit per-channel dock VISIBILITY (show/hide), kept SEPARATE from content.
// Absent for a channel = unset → the dock defaults to visible iff there's content to
// show (a global pinned tab or this channel's preview). In-memory only, like
// channelStates. This map is the single source of truth for "is the dock shown
// here", replacing the old conflation of "a pinned window exists" with "open".
const channelVisibility = new Map<string, boolean>();

/** Set (or clear via re-set) a channel's explicit dock visibility. F9 / chip-open /
 *  last-tab-close drive this; a channel switch reads it back through dockVisible(). */
export function setChannelVisibility(channelId: string | null, visible: boolean): void {
    if (channelId == null) return;
    channelVisibility.set(channelId, visible);
}
/** Drop all per-channel visibility (plugin stop — paired with channelStates.clear()). */
export function clearChannelVisibility(): void { channelVisibility.clear(); }

export function getChannelStates(): Map<string, ChannelMemory> { return channelStates; }
export function getChannelState(channelId: string): ChannelMemory | undefined { return channelStates.get(channelId); }
export function getCurrentChannelMemId(): string | null { return currentChannelId; }
export function setCurrentChannelMemId(id: string | null): void { currentChannelId = id; }
/** Forget a channel's transient memory (a transient tab close clears its channel). */
export function deleteChannelState(channelId: string): void { channelStates.delete(channelId); }

/** Two descriptors point at the SAME file when their url + routing type match. The
 *  type guards a .svg opened as image vs code; we compare the routing type (the one
 *  the descriptor carries, == the cache key's type), consistent with how showContent
 *  re-derives the descriptor type on a cache hit. The display name is ignored. */
export function descriptorsMatch(a: ChannelDescriptor | null, b: ChannelDescriptor | null): boolean {
    if (!a || !b) return false;
    return a.url === b.url && a.type === b.type;
}

/** Is the dock VISIBLE in the current channel? Visibility is PER-CHANNEL and separate
 *  from content: an explicit show/hide (F9, chip-open, last-tab-close) wins; with no
 *  explicit choice the dock shows iff there's content to show (a global pinned tab or
 *  this channel's preview = hasRealTab). This is the single "is the dock open"
 *  predicate driving applyOpenState (the .dockview-open class), exclusivity, and the
 *  resize handler. It REPLACES the old dockHasWindows(), which returned true whenever a
 *  pinned window existed — making F9 compute "close" and destroy pinned tabs, and
 *  fusing global content with per-channel visibility (the root of the inconsistency). */
export function dockVisible(): boolean {
    const v = currentChannelId != null ? channelVisibility.get(currentChannelId) : undefined;
    if (v !== undefined) return v;
    return hasRealTab();
}

/** Remember the TRANSIENT window's preview DESCRIPTOR for the current channel (so a
 *  return re-shows it). Pinned windows are global (NOT per-channel) and never written
 *  here. Visibility lives separately in channelVisibility; we mirror it into the
 *  record's `open` field only for debug/inspection — restore gates on the descriptor. */
export function saveCurrentChannelState(): void {
    if (currentChannelId == null) return;
    const t = transientWindow();
    if (t && t.ownerChannelId === currentChannelId) {
        channelStates.set(currentChannelId, {
            open: channelVisibility.get(currentChannelId) ?? false,
            descriptor: t.activeDescriptor
        });
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
    // 0. Clean up any orphan content-less transients left by a prior switch BEFORE we
    //    identify the leaving transient — otherwise transientWindow() (first non-pinned)
    //    could return an orphan, we'd remove the wrong window, and this channel's preview
    //    would leak into the next channel (a non-pinned preview must stay channel-bound).
    pruneOrphanTransients();
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

    // 4. restore the entering channel's transient CONTENT (if it had a preview). This
    //    is purely about which tab exists — it NEVER forces the dock visible. A channel
    //    the user F9-hid is restored with its tab present but stays hidden (step 5).
    const mem = channelStates.get(newId);
    if (mem && mem.descriptor) {
        // GUARD (design §11): if a window is ALREADY open for this same file — a
        // PINNED tab pinned out of this very channel — don't spawn a second transient
        // for it (that's the channel-return duplication). Activate the existing tab
        // and forget the now-redundant channel memory instead.
        const dupe = getWindows().find(w => descriptorsMatch(w.activeDescriptor, mem.descriptor));
        if (dupe) {
            channelStates.delete(newId);
            setActiveWindow(dupe);
            if (reconcileActiveFromCache()) getActiveWindow().content.seq += 1;
        } else {
            const t = makeWindow({ pinned: false, ownerChannelId: newId });
            addWindow(t);
            setActiveWindow(t);
            restoreDescriptor(mem.descriptor);
        }
    } else if (getWindows().some(w => w.pinned)) {
        // No preview here, but pinned tabs persist → focus the last-active pinned.
        const pinned = getWindows().filter(w => w.pinned);
        if (!pinned.some(w => w.id === getActiveWindowId())) setActiveWindow(pinned[pinned.length - 1]);
        // a pinned window whose loader was superseded earlier hydrates from cache.
        if (reconcileActiveFromCache()) getActiveWindow().content.seq += 1;
    } else {
        // Nothing pinned, nothing remembered here. We deliberately do NOT create a
        // transient (a bare channel switch must never conjure a junk tab). Repoint a
        // dangling active binding so getActiveWindow() never dangles.
        if (!getWindows().some(w => w.id === getActiveWindowId())) {
            const fallback = getWindows()[getWindows().length - 1];
            if (fallback) setActiveWindow(fallback);
        }
    }

    // 5. apply the entering channel's VISIBILITY (per-channel, separate from content).
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
