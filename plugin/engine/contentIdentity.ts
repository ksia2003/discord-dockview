/*
 * The single source of truth for DockView content identity.
 *
 * A cache/dedup identity includes the routing type. Discord CDN attachment URLs
 * rotate only their ex/is/hm signature parameters, so those three parameters are
 * ignored for Discord media while every other query parameter and the fragment
 * remain part of the identity. Ordinary web URLs therefore keep normal URL
 * identity semantics, including query strings and fragments.
 */

import type { ContentType } from "./types";

const DISCORD_MEDIA_HOSTS = [
    "cdn.discordapp.com",
    "cdn.discordapp.net",
    "media.discordapp.net",
    "discordapp.net"
];

const ROTATING_SIGNATURE_PARAMS = ["ex", "is", "hm"];

function isDiscordMediaHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return DISCORD_MEDIA_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

/** Return the URL component used for identity while preserving meaningful URL data. */
export function canonicalSourceUrl(url: string, type: ContentType | string = "image"): string {
    try {
        const base = typeof location === "undefined" ? "https://dockview.invalid/" : location.href;
        const parsed = new URL(url, base);
        // Embedded web tabs own normal URL identity. A Discord CDN URL routed as
        // `web` is not an attachment descriptor and must retain every signature
        // query/fragment byte-for-byte.
        if (type !== "web" && isDiscordMediaHost(parsed.hostname)) {
            for (const param of ROTATING_SIGNATURE_PARAMS) parsed.searchParams.delete(param);
        }
        return parsed.toString();
    } catch {
        // Non-URL descriptors (only used by a few tests/legacy callers) retain their
        // exact value instead of accidentally collapsing two opaque sources.
        return url;
    }
}

/** The routing-aware identity shared by tab deduplication and the content cache. */
export function contentIdentity(url: string | null, type: ContentType | string): string | null {
    return url ? `${type}|${canonicalSourceUrl(url, type)}` : null;
}
