/*
 * DockView — attachment embed (click-to-panel delegation).
 * ---------------------------------------------------------------------------
 * Panel-renderable attachments (the dock-handled file types) are NOT auto-
 * rendered inline. Discord shows them as its native attachment chip; clicking the
 * chip loads the file into the DockView panel via the engine's public load(). The
 * engine's content-type router (showContent → the registered viewer) picks the
 * renderer by extension; a handled type whose viewer isn't built yet lands on the
 * unsupported card (expected during the rewrite).
 *
 * ONE capture-phase document click listener (delegation) intercepts clicks on
 * panel-renderable chips and inline images and routes them to the panel, suppressing
 * the default download / lightbox. The explicit hover-bar download button keeps
 * native behaviour.
 *
 * SINGLE SOURCE OF TRUTH: which extensions are handled comes from
 * engine/detectType — `detectType({url})` returning anything other than "unknown"
 * means the dock has a route for it. We never re-list extensions here, so the chat-
 * side interception can't drift from what the panel actually renders.
 */

import { viewerEnabled } from "./engine/categoryMap";
import { decoderEnabledForFile } from "./engine/decoderModes";
import {
    inlineImageTypeFor, isCurrentAttachmentSurface, isDockFileEligible,
    portalThreadIdFromSurface
} from "./engine/dockEligibility";
import { detectType, IMG_EXT } from "./engine/detectType";
import type { ContentType, SourceImageContext } from "./engine/types";
import { load } from "./engine/load";
import { openExternalLink } from "./external/openExternal";
import { getChannelById, getCurrentChannelId } from "./host/channel";
import {
    getNativeSearchScopeId, isNativeSearchSurfaceActive
} from "./host/searchResults";
import { fullResImageUrl } from "./viewers/image/url";

/** The matched extension of a url's path, lowercased, or null (path-aware, the
 *  same probe detectType uses). */
