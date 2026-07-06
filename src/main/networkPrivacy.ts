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

// Known tracker/telemetry hosts, matched against the request URL's HOSTNAME only
// (never a raw substring of the whole URL — that over-blocked accounts.google.com,
// spclient.wg.spotify.com, and any Discord path containing "stats"). A request is
// cancelled when its host equals one of these or is a subdomain of it. The list is
// deliberately narrow: dedicated analytics/error-reporting/ad domains, nothing a
// first-party service (Discord, Google OAuth, Spotify presence) actually needs.
const TRACKER_HOSTS = [
    "sentry.io",
    "ingest.sentry.io",
    "google-analytics.com",
    "analytics.google.com",
    "ssl.google-analytics.com",
    "googletagmanager.com",
    "doubleclick.net",
    "stats.g.doubleclick.net",
    "googlesyndication.com",
    "pagead2.googlesyndication.com",
    "googleadservices.com",
    "adservice.google.com",
    "scorecardresearch.com",
    "mixpanel.com",
    "segment.io",
    "amplitude.com",
    "branch.io",
    "app-measurement.com",
    "crashlytics.com"
];

function isTrackerHost(host: string): boolean {
    const h = host.toLowerCase();
    return TRACKER_HOSTS.some(d => h === d || h.endsWith("." + d));
}

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

        let host: string;
        try {
            host = new URL(details.url).hostname;
        } catch {
            return callback({ cancel: false });
        }

        callback({ cancel: isTrackerHost(host) });
    });
}

export interface ProxyConfig {
    enabled: boolean;
    rules: string;
    bypass: string;
}

// Apply proxy settings to the default session. Disabled/empty/whitespace rules mean
// a direct connection. Called once at startup with the renderer's persisted config
// and again whenever the Privacy panel pushes a change. A malformed rules string must
// not brick the session, so a failed setProxy falls back to a direct connection.
export async function applyProxy(config: ProxyConfig) {
    const rules = config.rules?.trim();
    if (!config.enabled || !rules) {
        return session.defaultSession.setProxy({ mode: "direct" });
    }

    try {
        await session.defaultSession.setProxy({
            proxyRules: rules,
            proxyBypassRules: config.bypass?.trim() || undefined
        });
    } catch {
        await session.defaultSession.setProxy({ mode: "direct" });
    }
}
