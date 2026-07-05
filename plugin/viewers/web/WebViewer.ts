/*
 * The WEB viewer — the Viewer contract over a web page opened as a dock tab.
 *
 * A web page rides the SAME tab model as a file (channel-scoped, accumulates, pin =
 * global, dedup on url, session-only) with ZERO new lifecycle: the engine treats a
 * "web" content type like any other viewer. There is nothing to fetch or decode in the
 * plugin (the page is rendered by an isolated <webview> on the main side, wired
 * separately), so load() just validates the url and clears loading — the simplest
 * loader, like the media viewer. The current Body is a placeholder card; the real
 * in-dock page render is a main-side change.
 */

import type { CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext } from "../../engine/types";
import { WebBody } from "./WebBody";

/** WEB loader: nothing to fetch in the plugin — the page url is handed to the body,
 *  which stands in with a placeholder until the in-dock <webview> render lands. */
function load(opts: LoadOpts, _token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = "No page URL";
        return;
    }
    if (entry) { entry.loading = false; entry.error = null; }
    ctx.content.loading = false;
    ctx.content.error = null;
}

export const WebViewer: Viewer = {
    type: "web",
    load,
    createState: () => ({}),
    resetState: () => { /* no view-state (the placeholder has nothing to remember) */ },
    snapshot: () => { /* nothing parked on the cache entry */ },
    restore: () => { /* nothing to restore */ },
    Body: WebBody
    // No capabilities: dedup + tab lifecycle come from the engine, not a capability flag.
};