function panelExt(url: string | null | undefined): string | null {
    if (!url) return null;
    let path = url;
    try {
        path = new URL(url, location.href).pathname;
    } catch {
        /* keep raw */
    }
    const m = /\.([a-z0-9]+)(?:$|\?|#)/i.exec(path.split("/").pop() || "");
    if (m) return m[1].toLowerCase();
    // fall back to a raw-url probe (covers a query/hash directly after the ext).
    const m2 = /\.([a-z0-9]+)(\?|#|$)/i.exec(url);
    return m2 ? m2[1].toLowerCase() : null;
}

/** Is this URL a file the dock panel can render AND is currently enabled to intercept?
 *  Decided by detectType (any recognised type ≠ "unknown" is dock-handled) THEN the
 *  live settings gate (viewerEnabled): the master switch + the file's category switch.
 *  A disabled category / master-off returns false, so the chip falls back to stock
 *  Discord (download / lightbox) — the gate sits in detection so it never half-renders. */
function isPanelUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    const type = detectType({ url });
    if (type === "unknown") return false;
    // A "web" url is not an attachment/file chip. Plain message links keep Vesktop's
    // normal click behavior and expose an explicit context-menu action in index.tsx.
    if (type === "web" || type === "audio" || type === "video") return false;
    return isDockFileEligible({
        type,
        categoryEnabled: viewerEnabled(type),
        decoderEnabled: decoderEnabledForFile(type, url)
    });
}

/** Derive the panel display name from the url. */
function nameFromUrl(url: string): string {
    let path = url;
    try {
        path = new URL(url, location.href).pathname;
    } catch {
        /* fall back to raw */
    }
    let base = path.split("/").pop() || "file";
    try {
        base = decodeURIComponent(base);
    } catch {
        /* keep raw */
    }
    if (/\.artifact$/i.test(base)) return base.replace(/\.artifact$/i, "") || "artifact";
    return base || "file";
}

/** A web tab's display name: the page HOST (e.g. "example.com"), which reads better in
 *  the tab strip than a long path-tail. Falls back to the raw url if it won't parse. */
function webNameFor(url: string): string {
    try {
        return new URL(url, location.href).host || url;
    } catch {
        return url;
    }
}

/**
 * Primary action: load the file into the DockView panel by URL. The engine's
 * router picks the renderer + fetches the url itself (bypassing the download
 * Content-Disposition). Falls back to opening the link externally only if load()
 * throws (panel mount refused — e.g. on the Discord home/friends page).
 */
function openInPanel(
    url: string,
    name: string,
    sourceMessage?: { channelId: string; messageId: string; } | null
) {
    try {
        load({ name, url, sourceMessage });
        return;
    } catch {
        /* panel mount failed somehow — fall back to opening the link */
    }
    openExternalLink(url);
}

const MESSAGE_SURFACE_SELECTOR = "[id^='chat-messages-'], [data-list-item-id*='chat-messages-']";
const ATTACHMENT_SURFACE_SELECTOR = [
    "[class*='attachment']",
    "[class*='Attachment']",
    "[class*='fileName']",
    "[class*='nonVisualMediaItem']",
    "[class*='nonMediaAttachment']",
    "[class*='visualMediaItem']",
    "[class*='imageWrapper']",
    "[class*='lazyImgContainer']",
    "[class*='wrapperAudio']",
    "[class*='message-attachment']",
    "[data-testid*='attachment']"
].join(", ");
const SEARCH_SURFACE_SELECTOR = [
    "[class*='searchResult']",
    "[class*='search-results']",
    "[class*='searchResults']",
    "[data-search-result]",
    "[data-list-id*='search']"
].join(", ");
const HOME_SURFACE_SELECTOR = [
    "[data-home-view]",
    "[data-list-id*='home']",
    "[class*='homePanel']",
    "[class*='friendsPage']"
].join(", ");

interface MessageSurface {
    node: HTMLElement;
    channelId: string;
    messageId: string;
    searchSurface: boolean;
    searchResultSurface: boolean;
    homeSurface: boolean;
}

function messageSurfaceFromTarget(target: EventTarget | null): MessageSurface | null {
    const source = target instanceof Element ? target : null;
    const node = source?.closest<HTMLElement>(MESSAGE_SURFACE_SELECTOR) || null;
    const raw = node?.id || node?.getAttribute("data-list-item-id") || "";
    const match = /chat-messages-(\d+)-(\d+)/.exec(raw);
    if (!node || !match) return null;
    const dockSearchBody = source?.closest<HTMLElement>(".dockview-search-results-body") || null;
    const searchSurface = !dockSearchBody && !!source?.closest(SEARCH_SURFACE_SELECTOR);
    const homeSurface = !!source?.closest(HOME_SURFACE_SELECTOR);
    return {
        node,
        channelId: match[1],
        messageId: match[2],
        searchSurface,
        searchResultSurface: !!dockSearchBody,
        homeSurface
    };
}

/** True only for a real Discord attachment chip/inline preview in the current channel
 * or thread. A supported extension by itself is not enough: ordinary message anchors,
 * search results, home surfaces, and arbitrary external URLs stay upstream. */
export function isDockAttachmentTarget(target: EventTarget | null, url: string | null | undefined): boolean {
    const source = target instanceof Element ? target : null;
    const message = messageSurfaceFromTarget(target);
    const marker = source?.closest(ATTACHMENT_SURFACE_SELECTOR) || null;
    if (!message || !marker || !message.node.contains(marker)) return false;
    const portal = source?.closest<HTMLElement>(".dockview-thread-portal") || null;
    if (portal && (portal.style.display === "none" || !portal.contains(message.node))) return false;
    // The portal's own native message tree is the binding evidence. Its message row
    // already carries the thread channel id, so do not depend on a synthetic dataset
    // attribute that Discord's portal renderer does not provide.
    const portalThreadId = portalThreadIdFromSurface(!!portal, message.channelId);
    const currentChannelId = getCurrentChannelId();
    const currentChannel = getChannelById(currentChannelId);
    const messageChannel = getChannelById(message.channelId);
    const searchBody = source?.closest<HTMLElement>(".dockview-search-results-body") || null;
    const searchScopeId = searchBody?.dataset.dockviewSearchScope ?? null;
    const activeSearch = searchScopeId != null
        && searchBody?.dataset.dockviewSearchActive === "true"
        && isNativeSearchSurfaceActive(searchScopeId, currentChannelId);
    return isCurrentAttachmentSurface({
        attachmentMarker: true,
        attachmentUrl: url,
        messageChannelId: message.channelId,
        activeSurfaceChannelIds: currentChannelId ? [currentChannelId] : [],
        portalThreadId,
        searchResultSurface: message.searchResultSurface,
        searchResultScopeId: searchScopeId,
        activeSearchScopeId: getNativeSearchScopeId(currentChannelId),
        searchResultActive: activeSearch,
        messageGuildId: messageChannel?.guild_id ? String(messageChannel.guild_id) : null,
        activeGuildId: currentChannel?.guild_id ? String(currentChannel.guild_id) : null,
        searchSurface: message.searchSurface,
        homeSurface: message.homeSurface,
        explicitDownload: isExplicitDownloadButton(target)
    });
}

export function sourceMessageFromTarget(target: EventTarget | null): { channelId: string; messageId: string; } | null {
    const message = messageSurfaceFromTarget(target);
    return message ? { channelId: message.channelId, messageId: message.messageId } : null;
}

/** Build a session-only bridge to Discord's own source-image context menu. We retain the
 * clicked element weakly, only when its React ancestry actually owns an onContextMenu
 * handler. A Dock image can then redispatch a right-click at the Dock coordinates and get
 * Discord's permission-aware menu without copying its actions. Virtualized/deleted source
 * messages naturally fall back because the weak target is gone or disconnected. */
export function sourceImageContextFromTarget(target: EventTarget | null): SourceImageContext | null {
    const source = target instanceof Element ? target : null;
    if (!source) return null;

    let cursor: Element | null = source;
    let hasHandler = false;
    for (let depth = 0; cursor && depth < 12; depth++, cursor = cursor.parentElement) {
        const propsKey = Object.keys(cursor).find(key => key.startsWith("__reactProps$"));
        const props = propsKey ? (cursor as any)[propsKey] : null;
        if (typeof props?.onContextMenu === "function") {
            hasHandler = true;
            break;
        }
        if (cursor.matches?.("[id^='chat-messages-'], [data-list-item-id*='chat-messages']")) break;
    }
    if (!hasHandler) return null;

    const ref = new WeakRef(source);
    return point => {
        const live = ref.deref();
        if (!live?.isConnected) return false;
        live.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            composed: true,
            button: 2,
            buttons: 2,
            clientX: point.clientX,
            clientY: point.clientY
        }));
        return true;
    };
}

