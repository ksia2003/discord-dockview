/*
 * The THREAD viewer — the Viewer contract over a Discord thread opened as a dock tab.
 *
 * A thread rides the SAME tab model as a file (channel-scoped, accumulates, dedup on the
 * thread id, session-only) with ZERO new lifecycle: the engine treats a "thread" content
 * type like any other viewer. There is nothing to fetch/decode in the plugin — the chat is
 * rendered by the captured channel-view component in the Body (like the web viewer's
 * <webview>, a live component, not a fetched file) — so load() just clears loading.
 *
 * A thread tab is opened by engine/threadTab.ts (openThreadTab), which sets
 * content.threadChannelId to the thread id and content.type to "thread"; the Body reads
 * that id, builds the chat props for the thread, and renders it.
 */

import type { CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext } from "../../engine/types";
import { ThreadBody } from "./ThreadBody";

/** THREAD loader: nothing to fetch — the thread's chat is rendered live by the captured
 *  component in the Body. Just settle a non-loading state so the Body renders immediately. */
function load(_opts: LoadOpts, _token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    if (entry) { entry.loading = false; entry.error = null; }
    ctx.content.loading = false;
    ctx.content.error = null;
}

export const ThreadViewer: Viewer = {
    type: "thread",
    load,
    createState: () => ({}),
    resetState: () => { /* no view-state (the live chat owns its own scroll/composer) */ },
    snapshot: () => { /* nothing parked on a cache entry (threads aren't cached) */ },
    restore: () => { /* nothing to restore */ },
    Body: ThreadBody
    // No HeaderControls: the thread chat carries its own header inside the captured
    // component; the dock's row-2 stays empty for a thread tab.
};
