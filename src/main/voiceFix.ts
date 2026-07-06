/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// WebRTC IP-handling policy for voice. On a VPN (Tailscale and friends) Chromium
// happily binds voice to the VPN interface, and the call then hangs on
// "DTLS Connecting". Forcing the policy back to public+private interfaces lets it
// reach a working candidate. This is opt-in (default OFF): the renderer's
// Performance panel pushes the flag on start and on every flip over IPC, and the
// hook below applies it to Discord's own contents (main window + voice popouts) so
// calls are covered — but never to the isolated web-browsing tab.

import { app, session, webContents } from "electron";

import { WEB_PARTITION } from "./constants";

let voiceFixEnabled = false;

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
    if (isBrowsingWebview(wc)) return;
    wc.setWebRTCIPHandlingPolicy(voiceFixEnabled ? "default_public_and_private_interfaces" : "default");
}

export function setVoiceFixEnabled(enabled: boolean) {
    voiceFixEnabled = enabled;
    for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        try {
            apply(wc);
        } catch {
            // a popout/webview mid-teardown throws "Object has been destroyed" — skip it
        }
    }
}

export function initVoiceFix() {
    app.on("web-contents-created", (_, wc) => apply(wc));
}