// --- chip click delegation --------------------------------------------------

/** Is this node (or an ancestor up to the chip) an EXPLICIT download control — the
 *  hover-bar download button, the file-chip download icon, OR any anchor that carries
 *  the `download` HTML attribute (a save-to-disk intent, whatever the UI language)? A
 *  download click must ALWAYS pass through to Discord's native download; the dock only
 *  ever intercepts an OPEN/VIEW intent, never a save. */
function isExplicitDownloadButton(target: EventTarget | null): boolean {
    let el = target as HTMLElement | null;
    for (let i = 0; i < 8 && el; i++) {
        const cls = String(el.className || "");
        if (/hoverBarButton|hoverButtonGroup|downloadButton/i.test(cls)) return true;
        if (el.tagName === "A") {
            const a = el as HTMLAnchorElement;
            // The `download` HTML attribute IS the save-to-disk intent — an anchor that
            // asks the browser to download must never be pulled into the dock viewer.
            if (a.hasAttribute("download")) return true;
            // Match Discord's OWN localized download aria-label (not our copy) so
            // the native download button keeps working across UI languages.
            const label = (a.getAttribute("aria-label") || "").toLowerCase();
            if (/download|다운로드|télécharger|descargar/.test(label)) return true;
        }
        el = el.parentElement;
    }
    return false;
}

