/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, shell } from "electron";
import { DISCORD_HOSTNAMES } from "main/constants";
import { IpcEvents } from "shared/IpcEvents";

import { Settings } from "../settings";
import { createOrFocusPopup, setupPopout } from "./popout";
import { execSteamURL, isDeckGameMode, steamOpenURL } from "./steamOS";

export function handleExternalUrl(url: string, protocol?: string): { action: "deny" | "allow" } {
    if (protocol == null) {
        try {
            protocol = new URL(url).protocol;
        } catch {
            return { action: "deny" };
        }
    }

    switch (protocol) {
        case "http:":
        case "https:":
            if (Settings.store.openLinksWithElectron) {
                return { action: "allow" };
            }
        // eslint-disable-next-line no-fallthrough
        case "mailto:":
        case "spotify:":
            if (isDeckGameMode) {
                steamOpenURL(url);
            } else {
                shell.openExternal(url);
            }
            break;
        case "steam:":
            if (isDeckGameMode) {
                execSteamURL(url);
            } else {
                shell.openExternal(url);
            }
            break;
    }

    return { action: "deny" };
}

export function makeLinksOpenExternally(win: BrowserWindow) {
    win.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
        try {
            var { protocol, hostname, pathname, searchParams } = new URL(url);
        } catch {
            return { action: "deny" };
        }

        if (frameName.startsWith("DISCORD_") && pathname === "/popout" && DISCORD_HOSTNAMES.includes(hostname)) {
            return createOrFocusPopup(frameName, features);
        }

        if (url === "about:blank") return { action: "allow" };

        // Drop the static temp page Discord web loads for the connections popout
        if (frameName === "authorize" && searchParams.get("loading") === "true") return { action: "deny" };

        // A user clicked an external web link -> open it in the DockView web tab instead of
        // the OS browser. This is the ONE place the app decides "open this url externally",
        // so internal Discord navigation (its router) and downloads never reach here — no
        // guessing at raw clicks. Kept conservative: only a plain content-link open (no
        // window features). A sized popup — an OAuth / connection auth window — carries
        // features and falls through to the browser, so those flows keep a real session.
        if ((protocol === "http:" || protocol === "https:") && !DISCORD_HOSTNAMES.includes(hostname) && !features) {
            win.webContents.send(IpcEvents.WEB_TAB_OPEN, url);
            return { action: "deny" };
        }

        return handleExternalUrl(url, protocol);
    });

    win.webContents.on("did-create-window", (win, { frameName }) => {
        if (frameName.startsWith("DISCORD_")) setupPopout(win, frameName);
    });
}
