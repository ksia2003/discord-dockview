/*
 * The dock's embedded web-browsing <webview> runs on an isolated session partition
 * (WEB_PARTITION). That pane is a VIEWER, not a downloader — navigating it to a url that
 * responds with Content-Disposition: attachment (or any non-renderable body) must never
 * pull a file onto disk or pop a save dialog. Electron's default is to download such a
 * response through the guest's session, so a stray attachment/download url that ended up
 * as a web tab would fire a download on every mount (and re-fire on channel switch, since
 * the tab re-navigates when it remounts).
 *
 * We cancel every download that originates on this isolated session. Discord's OWN
 * downloads run on the default session and are untouched, so the native download button
 * keeps working exactly as before.
 */

import { session } from "electron";

import { WEB_PARTITION } from "./constants";

let installed = false;

export function initWebDownloadGuard() {
    if (installed) return;
    installed = true;
    // fromPartition creates the session if it doesn't exist yet, so the handler is armed
    // before the first web tab ever mounts its <webview>.
    const ses = session.fromPartition(WEB_PARTITION);
    ses.on("will-download", (event, item) => {
        // The browsing pane never saves to disk. Cancel so no file lands and no save
        // dialog appears; the tab just shows the page (or an honest load-failure card).
        try {
            item.cancel();
        } catch {
            /* item already gone — nothing to cancel */
        }
        event.preventDefault();
    });
}