function resolvePanelClick(target: EventTarget | null): { url: string; anchor: HTMLAnchorElement | null; } | null {
    let el = target as HTMLElement | null;
    for (let i = 0; i < 12 && el; i++) {
        if (el.tagName === "A") {
            const a = el as HTMLAnchorElement;
            const url = a.href || a.getAttribute("href");
            if (isPanelUrl(url) && isDockAttachmentTarget(target, url)) {
                return { url: a.href || url!, anchor: a };
            }
        }
        el = el.parentElement;
    }
    el = target as HTMLElement | null;
    for (let i = 0; i < 12 && el; i++) {
        const cls = String(el.className || "");
        // Discord wraps a non-image attachment (incl. the inline code preview it
        // shows for .html/.md/code) in `nonVisualMediaItem`; the `fileName` div
        // matches first but holds no link, so DON'T break — keep climbing to the
        // container that actually carries the download <a>.
        if (/attachment|fileName|nonMediaAttachment|nonVisualMediaItem|wrapperAudio|message-attachment/i.test(cls)) {
            const anchors = el.querySelectorAll<HTMLAnchorElement>("a[href]");
            for (const a of Array.from(anchors)) {
                if (isPanelUrl(a.href) && isDockAttachmentTarget(target, a.href)) {
                    return { url: a.href, anchor: a };
                }
            }
        }
        el = el.parentElement;
    }
    return null;
}

// --- explicit web-tab action ------------------------------------------------

/** Open an HTTP(S) page as a DockView web tab. Ordinary clicks never call this;
 * the permanent entry point is the link context-menu item in index.tsx. */
export function openWebTab(url: string): void {
    try {
        load({ name: webNameFor(url), url, type: "web" });
    } catch {
        openExternalLink(url);
    }
}

// --- inline image interception ----------------------------------------------
// The full-resolution url transform lives in viewers/image/url.ts (the SINGLE
// source — design §5). embed.ts and the gallery both import it so the chat-side
// interception loads an image under the exact url the gallery indexes it by;
// keeping one copy means they can never drift.

