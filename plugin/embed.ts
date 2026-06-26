/*
 * DockView — attachment embed (click-to-panel delegation).
 * ---------------------------------------------------------------------------
 * Panel-renderable attachments (.artifact/.html/.pdf/.md + a wide set of code
 * extensions) are NOT auto-rendered inline. Discord shows them as its native
 * attachment chip; clicking the chip loads the file into the DockView panel.
 * The panel's content-type router (panel.tsx) picks the renderer by extension.
 *
 * ONE capture-phase document click listener (delegation) intercepts clicks on
 * panel-renderable chips and routes them to the panel, suppressing the default
 * download navigation. The explicit hover-bar download button keeps native
 * behaviour. Ported to standard imports + direct load() call (no window global)
 * and start/stop listener management.
 */

import { closeModal, ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { ContextMenuApi, Menu, React } from "@webpack/common";

import { load } from "./panel";
import { STRINGS } from "./strings";

const { openContextMenu, closeContextMenu } = ContextMenuApi;

// MUST mirror panel.tsx's detectType coverage.
// (.dot/.gv -> graphviz, .ipynb -> notebook; .json/.json5/.xml already present, now
//  route to the structured tree in detectType.)
const PANEL_EXT_GROUP =
    "artifact|html?|pdf|md|markdown|mdown|mkd|docx|xlsx|xls|mmd|mermaid|" +
    "dot|gv|ipynb|" +
    "txt|text|log|js|mjs|cjs|jsx|ts|tsx|mts|cts|py|pyw|json|json5|csv|tsv|" +
    "css|scss|less|xml|svg|plist|yml|yaml|sh|bash|zsh|fish|c|h|cpp|cxx|cc|" +
    "hpp|hxx|hh|java|kt|kts|rs|go|rb|php|sql|toml|ini|cfg|conf|tex|lua|vue|" +
    "svelte|swift|dart|scala|pl|pm|r|diff|patch|env|properties|gradle|groovy";

const PANEL_EXT_RE = new RegExp(`\\.(${PANEL_EXT_GROUP})$`, "i");
const PANEL_EXT_RE_RAW = new RegExp(`\\.(${PANEL_EXT_GROUP})(\\?|#|$)`, "i");

// Image attachments are rendered INLINE (not as a chip): clicking one normally
// opens Discord's native lightbox modal. We intercept that click instead and
// render the full-resolution image in the dock panel. (Must mirror panel.tsx's
// IMG_EXT set.)
const IMG_EXT_GROUP = "png|jpe?g|gif|webp|bmp|svg|apng|avif";
const IMG_EXT_RE = new RegExp(`\\.(${IMG_EXT_GROUP})(\\?|#|$)`, "i");

/** The matched extension of a url's path, lowercased, or null. */
function panelExt(url: string | null | undefined): string | null {
    if (!url) return null;
    let path = url;
    try {
        path = new URL(url, location.href).pathname;
    } catch {
        /* keep raw */
    }
    const m = PANEL_EXT_RE.exec(path);
    if (m) return m[1].toLowerCase();
    const m2 = PANEL_EXT_RE_RAW.exec(url);
    return m2 ? m2[1].toLowerCase() : null;
}

/** Is this URL a file the dock panel can render? (ignores query string) */
function isPanelUrl(url: string | null | undefined): boolean {
    return panelExt(url) != null;
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

function openPopout(html: string, name: string) {
    const popup = window.open("", name, "width=900,height=700,menubar=no,toolbar=no");
    if (!popup) return;
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    popup.document.title = name;
}

/**
 * Primary action: load the file into the DockView panel by URL. The panel's
 * router picks the renderer + fetches the url itself (bypassing the download
 * Content-Disposition). Falls back to a modal/window only if load() throws.
 */
function openInPanel(url: string, name: string) {
    try {
        load({ name, url });
        return;
    } catch {
        /* panel mount failed somehow — fall back per type */
    }
    const ext = panelExt(url);
    if (ext === "artifact" || ext === "html" || ext === "htm") {
        fetch(url)
            .then(r => {
                if (!r.ok) throw new Error(r.status + " " + r.statusText);
                return r.text();
            })
            .then(html => openArtifactModal(html, name, url))
            .catch(() => {
                /* give up silently; chip still shows */
            });
    } else {
        window.open(url, "_blank", "noopener");
    }
}

function openArtifactModal(html: string, name: string, _url: string) {
    const key = openModal((props: any) =>
        React.createElement(ModalRoot, {
            ...props,
            size: ModalSize.LARGE,
            style: { maxWidth: "90vw", width: "1200px", maxHeight: "90vh", height: "85vh" }
        },
        React.createElement(ModalHeader, {
            style: { justifyContent: "space-between", alignItems: "center", padding: "12px 16px" }
        },
        React.createElement("span", {
            style: { fontWeight: 600, fontSize: "16px", color: "var(--header-primary, #f2f3f5)" }
        }, name),
        React.createElement("div", {
            style: { display: "flex", gap: "8px", alignItems: "center" }
        },
        React.createElement("button", {
            onClick: () => { openPopout(html, name); closeModal(key); },
            style: {
                background: "none", border: "none", color: "var(--interactive-normal)",
                cursor: "pointer", fontSize: "13px", padding: "4px 8px", borderRadius: "4px"
            },
            title: STRINGS.header.openInNewWindow,
            onMouseEnter: (e: any) => e.target.style.color = "var(--interactive-hover)",
            onMouseLeave: (e: any) => e.target.style.color = "var(--interactive-normal)"
        }, STRINGS.header.popOut),
        React.createElement(ModalCloseButton, { onClick: props.onClose })
        )
        ),
        React.createElement(ModalContent, {
            style: { padding: 0, overflow: "hidden" }
        },
        React.createElement("iframe", {
            srcDoc: html,
            sandbox: "allow-scripts allow-same-origin",
            style: { width: "100%", height: "100%", minHeight: "70vh", border: "none", background: "white" }
        })
        )
        )
    );
}

/** Context menu (right-click on a chip): open in panel / popout / copy. */
function ArtifactContextMenu({ url, name }: { url: string; name: string; }) {
    const ext = panelExt(url);
    const isHtml = ext === "artifact" || ext === "html" || ext === "htm";
    return React.createElement(Menu.Menu, {
        navId: "artifact-context-menu",
        onClose: closeContextMenu
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
            action: () => {
                if (isHtml) {
                    fetch(url).then(r => r.text()).then(h => openPopout(h, name)).catch(() => { });
                } else {
                    window.open(url, "_blank", "noopener");
                }
            }
        })
    ),
    React.createElement(Menu.MenuSeparator),
    React.createElement(Menu.MenuGroup, null,
        React.createElement(Menu.MenuItem, {
            id: "artifact-copy-link",
            label: STRINGS.menu.copyLink,
            action: () => navigator.clipboard.writeText(url)
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

/** Strip Discord's resize query params, keep the signed-CDN ones (ex/is/hm). */
function fullResImageUrl(raw: string): string {
    try {
        const u = new URL(raw, location.href);
        // The width/height/format/quality params are the *thumbnail* resize hints;
        // dropping them gives the original-resolution asset. The ex/is/hm signing
        // params MUST stay or the CDN 403s.
        ["width", "height", "format", "quality", "size", "passthrough", "animated"].forEach(p => u.searchParams.delete(p));
        return u.toString();
    } catch {
        return raw;
    }
}

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

/**
 * Resolve a click on an INLINE image (Discord media, not an attachment chip) to
 * its full-resolution url, or null if this isn't an image we should intercept.
 */
function resolveInlineImageClick(target: EventTarget | null): { url: string; name: string; } | null {
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
    // Prefer the fiber's original-resolution url; fall back to the <img> src.
    let url = fiberImageUrl(wrapper) || (img ? img.src : null);
    if (!url) return null;
    // Only intercept actual image assets (skip stickers/emoji/avatars without ext).
    if (!IMG_EXT_RE.test(url) && !/\/attachments\//.test(url)) return null;
    url = fullResImageUrl(url);
    return { url, name: nameFromUrl(url) };
}

function onDocClickCapture(e: MouseEvent) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isExplicitDownloadButton(e.target)) return;
    // Inline image -> dock panel (suppress Discord's native lightbox modal).
    const imgHit = resolveInlineImageClick(e.target);
    if (imgHit) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        try {
            load({ name: imgHit.name, url: imgHit.url, type: "image" });
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
    openContextMenu(e as any, () =>
        React.createElement(ArtifactContextMenu, { url, name: nameFromUrl(url) }));
}

let attached = false;

/** Install the capture-phase delegation listeners. */
export function startEmbed() {
    if (attached) return;
    document.addEventListener("click", onDocClickCapture, true);
    document.addEventListener("contextmenu", onDocContextCapture, true);
    attached = true;
}

/** Remove the delegation listeners (the new lifecycle requirement). */
export function stopEmbed() {
    if (!attached) return;
    document.removeEventListener("click", onDocClickCapture, true);
    document.removeEventListener("contextmenu", onDocContextCapture, true);
    attached = false;
}
