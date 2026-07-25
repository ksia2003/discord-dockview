/*
 * Voice-channel text-chat acquisition.
 *
 * Discord only mounts a voice channel's text chat after "View Chat" opens the native
 * call-chat sidebar. DockView keeps that chat permanently available, so we briefly open
 * the native surface while a CSS guard hides it, capture the INNER message/composer
 * component by its exact props signature, then restore the native store state.
 *
 * Capturing the inner {channel,guild,chatInputType} component is load-bearing: the outer
 * call-chat component portals into Discord's ChannelCallChatLayer, while the full Channel
 * view also contains the call/screen-share surface. The inner component alone renders the
 * real message list + composer without duplicating the call.
 */

import { findByProps } from "@vencord/types/webpack";

import { dispatchVoiceChatOpen } from "./nativePanels";

let voiceChatType: any = null;
let voiceChatBaseProps: any = null;
let voiceChatProviderStack: Array<{ type: any; value: any }> | null = null;
let primeInFlight: Promise<boolean> | null = null;

const CONTEXT_PROVIDER_TAG = 10;
const PRIME_CLASS = "dockview-prime-voice-chat";

function fiberOf(el: Element | null): any {
    if (!el) return null;
    for (const key in el) {
        if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
            return (el as any)[key];
        }
    }
    return null;
}

function voiceChatAnchor(channelId: string): Element | null {
    const candidates = document.querySelectorAll('section[class*="chatContent"], div[class*="chatContent"]');
    for (const el of Array.from(candidates)) {
        if (el.closest("#dockview-root, .dockview-thread-portal, .dockview-voice-chat-portal")) continue;
        let f = fiberOf(el);
        let hops = 0;
        while (f && hops++ < 35) {
            const p = f.memoizedProps;
            if (p?.channel?.id === channelId) return el;
            f = f.return;
        }
    }
    return null;
}

function keysAre(keys: string[], want: string[]): boolean {
    return keys.length === want.length && want.every(key => keys.includes(key));
}

function captureProviders(anchor: Element): void {
    const found: Array<{ type: any; value: any }> = [];
    let f = fiberOf(anchor)?.return;
    let hops = 0;
    while (f && hops++ < 400) {
        if (f.tag === CONTEXT_PROVIDER_TAG && f.type) {
            found.push({ type: f.type, value: f.memoizedProps?.value });
        }
        f = f.return;
    }
    if (found.length) voiceChatProviderStack = found;
}

/** Capture the exact inner voice-chat component for `channelId`, if it is mounted. */
export function captureVoiceChat(channelId: string): boolean {
    if (!channelId) return false;
    const anchor = voiceChatAnchor(channelId);
    const fiber = fiberOf(anchor);
    if (!anchor || !fiber) return voiceChatType != null;

    let f = fiber;
    let hops = 0;
    while (f && hops++ < 45) {
        const props = f.memoizedProps;
        const type = f.type;
        if (
            typeof type === "function"
            && props
            && typeof props === "object"
            && keysAre(Object.keys(props), ["channel", "guild", "chatInputType"])
            && props.channel?.id === channelId
        ) {
            voiceChatType = type;
            voiceChatBaseProps = props;
            captureProviders(anchor);
            return true;
        }
        f = f.return;
    }
    return voiceChatType != null;
}

function isNativeVoiceChatOpen(channelId: string): boolean {
    try {
        const store = (findByProps as any)?.("getChatOpen", "getParticipantsOpen");
        return !!store?.getChatOpen?.(channelId);
    } catch {
        return false;
    }
}

/** Hidden one-shot mount used only when the component has not been captured yet. */
export function primeVoiceChat(channelId: string): Promise<boolean> {
    if (voiceChatType) return Promise.resolve(true);
    if (captureVoiceChat(channelId)) return Promise.resolve(true);
    if (primeInFlight) return primeInFlight;

    primeInFlight = new Promise(resolve => {
        const wasOpen = isNativeVoiceChatOpen(channelId);
        const raf = window.requestAnimationFrame || ((cb: FrameRequestCallback) => window.setTimeout(cb, 16));
        let tries = 0;

        document.documentElement.classList.add(PRIME_CLASS);
        if (!wasOpen) dispatchVoiceChatOpen(channelId, true);

        const finish = (ok: boolean) => {
            if (!wasOpen) dispatchVoiceChatOpen(channelId, false);
            document.documentElement.classList.remove(PRIME_CLASS);
            primeInFlight = null;
            resolve(ok);
        };
        const tick = () => {
            if (captureVoiceChat(channelId)) { finish(true); return; }
            if (++tries >= 30) { finish(false); return; }
            raf(tick);
        };
        raf(tick);
    });
    return primeInFlight;
}

export function getVoiceChatType(): any {
    return voiceChatType;
}

export function getVoiceChatProviderStack(): Array<{ type: any; value: any }> | null {
    return voiceChatProviderStack;
}

/** Rebuild props with live stores so channel/guild changes aren't frozen at capture time. */
export function buildVoiceChatProps(channelId: string): any {
    if (!voiceChatBaseProps || !channelId) return null;
    try {
        const channels = (findByProps as any)?.("getChannel", "hasChannel");
        const channel = channels?.getChannel?.(channelId);
        if (!channel?.guild_id) return null;
        const guilds = (findByProps as any)?.("getGuild", "getGuilds");
        const guild = guilds?.getGuild?.(channel.guild_id) ?? voiceChatBaseProps.guild;
        return { ...voiceChatBaseProps, channel, guild };
    } catch {
        return null;
    }
}

export function invalidateVoiceChatCapture(): void {
    voiceChatType = null;
    voiceChatBaseProps = null;
    voiceChatProviderStack = null;
    primeInFlight = null;
    try { document.documentElement.classList.remove(PRIME_CLASS); } catch { /* ignore */ }
}