/** Read the React fiber on/above `el` to find the attachment's original url. */
function fiberImageUrl(el: HTMLElement | null): string | null {
    if (!el) return null;
    const start = el.closest<HTMLElement>("[class*='imageWrapper'], [class*='lazyImgContainer']") || el;
    const key = Object.keys(start).find(
        k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    if (!key) return null;
    let fib: any = (start as any)[key];
    for (let hop = 0; fib && hop < 35; hop++) {
        const p = fib.memoizedProps;
        if (p && typeof p === "object") {
            if (typeof p.original === "string" && /https?:/.test(p.original)) return p.original;
            if (p.attachment && typeof p.attachment.url === "string") return p.attachment.url;
            if (p.item && p.item.originalItem && typeof p.item.originalItem.url === "string") return p.item.originalItem.url;
            if (typeof p.src === "string" && /\/attachments\//.test(p.src)) return p.src;
        }
        fib = fib.return;
    }
    return null;
}

/** True if `url`'s extension is one we render as an inline <img> in the dock. */
function isImageUrl(url: string): boolean {
    const ext = panelExt(url);
    return ext != null && IMG_EXT.has(ext);
}

/**
 * Resolve a click on an INLINE visual-media item to its url + dock content type, or
 * null if it isn't media we should intercept. Discord renders images AND videos in the
 * SAME imageWrapper/mosaic grid, so this also catches an inline video — which must
 * route to the VIDEO viewer, not the image one (and keep its RAW url: the full-res
 * image transform would mangle a media url). Images get the full-resolution url.
 */
/** Resolve the media url + dock type inside a visual-media wrapper (image or video).
 *  A <video> routes to the video viewer with its RAW url (the full-res image transform
 *  must never touch a media url); otherwise the image full-res path applies. */
function mediaFromContainer(wrapper: HTMLElement): { url: string; name: string; type: ContentType; } | null {
    // Native media controls own every left click. Opening audio/video in DockView is an
    // explicit context-menu action, never a capture-phase body interception.
    if (wrapper.querySelector("video, audio")) return null;
    const img = wrapper.querySelector("img");
    const url = fiberImageUrl(wrapper) || (img ? img.src : null);
    if (!url) return null;
    const t = detectType({ url });
    // An inline video/audio → gate on the Media category; anything else is an image →
    // gate on the Images category. A disabled category returns null so the click falls
    // through to Discord's native lightbox / player (no dock).
    if (t === "video" || t === "audio") return null;
    // Unknown and exotic raster attachment formats are not inline image captures. In
    // particular, do not turn a PSD/HEIC/JXL CDN preview into an `image` route: the
    // raster decoder must own its original type, so these clicks stay with Discord.
    const inlineType = inlineImageTypeFor(t);
    if (!inlineType || !isImageUrl(url)) return null;
    if (!isDockAttachmentTarget(wrapper, url)) return null;
    if (!isDockFileEligible({
        type: inlineType,
        categoryEnabled: viewerEnabled(inlineType),
        decoderEnabled: decoderEnabledForFile(inlineType, url)
    })) return null;
    return { url: fullResImageUrl(url), name: nameFromUrl(url), type: inlineType };
}

function resolveInlineMediaClick(target: EventTarget | null): { url: string; name: string; type: ContentType; } | null {
    // Phase 1: an inline IMAGE (Discord media inside an imageWrapper) — a video can also
    // sit in that imageWrapper, so mediaFromContainer routes it as video when present.
    let el = target as HTMLElement | null;
    for (let i = 0; i < 10 && el; i++) {
        const cls = String((el as any).className?.baseVal ?? el.className ?? "");
        if (/imageWrapper|imageZoom|lazyImgContainer|clickableWrapper/i.test(cls)) {
            const hit = mediaFromContainer(el);
            if (hit) return hit;
            break;
        }
        el = el.parentElement;
    }
    return null;
}

function onDocClickCapture(e: MouseEvent) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target : null;
    // This listener sees every click in Discord. All valid Dock attachment opens already
    // require this marker, so ordinary chat/header/composer clicks can leave immediately.
    if (!target?.closest(ATTACHMENT_SURFACE_SELECTOR)) return;
    if (isExplicitDownloadButton(e.target)) return;
    // Inline image / video -> dock panel (suppress Discord's native lightbox / player).
    const mediaHit = resolveInlineMediaClick(e.target);
    if (mediaHit) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        try {
            load({
                name: mediaHit.name,
                url: mediaHit.url,
                type: mediaHit.type,
                sourceMessage: sourceMessageFromTarget(e.target),
                sourceImageContext: sourceImageContextFromTarget(e.target)
            });
        } catch {
            /* panel mount failed; fall back to native by not blocking next time */
        }
        return;
    }
    const hit = resolvePanelClick(e.target);
    if (hit) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        openInPanel(hit.url, nameFromUrl(hit.url), sourceMessageFromTarget(e.target));
        return;
    }
}

let attached = false;

/** Install the capture-phase delegation listener. */
export function startEmbed() {
    if (attached) return;
    document.addEventListener("click", onDocClickCapture, true);
    attached = true;
}

/** Remove the delegation listener. */
export function stopEmbed() {
    if (!attached) return;
    document.removeEventListener("click", onDocClickCapture, true);
    attached = false;
}
