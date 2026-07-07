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
import { detectType, IMG_EXT } from "./engine/detectType";
import type { ContentType } from "./engine/types";
import { load } from "./engine/load";
import { openExternalLink } from "./external/openExternal";
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
    // A "web" url is not an attachment/file chip — it's a plain message link, handled by
    // main's window-open hook (WEB_TAB_OPEN -> openWebTab), NOT the chip route. Exclude it
    // here so the file-chip resolver only ever matches real dock-openable FILES.
    if (type === "web") return false;
    return viewerEnabled(type);
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
function openInPanel(url: string, name: string) {
    try {
        load({ name, url });
        return;
    } catch {
        /* panel mount failed somehow — fall back to opening the link */
    }
    openExternalLink(url);
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
            if (isPanelUrl(a.href || a.getAttribute("href"))) {
                return { url: a.href, anchor: a };
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
                if (isPanelUrl(a.href)) return { url: a.href, anchor: a };
            }
        }
        el = el.parentElement;
    }
    return null;
}

// --- web-link interception (A1) ---------------------------------------------
// A left-click on a real THIRD-PARTY http(s) web-page link in a chat message opens the
// page as a dock WEB tab (the browsing pillar) instead of the external browser. Anything
// on a Discord-owned host (channels/@me/DMs, /shop, /store, invites, support, CDN…) is
// NOT a web page per detectType — it stays "unknown" here and passes through to native
// navigation, untouched. File/media links are handled by the chip path above (isPanelUrl
// excludes "web"), so this only ever matches a plain page link. Modifier/middle clicks
// are already excluded by onDocClickCapture, so ctrl/cmd/middle-click keep native behaviour.

// External web links are NOT sniffed from raw clicks anymore. The app already decides
// "open this url externally" in one place — main/utils/makeLinksOpenExternally's
// setWindowOpenHandler — which internal Discord navigation (the router) and downloads never
// reach. Main signals us the url there and we open it as a dock web tab below.

/** Open an external web url as a dock web tab. Falls back to the OS browser if the dock
 *  can't mount (e.g. the home/friends page has no host). */
export function openWebTab(url: string): void {
    try {
        load({ name: webNameFor(url), url, type: "web" });
    } catch {
        openExternalLink(url);
    }
}

let webOpenListenerArmed = false;

/** Arm the main->renderer "open this web link in the dock" signal once (idempotent). */
export function installWebOpenListener(): void {
    if (webOpenListenerArmed) return;
    const native = (window as any).VesktopNative?.dockView;
    if (!native || typeof native.onOpenWebTab !== "function") return;
    native.onOpenWebTab((url: string) => openWebTab(url));
    webOpenListenerArmed = true;
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
    const vid = wrapper.querySelector("video") as HTMLVideoElement | null;
    if (vid) {
        // Prefer the url the inline <video> is ACTUALLY playing (currentSrc/src) — it's
        // the signed, playable one. fiberImageUrl can hand back a different/un-signed
        // attachment url that the dock's <video> then 403s on ("Can't play this here").
        const vurl = vid.currentSrc || vid.src || fiberImageUrl(wrapper) || null;
        if (vurl && detectType({ url: vurl }) === "video" && viewerEnabled("video")) return { url: vurl, name: nameFromUrl(vurl), type: "video" };
    }
    const img = wrapper.querySelector("img");
    const url = fiberImageUrl(wrapper) || (img ? img.src : null);
    if (!url) return null;
    const t = detectType({ url });
    // An inline video/audio → gate on the Media category; anything else is an image →
    // gate on the Images category. A disabled category returns null so the click falls
    // through to Discord's native lightbox / player (no dock).
    if (t === "video" || t === "audio") return viewerEnabled(t) ? { url, name: nameFromUrl(url), type: t } : null;
    if (!isImageUrl(url) && !/\/attachments\//.test(url)) return null;
    if (!viewerEnabled("image")) return null;
    return { url: fullResImageUrl(url), name: nameFromUrl(url), type: "image" };
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
    // Phase 2: a click that landed on a VIDEO player's overlay chrome (the play button /
    // title) which can sit OUTSIDE the imageWrapper. Climb to the video's visual-media
    // container and route it as video. Audio (nonVisualMediaItem) has no <video>, so it
    // never matches here and falls through to resolvePanelClick.
    el = target as HTMLElement | null;
    for (let i = 0; i < 10 && el; i++) {
        const cls = String((el as any).className?.baseVal ?? el.className ?? "");
        if (/(?:^|[^a-z])visualMediaItem|mosaicItem/i.test(cls)) {
            const vid = el.querySelector("video") as HTMLVideoElement | null;
            if (vid) {
                const vurl = vid.currentSrc || vid.src || fiberImageUrl(el) || null;
                if (vurl && detectType({ url: vurl }) === "video") return { url: vurl, name: nameFromUrl(vurl), type: "video" };
            }
        }
        el = el.parentElement;
    }
    return null;
}

function onDocClickCapture(e: MouseEvent) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isExplicitDownloadButton(e.target)) return;
    // Inline image / video -> dock panel (suppress Discord's native lightbox / player).
    const mediaHit = resolveInlineMediaClick(e.target);
    if (mediaHit) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        try {
            load({ name: mediaHit.name, url: mediaHit.url, type: mediaHit.type });
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
        openInPanel(hit.url, nameFromUrl(hit.url));
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
