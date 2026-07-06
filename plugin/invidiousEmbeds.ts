/*
 * DockView — Invidious embed rewriting (Privacy page).
 * ---------------------------------------------------------------------------
 * When on, YouTube embeds that render inside Discord are pointed at an Invidious
 * instance (a privacy frontend) instead of youtube.com, so Google never receives
 * the request that a YT embed would otherwise make from your client. Opt-in, off
 * by default.
 *
 * The rewrite is a Vencord code patch (see the `patches` entry in index.tsx). The
 * patch targets Discord's minified embed builder and hands the video src through
 * rewriteEmbedSrc() at RENDER time — so the setting is read live (a flip takes
 * effect on the next embed, no reload) and, when the feature is off, the src comes
 * back untouched. Because it targets minified internals, it's inherently version-
 * fragile and can break on a Discord update; that's why it defaults off.
 *
 * No module-top webpack/React access here — settings.store is Vencord's own store
 * and the function only runs when the patched embed builder calls it.
 */

import { settings } from "./settings";

// Only youtube.com embeds are rewritten. The value replaces the origin, so the
// path/query the builder already produced is preserved.
const YT_EMBED = "https://www.youtube.com/embed/";

// Local playback params Invidious understands (mirrors GoofCord): keep the
// player in the same "click to play" spirit Discord already uses. Appended only
// when we actually redirect to an Invidious instance.
const INVIDIOUS_PARAMS = "?autoplay=0&player_style=youtube&local=true";

/** Read the configured instance as a validated http(s) origin (scheme + host, no trailing
 *  slash), or "" if the feature is off / no instance is set / the value isn't a well-formed
 *  http(s) URL. A malformed setting (javascript:, a bare host, junk) yields "" so the caller
 *  leaves the embed on youtube.com instead of concatenating an unusable/hostile src. */
function activeInstance(): string {
    if (settings.store.invidiousEmbeds !== true) return "";
    const raw = (settings.store.invidiousInstance ?? "").trim();
    if (!raw) return "";
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return "";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (!u.hostname) return "";
    // Rebuild from the parsed origin + path so only a clean scheme://host[/path] survives
    // (drops any query/hash/credentials), trailing slash stripped as before.
    return (u.origin + u.pathname).replace(/\/+$/, "");
}

/**
 * Called by the patched embed builder with the video src it was about to use.
 * Returns the same string untouched unless the feature is on AND the src is a
 * youtube.com embed, in which case the origin is swapped for the configured
 * Invidious instance. Fails safe: any non-string, or anything thrown, yields the
 * original value so a broken setting never blanks an embed.
 */
export function rewriteEmbedSrc(src: unknown): unknown {
    if (typeof src !== "string") return src;
    try {
        const instance = activeInstance();
        if (!instance || !src.startsWith(YT_EMBED)) return src;
        return instance + "/embed/" + src.slice(YT_EMBED.length) + INVIDIOUS_PARAMS;
    } catch {
        return src;
    }
}

/** True when the feature is armed (on + a non-empty instance). Used by the debug
 *  surface so the rig can assert the live state without poking the store shape. */
export function invidiousEmbedsActive(): boolean {
    return activeInstance() !== "";
}
