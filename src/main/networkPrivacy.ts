/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Network-privacy controls that live on the default session: a tracker/telemetry
// request firewall and HTTP proxy support. Both attach once at startup and are
// driven live from the renderer's Privacy settings over IPC — nothing here keeps
// its own persisted store, it only holds the currently-applied config.

import { session } from "electron";

// URL patterns hard-cancelled outright (onBeforeRequest). Telemetry/science
// endpoints, error reporting, bad-domain lists, and YouTube's logging beacons.
const BLOCKLIST = [
    "https://*/api/v*/science",
    "https://*/api/v*/applications/detectable",
    "https://*/api/v*/auth/location-metadata",
    "https://*/api/v*/premium-marketing",
    "https://*/api/v*/scheduled-maintenances/upcoming.json",
    "https://*/error-reporting-proxy/*",
    "https://cdn.discordapp.com/bad-domains/*",
    "https://www.youtube.com/youtubei/v*/next?*",
    "https://www.youtube.com/s/desktop/*",
    "https://www.youtube.com/youtubei/v*/log_event?*"
];

// Substrings that flag an xhr for blocking when present in its URL. Catches a
// broad class of tracker/analytics hosts the URL blocklist above would miss.
const BLOCKED_STRINGS = ["sentry", "google", "tracking", "stats", "\\.spotify", "pagead", "analytics", "doubleclick"];

// Whitelist: any URL containing one of these is never blocked, even if a blocked
// string matches. This is what keeps the string matcher from breaking normal
// traffic (attachments, media playback, Google Fonts/APIs, Discord's own assets).
const ALLOWED_STRINGS = [
    "videoplayback",
    "discord-attachments",
    "googleapis",
    "search",
    "api.spotify",
    "discord.com/assets/sentry."
];

const blockRegex = new RegExp(BLOCKED_STRINGS.join("|"), "i");
const allowRegex = new RegExp(ALLOWED_STRINGS.join("|"), "i");

// Live gate for the firewall. Default ON so telemetry is blocked from the first
// request, before the renderer has connected to flip anything. The handlers stay
// registered for the process lifetime; this flag decides whether they cancel.
let firewallEnabled = true;

export function setFirewallEnabled(enabled: boolean) {
    firewallEnabled = enabled;
}

export function initFirewall() {
    session.defaultSession.webRequest.onBeforeRequest({ urls: BLOCKLIST }, (_details, callback) => {
        callback({ cancel: firewallEnabled });
    });

    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
        if (!firewallEnabled || details.resourceType !== "xhr") return callback({ cancel: false });

        if (blockRegex.test(details.url) && !allowRegex.test(details.url)) {
            return callback({ cancel: true });
        }

        callback({ cancel: false });
    });
}

export interface ProxyConfig {
    enabled: boolean;
    rules: string;
    bypass: string;
}

// Apply proxy settings to the default session. Disabled/empty rules mean a direct
// connection. Called once at startup with the renderer's persisted config and
// again whenever the Privacy panel pushes a change.
export function applyProxy(config: ProxyConfig) {
    if (!config.enabled || !config.rules) {
        return session.defaultSession.setProxy({ mode: "direct" });
    }

    return session.defaultSession.setProxy({
        proxyRules: config.rules,
        proxyBypassRules: config.bypass || undefined
    });
}
