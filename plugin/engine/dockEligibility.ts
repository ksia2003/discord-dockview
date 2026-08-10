/*
 * Pure ownership gates shared by the chat event handlers and Dock chrome.
 *
 * The DOM-facing code supplies the facts it observed (an actual Discord attachment
 * marker, the current message/channel, and the live settings gates). Keeping the
 * decision itself here makes it testable without booting Discord's webpack runtime and
 * prevents the click and context-menu paths from growing different rules.
 */

import type { ContentType } from "./types";

export interface DockFileGate {
    type: ContentType;
    categoryEnabled: boolean;
    decoderEnabled: boolean;
}

/** A recognised, enabled file is eligible for an explicit Dock open. Web tabs and
 * thread tabs are not attachment files, and unknown types stay with Discord. */
export function isDockFileEligible(gate: DockFileGate): boolean {
    return gate.type !== "unknown"
        && gate.type !== "web"
        && gate.type !== "thread"
        && gate.categoryEnabled
        && gate.decoderEnabled;
}

const DECODER_KEY_BY_TYPE: Partial<Record<ContentType, string>> = {
    model3d: "three",
    postscript: "ghostscript",
    dicom: "dicom-parser"
};

const DECODER_KEY_BY_EXTENSION: Record<string, string> = {
    psd: "ag-psd",
    jxl: "jxl"
};

// Keep this exact-host allowlist aligned with native.ts's attachment converter. A
// path that merely looks like `/attachments/...` on an arbitrary host is not Discord
// content and must not become Dock-owned.
const DISCORD_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** Return the optional heavy decoder for a routed file. This is deliberately keyed by
 * the routed type first, then by extension for formats that share `rasterimage`.
 * Keeping this map here means chip clicks and context-menu actions cannot disagree. */
export function decoderKeyForFile(type: ContentType, urlOrName?: string | null): string | null {
    const byType = DECODER_KEY_BY_TYPE[type];
    if (byType) return byType;
    if (!urlOrName) return null;

    let path = urlOrName;
    try {
        path = new URL(urlOrName, "https://dockview.invalid").pathname;
    } catch {
        /* keep the raw filename for the fallback probe */
    }
    const file = path.split("/").pop() || "";
    const match = /\.([a-z0-9]+)(?:$|[?#])/i.exec(file)
        ?? /\.([a-z0-9]+)(?:$|[?#])/i.exec(urlOrName);
    return match ? DECODER_KEY_BY_EXTENSION[match[1].toLowerCase()] ?? null : null;
}

/** Discord-hosted attachment URL, rather than an arbitrary link that happens to be
 * inside a message. The numeric channel/message path is the stable attachment shape
 * used by cdn.discordapp.com and media.discordapp.net. */
export function isDiscordAttachmentUrl(raw: string | null | undefined): boolean {
    if (!raw) return false;
    try {
        const url = new URL(raw);
        return url.protocol === "https:"
            && DISCORD_ATTACHMENT_HOSTS.has(url.hostname)
            && /\/attachments\/\d+\/\d+(?:\/|$)/.test(url.pathname);
    } catch {
        return false;
    }
}

export interface AttachmentSurfaceFacts {
    attachmentMarker: boolean;
    attachmentUrl: string | null | undefined;
    messageChannelId: string | null | undefined;
    /** The parent/main channel currently selected by Discord. */
    activeSurfaceChannelIds: readonly string[];
    /** Set only when the target is inside the visible DockView thread portal. */
    portalThreadId?: string | null;
    /** Set only for a result inside DockView's resident SearchResults surface. */
    searchResultSurface?: boolean;
    searchResultScopeId?: string | null;
    activeSearchScopeId?: string | null;
    searchResultActive?: boolean;
    /** Guild identities used by the Search exception; normal message surfaces do not
     * need these because activeSurfaceChannelIds already binds them. */
    messageGuildId?: string | null;
    activeGuildId?: string | null;
    searchSurface?: boolean;
    homeSurface?: boolean;
    explicitDownload?: boolean;
}

/** True only for an actual attachment/inline-media surface in the currently viewed
 * channel or thread. A plain anchor, search result, home surface, or save control is
 * intentionally outside DockView's event ownership. */
export function isCurrentAttachmentSurface(facts: AttachmentSurfaceFacts): boolean {
    const messageBelongsToSurface = facts.portalThreadId != null
        ? facts.messageChannelId === facts.portalThreadId
        : facts.messageChannelId != null && facts.activeSurfaceChannelIds.includes(facts.messageChannelId);
    const activeCurrentGuildSearchResult = facts.searchResultSurface === true
        && facts.searchResultActive === true
        && facts.searchResultScopeId != null
        && facts.searchResultScopeId === facts.activeSearchScopeId
        && facts.messageGuildId != null
        && facts.messageGuildId === facts.activeGuildId;
    const ordinaryCurrentMessage = messageBelongsToSurface
        && facts.searchResultSurface !== true
        && facts.searchSurface !== true
        && facts.homeSurface !== true;
    return facts.attachmentMarker
        && isDiscordAttachmentUrl(facts.attachmentUrl)
        && facts.messageChannelId != null
        && facts.explicitDownload !== true
        && (ordinaryCurrentMessage || activeCurrentGuildSearchResult);
}

/** Combined fixture seam for tests and callers that already have both halves of the
 * decision. Production handlers may use the two named predicates separately when they
 * need to carry the source message metadata forward. */
export function canInterceptDockAttachment(input: {
    surface: AttachmentSurfaceFacts;
    gate: DockFileGate;
}): boolean {
    return isCurrentAttachmentSurface(input.surface) && isDockFileEligible(input.gate);
}

/** File toolbar actions never belong to web or thread/context surfaces. */
export function hasFileActionSurface(type: ContentType): boolean {
    return type !== "web" && type !== "thread";
}

/** A visible thread portal binds its native message rows to that row's channel id.
 * Never infer a binding from arbitrary child/thread channels outside this surface. */
export function portalThreadIdFromSurface(
    visiblePortal: boolean,
    messageChannelId: string | null | undefined
): string | null {
    return visiblePortal ? messageChannelId ?? null : null;
}

/** Inline capture is limited to formats Discord already renders as a real image. Exotic
 * raster files keep their decoder route in the native attachment flow; they must not be
 * retyped to `image` merely because a preview happens to contain an <img>. */
export function inlineImageTypeFor(type: ContentType): "image" | null {
    return type === "image" ? "image" : null;
}
