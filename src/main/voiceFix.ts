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
// hook below applies it to every web contents so voice popouts are covered too.

import { app, webContents } from "electron";

let voiceFixEnabled = false;

function apply(wc: Electron.WebContents) {
    wc.setWebRTCIPHandlingPolicy(voiceFixEnabled ? "default_public_and_private_interfaces" : "default");
}

export function setVoiceFixEnabled(enabled: boolean) {
    voiceFixEnabled = enabled;
    for (const wc of webContents.getAllWebContents()) apply(wc);
}

export function initVoiceFix() {
    app.on("web-contents-created", (_, wc) => apply(wc));
}
