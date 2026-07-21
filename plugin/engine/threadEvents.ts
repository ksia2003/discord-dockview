/*
 * Thread-tab lifecycle events (Batch E — E1).
 *
 * Batch D opened threads as dock tabs; their tabs then only ever closed via the user's ✕.
 * A thread deleted OUTSIDE the app (archived-then-purged, deleted by someone else, or the
 * whole parent channel removed) left a GHOST tab in the strip whose portal pointed at a
 * dead channel. E1 closes those tabs by reacting to Discord's own thread Flux events, and
 * keeps a renamed thread's strip label in sync.
 *
 * The event names + payload shapes are live-verified on the rig (Discord 2026-07):
 *   THREAD_DELETE  { type, isNewlyCreated, channel } — channel.id = the deleted thread,
 *                  channel.parent_id = its parent channel. Fires for archive-purge, an
 *                  explicit delete, and a delete by another user.
 *   THREAD_UPDATE  { type, isNewlyCreated, channel } — channel.id = thread, channel.name =
 *                  the (possibly new) name. This is the rename event.
 *   CHANNEL_DELETE { type, channel } — channel.id = the deleted channel. When a channel is
 *                  removed, its threads go with it; any thread tab whose PARENT is that
 *                  channel is orphaned, so we close those too (cheap: one strip scan).
 *
 * These are registered as plain Vencord `flux:` subscriptions (auto-added on start, removed
 * on stop) — NOT through the interception dispatch WRAP, because we do NOT swallow them: the
 * store must still process a real delete/rename. We only observe and reconcile our tabs.
 *
 * NO module-top webpack/DOM access — every handler is called at dispatch time.
 */

import { closeThreadTabEverywhere, renameThreadTab } from "./threadTab";
import { allThreadTabs } from "./window";

/** THREAD_DELETE — a thread was deleted outside the app. Close its dock tab wherever it
 *  lives (any channel's strip) so no ghost tab / dead portal survives. */
export function onThreadDelete(payload: any): void {
    const id = payload?.channel?.id ?? payload?.id;
    if (id) closeThreadTabEverywhere(String(id));
}

/** THREAD_UPDATE — a thread was renamed (or otherwise updated). Follow the strip label so a
 *  background thread tab (never mounts a ThreadBody, so it can't self-heal) still updates. */
export function onThreadUpdate(payload: any): void {
    const ch = payload?.channel;
    if (ch?.id && typeof ch.name === "string") renameThreadTab(String(ch.id), ch.name);
}

/** CHANNEL_DELETE — a channel was removed; its threads went with it. Close any thread tab
 *  whose PARENT is the deleted channel (Discord fires THREAD_DELETE per thread in most
 *  paths, but a parent-channel delete doesn't always, so this is the belt-and-suspenders
 *  sweep). Cheap: one filtered scan over the (usually tiny) thread-tab set. */
export function onChannelDelete(payload: any): void {
    const id = payload?.channel?.id ?? payload?.id;
    if (!id) return;
    const parentId = String(id);
    for (const w of allThreadTabs()) {
        if (w.ownerChannelId === parentId) closeThreadTabEverywhere(String(w.content.threadChannelId));
    }
}
