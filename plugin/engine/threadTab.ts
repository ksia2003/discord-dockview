/*
 * Thread tabs — opening a Discord thread as a dock tab (the D-batch replacement for the
 * native thread sidebar, which action interception now swallows).
 *
 * A thread tab is a normal channel-bound DockWindow with content.type "thread" and
 * content.threadChannelId = the thread's id, living in the thread's PARENT channel strip
 * (spec §2: all tabs are channel-bound). It rides the whole tab model — dedup (same thread
 * → focus its tab), multiple threads open at once, closable like a file tab — with no new
 * lifecycle. The ThreadViewer's Body renders Discord's own chat component bound to the
 * thread (host/slotComponents.ts), so messages + composer work; nothing is fetched by the
 * plugin except the one-time message load the Body kicks.
 *
 * ARCHITECTURAL CUT: like load()/openTab, this owns the open + tab bookkeeping; the actual
 * chat rendering is the viewer's. It sets the window content directly (a thread has no
 * fetch/descriptor/cache), then reflects the layout + renders.
 */

import { requestRender } from "./forceRender";
import { hostActions } from "./hostBridge";
import { isContextActive, setContextActive } from "./contextTab";
import { getActiveWindow, getWindowChannelId, openThreadWindow } from "./window";
import { getChannelObject } from "../host/slotComponents";

/** Open (or focus) a dock tab for `threadId`. `parentId` is the thread's parent channel
 *  (from the SIDEBAR_VIEW_CHANNEL payload's baseChannelId); when absent we resolve it from
 *  the thread channel object. Dedup: reopening the same thread focuses its existing tab.
 *  The tab lives in the parent channel's strip and becomes the active view when the parent
 *  is the current channel. */
export function openThreadTab(threadId: string, parentId?: string | null): void {
    if (!threadId) return;
    // IDEMPOTENT GUARD (loop-breaker): the captured thread chat, rendered in our tree, can
    // itself dispatch SIDEBAR_VIEW_CHANNEL for its own channel — which interception routes
    // back here. If this thread tab is ALREADY the active view, this is a pure no-op (no
    // seq bump, no render), so re-entrancy can't spin a render loop.
    const active = getActiveWindow();
    if (active
        && active.content.type === "thread"
        && active.content.threadChannelId === threadId
        && !isContextActive(getWindowChannelId())) {
        return;
    }

    const thread = getChannelObject(threadId);
    // Prefer the payload's parent; fall back to the thread's own parent_id, then the
    // current channel (a thread opened from its parent's chat — the common path).
    const parent = parentId ?? thread?.parent_id ?? getWindowChannelId();

    const win = openThreadWindow(parent ?? null, threadId);
    // Fill the thread content (idempotent on a dedup-focus of an existing tab).
    win.content.type = "thread";
    win.content.threadChannelId = threadId;
    // The tab label is the thread name (isRealTab keys on content.name != null, so this
    // also makes the window a real tab). Fall back to a neutral label pre-resolution.
    win.content.name = thread?.name ?? "Thread";
    win.content.loading = false;
    win.content.error = null;
    win.content.url = null;
    win.content.seq += 1; // fresh body identity so the ThreadBody (re)mounts for this thread

    // Opening a thread tab makes it the active VIEW for its parent channel (yields the
    // context tab) — but only when the parent is the channel we're actually looking at.
    if ((parent ?? null) === getWindowChannelId()) {
        setContextActive(getWindowChannelId(), false);
    }

    // Reflect the dock into the DOM + render. No native sidebar to collapse — interception
    // ensured Discord never opened one — so this is just ensure-host + apply-layout.
    const host = hostActions();
    host.ensureHost();
    host.applyOpenState();
    requestRender();
}
