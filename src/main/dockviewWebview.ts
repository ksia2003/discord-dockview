/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, BrowserWindowConstructorOptions, session, shell, WebContents } from "electron";

/** Persistent but Discord-isolated storage used only by DockView's explicit web tabs. */
export const DOCKVIEW_WEB_PARTITION = "persist:dockview-web";

/** Electron disables <webview> by default. This is the one constructor seam needed
 * by DockView's web viewer; all upstream security defaults remain unchanged. */
export function enableDockViewWebviews(options: BrowserWindowConstructorOptions): void {
    options.webPreferences!.webviewTag = true;
}

function isWebUrl(raw: string): boolean {
    try {
        const { protocol } = new URL(raw);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

function secureGuest(guest: WebContents): void {
    guest.setWindowOpenHandler(({ url }) => {
        if (isWebUrl(url)) void shell.openExternal(url);
        return { action: "deny" };
    });

    guest.on("will-navigate", event => {
        const { url } = event;
        if (!isWebUrl(url)) event.preventDefault();
    });

    guest.on("will-redirect", event => {
        const { url } = event;
        if (!isWebUrl(url)) event.preventDefault();
    });
}

let partitionSecurityInstalled = false;

function installPartitionSecurity(): void {
    if (partitionSecurityInstalled) return;
    partitionSecurityInstalled = true;

    const isolatedSession = session.fromPartition(DOCKVIEW_WEB_PARTITION);
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolatedSession.on("will-download", (event, item) => {
        const url = item.getURL();
        try {
            item.cancel();
        } catch {
            /* already gone */
        }
        event.preventDefault();
        if (isWebUrl(url)) void shell.openExternal(url);
    });
}

/** Enforce the guest boundary in main, independently of renderer-controlled
 * attributes. Only DockView's exact partition and HTTP(S) pages may attach. */
export function installDockViewWebviewSecurity(win: BrowserWindow): void {
    installPartitionSecurity();

    win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
        if (params.partition !== DOCKVIEW_WEB_PARTITION || !isWebUrl(params.src)) {
            event.preventDefault();
            return;
        }

        delete (webPreferences as Record<string, unknown>).preload;
        webPreferences.nodeIntegration = false;
        webPreferences.nodeIntegrationInSubFrames = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.webSecurity = true;
        webPreferences.allowRunningInsecureContent = false;

        const attributes = params as Record<string, unknown>;
        delete attributes.preload;
        delete attributes.nodeintegration;
        delete attributes.nodeintegrationinsubframes;
        delete attributes.disablewebsecurity;
        delete attributes.allowrunninginsecurecontent;
    });

    win.webContents.on("did-attach-webview", (_event, guest) => secureGuest(guest));
}
