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

import { ContextMenuApi, Menu, React } from "@webpack/common";

import { detectType, IMG_EXT } from "./engine/detectType";
import type { ContentType } from "./engine/types";
import { load } from "./engine/load";
import { openExternalLink } from "./external/openExternal";
import { STRINGS } from "./strings";
import { fullResImageUrl } from "./viewers/image/url";

// openContextMenu/closeContextMenu are read off ContextMenuApi at CALL time, never
// destructured at module top: touching a @webpack/common proxy during the plugin's
// module-eval drags Webpack in before it's ready, and the whole plugin then fails
// to register (the lazy-init trap).

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

/** Is this URL a file the dock panel can render? Decided ENTIRELY by detectType —
 *  any recognised extension (≠ "unknown") is dock-handled. */
function isPanelUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    return detectType({ url }) !== "unknown";
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

/** Context menu (right-click on a chip): open in panel / open externally / copy. */
function ArtifactContextMenu({ url, name }: { url: string; name: string; }) {
    return React.createElement(Menu.Menu, {
        navId: "artifact-context-menu",
        onClose: () => ContextMenuApi.closeContextMenu()
    },
    React.createElement(Menu.MenuGroup, null,
        React.createElement(Menu.MenuItem, {
            id: "artifact-open",
            label: STRINGS.menu.openInPanel,
            action: () => openInPanel(url, name)
        }),
        React.createElement(Menu.MenuItem, {
            id: "artifact-popout",
            label: STRINGS.menu.openInNewWindow,
            action: () => openExternalLink(url)
        })
    ),
    React.createElement(Menu.MenuSeparator),
    React.createElement(Menu.MenuGroup, null,
        React.createElement(Menu.MenuItem, {
            id: "artifact-copy-link",
            label: STRINGS.menu.copyLink,
            action: () => { try { navigator.clipboard.writeText(url); } catch { /* ignore */ } }
        })
    )
    );
}

// --- chip click delegation --------------------------------------------------

/** Is this node (or an ancestor up to the chip) the EXPLICIT download button? */
function isExplicitDownloadButton(target: EventTarget | null): boolean {
    let el = target as HTMLElement | null;
    for (let i = 0; i < 8 && el; i++) {
        const cls = String(el.className || "");
        if (/hoverBarButton|hoverButtonGroup|downloadButton/i.test(cls)) return true;
        if (el.tagName === "A") {
            // Match Discord's OWN localized download aria-label (not our copy) so
            // the native download button keeps working across UI languages.
            const label = (el.getAttribute("aria-label") || "").toLowerCase();
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
function resolveInlineMediaClick(target: EventTarget | null): { url: string; name: string; type: ContentType; } | null {
    let el = target as HTMLElement | null;
    let wrapper: HTMLElement | null = null;
    let img: HTMLImageElement | null = null;
    for (let i = 0; i < 10 && el; i++) {
        if (el.tagName === "IMG" && !img) img = el as HTMLImageElement;
        const cls = String((el as any).className?.baseVal ?? el.className ?? "");
        if (/imageWrapper|imageZoom|lazyImgContainer|clickableWrapper/i.test(cls)) {
            wrapper = el;
            break;
        }
        el = el.parentElement;
    }
    if (!wrapper) return null;
    if (!img) img = wrapper.querySelector("img");
    // Prefer the fiber's original-resolution url; fall back to the <img>/<video> src.
    let url = fiberImageUrl(wrapper) || (img ? img.src : null) || (wrapper.querySelector("video") || {} as any).src || null;
    if (!url) return null;
    // A video (or audio) sitting in the visual-media grid → the media viewer, with the
    // RAW url (the full-res image transform must never touch a media url).
    const t = detectType({ url });
    if (t === "video" || t === "audio") return { url, name: nameFromUrl(url), type: t };
    // Image path: only intercept actual image assets (skip stickers/emoji/avatars
    // without an ext) and load the full-resolution url.
    if (!isImageUrl(url) && !/\/attachments\//.test(url)) return null;
    url = fullResImageUrl(url);
    return { url, name: nameFromUrl(url), type: "image" };
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
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    openInPanel(hit.url, nameFromUrl(hit.url));
}

function onDocContextCapture(e: MouseEvent) {
    const hit = resolvePanelClick(e.target);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const url = hit.url;
    ContextMenuApi.openContextMenu(e as any, () =>
        React.createElement(ArtifactContextMenu, { url, name: nameFromUrl(url) }));
}

// --- inline video → static thumbnail marking --------------------------------
// Discord renders a video attachment as an inline PLAYER (imageWrapper > video +
// play-button chrome). We mark each such wrapper so style.css can hide the play
// chrome — the video then reads as a static thumbnail (like an image) and a click
// opens it in the dock (onDocClickCapture intercepts it). Pure CSS can't target
// "an imageWrapper that contains a <video>" without :has(), which the browser
// re-evaluates on every DOM mutation and which stalled composer typing — so we mark
// with a data-attribute instead, the same targeted technique as host/exclusivity.
const VIDEO_THUMB_ATTR = "data-dockview-video-thumb";

function markVideoThumbs(root: ParentNode = document): void {
    root.querySelectorAll<HTMLVideoElement>("video").forEach(v => {
        const wrap = v.closest<HTMLElement>('[class*="imageWrapper"]');
        if (wrap && !wrap.hasAttribute(VIDEO_THUMB_ATTR)) wrap.setAttribute(VIDEO_THUMB_ATTR, "true");
    });
}

let mediaObserver: MutationObserver | null = null;
let mediaDebounce: any = null;

/** Watch for added video attachments and mark their wrapper. Cheap: a mutation only
 *  schedules a (debounced) sweep when an added node IS or CONTAINS a <video>, so the
 *  chat's high churn (typing, scrolling) costs almost nothing. */
function startVideoMarking(): void {
    markVideoThumbs();
    mediaObserver = new MutationObserver(records => {
        let touched = false;
        for (const r of records) {
            for (const n of Array.from(r.addedNodes)) {
                if (n.nodeType !== 1) continue;
                const el = n as Element;
                if (el.tagName === "VIDEO" || el.querySelector?.("video")) { touched = true; break; }
            }
            if (touched) break;
        }
        if (!touched) return;
        clearTimeout(mediaDebounce);
        mediaDebounce = setTimeout(() => markVideoThumbs(), 60);
    });
    mediaObserver.observe(document.body, { childList: true, subtree: true });
}

function stopVideoMarking(): void {
    mediaObserver?.disconnect();
    mediaObserver = null;
    clearTimeout(mediaDebounce);
    document.querySelectorAll(`[${VIDEO_THUMB_ATTR}]`).forEach(el => el.removeAttribute(VIDEO_THUMB_ATTR));
}

let attached = false;

/** Install the capture-phase delegation listeners + the video-thumbnail marking. */
export function startEmbed() {
    if (attached) return;
    document.addEventListener("click", onDocClickCapture, true);
    document.addEventListener("contextmenu", onDocContextCapture, true);
    startVideoMarking();
    attached = true;
}

/** Remove the delegation listeners + the marking observer. */
export function stopEmbed() {
    if (!attached) return;
    document.removeEventListener("click", onDocClickCapture, true);
    document.removeEventListener("contextmenu", onDocContextCapture, true);
    stopVideoMarking();
    attached = false;
}
