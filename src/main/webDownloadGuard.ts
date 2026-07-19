/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Download handling for the dock's embedded web-browsing <webview>.
 *
 * The <webview> runs on an isolated session partition (WEB_PARTITION) and is a VIEWER,
 * not a downloader — a page opened in it must render, never pull a file to disk through
 * that guest session or pop a save dialog. Two cases fire a download here:
 *
 *   1. A url that was never a page at all (Content-Disposition: attachment, or a 302 to
 *      a download). The dock should never have kept it as a web tab; we tell the renderer
 *      to close that tab (below) so it can't persist, re-show the dock, or re-navigate.
 *   2. A genuine download link the user clicked on a REAL page open in the pane. Silently
 *      dropping it would make the file vanish. We hand it to the OS browser instead, so
 *      the user still gets the file.
 *
 * Both cases: cancel the guest-session download (nothing lands in this cookie-less
 * partition), hand the url to the external browser, and signal the renderer with the
 * guest webContents id — the renderer closes the web tab IFF that webview's whole life
 * was this one download (case 1); a download from a loaded page (case 2) leaves the tab
 * alone (the renderer keys the close on the tab never having shown a page). Discord's OWN
 * downloads run on the default session and never reach this handler.
 */

import { BrowserWindow, session, shell } from "electron";

import { IpcEvents } from "../shared/IpcEvents";
import { WEB_PARTITION } from "./constants";

let installed = false;

export function initWebDownloadGuard(win: BrowserWindow) {
    if (installed) return;
    installed = true;
    // fromPartition creates the session if it doesn't exist yet, so the handler is armed
    // before the first web tab ever mounts its <webview>.
    const ses = session.fromPartition(WEB_PARTITION);
    ses.on("will-download", (event, item, webContents) => {
        const url = item.getURL();

        // The guest webContents id lets the renderer find the web tab that owns this
        // <webview> (it reads getWebContentsId() off the element to match). Read it before
        // we cancel, while the item/webContents are still live.
        const guestId = webContents?.id ?? null;

        // Never save into the browsing pane's session — cancel the guest download.
        try {
            item.cancel();
        } catch {
            /* item already gone — nothing to cancel */
        }
        event.preventDefault();

        // Hand the file to the OS browser so a real download the user asked for still
        // reaches them (it just doesn't land in the cookie-less guest session).
        if (/^https?:\/\//i.test(url)) {
            shell.openExternal(url).catch(() => {
                /* user declined / no handler */
            });
        }

        // Tell the renderer which webview this fired on; it decides whether the tab was
        // only ever a download (auto-close) or a click on a loaded page (keep).
        if (guestId != null && !win.isDestroyed()) {
            win.webContents.send(IpcEvents.WEB_TAB_DOWNLOAD, guestId);
        }
    });
}
