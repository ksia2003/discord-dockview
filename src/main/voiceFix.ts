/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// WebRTC IP-handling policy for voice. On a VPN (Tailscale and friends) Chromium
// can bind voice to a non-default-route interface, and the call then hangs on
// "DTLS Connecting". Restricting selection to the default public/private
// interfaces lets it reach a working candidate. The persisted Vesktop setting is
// read before any Discord contents are created, defaults ON (opt-out), and is
// updated by the renderer's Performance panel on every flip. The hook applies it
// to Discord's own contents (main window + voice popouts), but never to the
// isolated web-browsing tab.

import { app, session, webContents } from "electron";

import { WEB_PARTITION } from "./constants";
import { Settings } from "./settings";

let voiceFixEnabled = Settings.store.voiceFixEnabled ?? true;
let initialized = false;

// The embedded browsing <webview> runs on this isolated session partition. Its voice
// policy is none of our business — it hosts arbitrary third-party pages, not Discord —
// so we skip it and only touch Discord's own contents.
function isBrowsingWebview(wc: Electron.WebContents): boolean {
    try {
        return wc.session === session.fromPartition(WEB_PARTITION);
    } catch {
        return false;
    }
}

function apply(wc: Electron.WebContents) {
    if (wc.isDestroyed()) return;
    if (isBrowsingWebview(wc)) return;
    wc.setWebRTCIPHandlingPolicy(voiceFixEnabled ? "default_public_and_private_interfaces" : "default");
}

export function setVoiceFixEnabled(enabled: boolean) {
    voiceFixEnabled = enabled;
    Settings.store.voiceFixEnabled = enabled;
    for (const wc of webContents.getAllWebContents()) {
        try {
            apply(wc);
        } catch {
            // a popout/webview mid-teardown throws "Object has been destroyed" — skip it
        }
    }
}

export function initVoiceFix() {
    if (initialized) return;
    initialized = true;

    app.on("web-contents-created", (_, wc) => apply(wc));

    // This is normally empty because the hook is registered before the first
    // window is created, but applying to existing contents makes initialization
    // safe if startup ordering changes or this entry point is called again.
    for (const wc of webContents.getAllWebContents()) {
        try {
            apply(wc);
        } catch {
            // A contents object may be destroyed while startup is enumerating it.
        }
    }
}
