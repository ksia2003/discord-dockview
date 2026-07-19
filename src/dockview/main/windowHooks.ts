/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { vencordSupportsSandboxing } from "main/utils/vencordLoader";
import { initWebDownloadGuard } from "main/webDownloadGuard";
import { IpcEvents } from "shared/IpcEvents";

export function applyDockViewWebPreferences(options: BrowserWindowConstructorOptions) {
    const webPreferences = options.webPreferences!;
    webPreferences.sandbox = vencordSupportsSandboxing();
    webPreferences.webviewTag = true;
}

export function installDockViewMainWindowHooks(win: BrowserWindow) {
    win.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
        delete (webPreferences as Record<string, unknown>).preload;
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        delete (params as Record<string, unknown>).nodeintegration;
        delete (params as Record<string, unknown>).nodeintegrationinsubframes;
    });

    initWebDownloadGuard(win);
}

export function openDockViewExternalWebTab(
    win: BrowserWindow,
    url: string,
    protocol: string,
    hostname: string,
    features: string,
    discordHostnames: readonly string[]
) {
    if ((protocol !== "http:" && protocol !== "https:") || discordHostnames.includes(hostname) || features)
        return false;

    win.webContents.send(IpcEvents.WEB_TAB_OPEN, url);
    return true;
}
