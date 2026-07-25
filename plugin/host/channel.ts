/*
 * The current-channel resolver — a thin Discord-integration helper.
 *
 * Window ownership (transient binding), channel memory and channel-switch
 * handling all need "what channel am I looking at?". It reads Discord's selected-
 * channel store first and falls back to the URL, so it works even before the
 * store resolves. Pure read; no mount, no side effects — safe to call from the
 * engine. (The rest of host/ — mount, layout geometry, exclusivity — is Phase 2.)
 */

import { findByProps } from "@vencord/types/webpack";

/** Resolve the currently-selected channel id (store first, URL fallback). */
export function getCurrentChannelId(): string | null {
    try {
        const store = (findByProps as any)?.("getChannelId", "getLastSelectedChannelId");
        const id = store?.getChannelId?.() || store?.getLastSelectedChannelId?.();
        if (id) return String(id);
    } catch {
        /* fall through to URL */
    }
    const m = /\/channels\/[^/]+\/(\d+)/.exec(location.pathname);
    return m ? m[1] : null;
}

/** Resolve a channel without importing the heavier slot-capture module. */
export function getChannelById(channelId: string | null): any {
    if (!channelId) return null;
    try {
        const store = (findByProps as any)?.("getChannel", "hasChannel");
        return store?.getChannel?.(channelId) ?? null;
    } catch {
        return null;
    }
}

/** Regular guild voice channels (Discord channel type 2) own the permanent CHAT view.
 * Stage channels deliberately stay out until their different audience/composer semantics
 * are verified independently. */
export function isGuildVoiceChannel(channelId: string | null): boolean {
    const channel = getChannelById(channelId);
    return !!channel?.guild_id && channel.type === 2;
}
