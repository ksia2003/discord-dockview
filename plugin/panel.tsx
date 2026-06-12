/*
 * DockView — panel core (ported from Vesktop fork dockPanel.ts).
 * ---------------------------------------------------------------------------
 * A toggleable right-docked panel that is pixel-identical to Discord's THREAD
 * CONVERSATION SIDEBAR and mounts at the SAME LAYOUT LEVEL as a real thread so
 * its position / height / chat-reflow are native-identical. Content-type router
 * fills the body: HTML artifact (nonce iframe), PDF (pdf.js main thread), code
 * (hljs <pre>), markdown (marked -> dark iframe).
 *
 * Ported to a standard Vencord userplugin: Vencord.Webpack.* -> @webpack /
 * @webpack/common imports; top-level boot -> startPanel(); full cleanup ->
 * stopPanel().
 */

import { findByProps, findCssClasses } from "@webpack";
import { ContextMenuApi, createRoot, Menu, React } from "@webpack/common";
import type { Root } from "react-dom/client";

// pdf.js — bundled into the renderer by esbuild. We ALSO import the worker
// module and register it on globalThis.pdfjsWorker so pdf.js runs the worker
// message handler ON THE MAIN THREAD (its "fake worker" path) using THIS
// already-bundled code. No `new Worker(url)`, no blob: URL, no dynamic
// import() — all three of which Discord's CSP would block.
import * as pdfjsLib from "pdfjs-dist";
import { WorkerMessageHandler as PdfWorkerMessageHandler } from "pdfjs-dist/build/pdf.worker.mjs";

// marked — markdown -> HTML, bundled into the renderer IIFE.
import { marked } from "marked";

// highlight.js (bundled) — the FALLBACK code highlighter. We prefer Discord's
// OWN bundled hljs (resolved at runtime via Webpack) and only fall back here.
import hljs from "highlight.js";

// --- runtime polyfill: Map/WeakMap upsert helpers ---------------------------
// pdf.js v6 uses the TC39 "Upsert" methods Map/WeakMap.prototype.getOrInsert &
// getOrInsertComputed internally. They are NOT yet shipped in this
// Electron/Chromium V8 build, so without these shims page.render() rejects.
function installUpsert(Ctor: any) {
    const proto = Ctor && Ctor.prototype;
    if (!proto) return;
    if (typeof proto.getOrInsert !== "function") {
        Object.defineProperty(proto, "getOrInsert", {
            configurable: true,
            writable: true,
            value(key: any, value: any) {
                if (this.has(key)) return this.get(key);
                this.set(key, value);
                return value;
            }
        });
    }
    if (typeof proto.getOrInsertComputed !== "function") {
        Object.defineProperty(proto, "getOrInsertComputed", {
            configurable: true,
            writable: true,
            value(key: any, callbackFn: (k: any) => any) {
                if (this.has(key)) return this.get(key);
                const v = callbackFn(key);
                this.set(key, v);
                return v;
            }
        });
    }
}
installUpsert(Map);
installUpsert(WeakMap);

// Register the bundled worker handler for pdf.js's main-thread fallback.
try {
    (globalThis as any).pdfjsWorker = { WorkerMessageHandler: PdfWorkerMessageHandler };
} catch {
    /* ignore — getDocument will still fall back, just noisier */
}

const HOST_ID = "dockview-root";
const LS_WIDTH = "dockview.dock.width";
const LS_OPEN = "dockview.dock.open";

const MIN_WIDTH = 360;
const DEFAULT_WIDTH = 420;
const MAX_WIDTH_FRAC = 0.6; // of window width

// ---------------------------------------------------------------------------
// Discord native class resolution (theme-aware, update-robust). Fallbacks are
// the literal classes from the build we extracted on (2026-06).
// ---------------------------------------------------------------------------
type ClassMap = Record<string, string>;

/** Resolve a CSS-module by a set of keys, returning the requested keys. */
function cssMod(...keys: string[]): ClassMap {
    try {
        const m = (findCssClasses as any)?.(...keys);
        if (m && typeof m === "object") return m;
    } catch {
        /* fall through to {} */
    }
    return {};
}

// chatLayerWrapper module (wrapper / card / resize handle).
const wrapMod = cssMod("chatLayerWrapper", "resizeHandle", "container", "notFloating");
// header-bar module (the generic channel/thread title toolbar).
const headMod = cssMod("upperContainer", "toolbar", "children", "container", "themed", "title", "titleWrapper");
// Typography: the real thread title h2 is `text-md/medium` (16px / weight 500).
const textMd = cssMod("text-md/medium")["text-md/medium"] || "text-md/medium_cf4812";
const defaultColor = cssMod("defaultColor")["defaultColor"] || "defaultColor__4bd52";

const CLS = {
    wrapper: wrapMod.chatLayerWrapper || "chatLayerWrapper__01ae2",
    resizeHandle: wrapMod.resizeHandle || "resizeHandle__01ae2",
    card: wrapMod.container || "container__01ae2",
    headerSection: `${headMod.container || "container__9293f"} ${headMod.themed || "themed__9293f"}`,
    upper: headMod.upperContainer || "upperContainer__9293f",
    headerChildren: headMod.children || "children__9293f",
    toolbar: headMod.toolbar || "toolbar__9293f",
    titleWrapper: headMod.titleWrapper || "titleWrapper__9293f",
    title: `${defaultColor} ${textMd} ${headMod.title || "title__9293f"}`,
    iconWrapper: "iconWrapper__9293f",
    clickable: "clickable__9293f"
};

// In the renderer's isolated context a *bare* `localStorage` is not a defined
// global (only `window.localStorage` is). Always go via window.
function lsGet(k: string): string | null {
    try {
        return window.localStorage ? window.localStorage.getItem(k) : null;
    } catch {
        return null;
    }
}
function lsSet(k: string, v: string): void {
    try {
        window.localStorage?.setItem(k, v);
    } catch {
        /* ignore */
    }
}

// --- shared open/width state (kept outside React) ---------------------------
const state = {
    open: lsGet(LS_OPEN) === "1",
    width: clampWidth(parseInt(lsGet(LS_WIDTH) || "", 10) || DEFAULT_WIDTH)
};

// --- panel content state ----------------------------------------------------
type ContentType = "html" | "pdf" | "code" | "markdown" | "image";

interface PdfState {
    doc: any | null; // pdfjs PDFDocumentProxy
    pages: number;
    renderToken: number; // bumped per pdf load so a stale render aborts
}

interface PanelContent {
    name: string | null;
    type: ContentType;
    html: string | null;
    frameHtml: string | null;
    pdf: PdfState;
    code: string | null;
    codeLang: string;
    url: string | null;
    loading: boolean;
    error: string | null;
    seq: number;
}
const content: PanelContent = {
    name: null,
    type: "html",
    html: null,
    frameHtml: null,
    pdf: { doc: null, pages: 0, renderToken: 0 },
    code: null,
    codeLang: "plaintext",
    url: null,
    loading: false,
    error: null,
    seq: 0
};

// Memoized highlight + gutter for the code body, keyed on content.seq. A given
// seq uniquely identifies one loaded file (code + language are fixed for it), so
// the hljs pass + the gutter string are computed ONCE per file and reused across
// every subsequent DockPanel re-render. Without it, renderCodeBody re-ran hljs
// over the WHOLE file each render (measured ~30 full passes / drag on a 300 KB
// file, several seconds of main-thread blocking). The resize drag no longer
// re-renders DockPanel at all, but this keeps any stray re-render (toolbar,
// word-wrap toggle, scroll-driven page indicator…) cheap as defence-in-depth.
// Cleared by resetCode() so a new load can't read a stale highlight.
let codeRenderCache: { seq: number; html: string; gutter: string } | null = null;

// --- image viewer view-state (zoom / pan), shared with the toolbar ----------
// scale === 1 means "fit" (contain). Bumping scale zooms; tx/ty pan when zoomed
// past fit. We keep this at module scope so the header TOOLBAR controls and the
// ImageBody render the same state. `imgControls` is wired by ImageBody on mount
// so the toolbar buttons (and keyboard) can drive zoom without prop-drilling.
const IMG_MIN_SCALE = 1; // never below fit
const IMG_MAX_SCALE = 8;
const imgView = { scale: 1, tx: 0, ty: 0, natW: 0, natH: 0 };
function resetImgView() {
    imgView.scale = 1;
    imgView.tx = 0;
    imgView.ty = 0;
}
interface ImgControls {
    zoomIn: () => void;
    zoomOut: () => void;
    reset: () => void;
    getScale: () => number;
}
let imgControls: ImgControls | null = null;

// --- code viewer view-state (word-wrap toggle), shared with the toolbar ------
const codeView = { wrap: false };

// --- PDF viewer view-state (page nav / zoom / fit / find), shared w/ toolbar --
// `fit` is the auto-scale mode: "width" makes a page fill the panel width,
// "page" makes one page fit the panel height. `zoom` multiplies the fit scale
// (1 = exactly fit). `page`/`total` track the page indicator (1-based). `find`
// drives the in-panel search overlay. Module-scope so the header TOOLBAR and the
// keyboard handler drive the same state the PdfBody renders.
type PdfFit = "width" | "page";
const PDF_MIN_ZOOM = 0.25;
const PDF_MAX_ZOOM = 5;
const pdfView = {
    page: 1,
    total: 0,
    fit: "width" as PdfFit,
    zoom: 1,
    // search state
    findOpen: false,
    findQuery: "",
    findMatches: 0,
    findActive: 0 // 1-based index of the active match (0 = none)
};
function resetPdfView() {
    pdfView.page = 1;
    pdfView.total = 0;
    pdfView.fit = "width";
    pdfView.zoom = 1;
    pdfView.findOpen = false;
    pdfView.findQuery = "";
    pdfView.findMatches = 0;
    pdfView.findActive = 0;
}
interface PdfControls {
    goToPage: (n: number) => void;
    prevPage: () => void;
    nextPage: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    setFit: (f: PdfFit) => void;
    fitWidth: () => void; // reset zoom to 1 (fit panel width) + ensure width mode
    toggleFind: () => void;
    setFindQuery: (q: string) => void;
    findNext: () => void;
    findPrev: () => void;
    // Live resize feedback: during a resize drag we scale the already-rendered
    // pages with a CSS transform (cheap, GPU-composited) for instant feedback,
    // then re-raster crisply on drag end. ratio = newWidth / widthAtDragStart.
    liveScale: (ratio: number) => void;
    endLiveScale: () => void;
}
let pdfControls: PdfControls | null = null;

// --- per-channel memory (in-memory only) ------------------------------------
// Each channel id remembers the descriptor of whatever was last loaded into the
// panel + whether the panel was open there. On CHANNEL_SELECT we save the
// outgoing channel's state and restore the incoming one (re-load by descriptor;
// no rendered-DOM cache). Width is global (shared, in `state.width`).
interface ChannelDescriptor {
    name: string;
    url: string;
    type: ContentType;
}
interface ChannelMemory {
    open: boolean;
    descriptor: ChannelDescriptor | null;
}
const channelStates = new Map<string, ChannelMemory>();
let currentChannelId: string | null = null;
// The descriptor currently shown in the panel (so we can save it on switch).
let activeDescriptor: ChannelDescriptor | null = null;

// Extension -> highlight.js language id.
const CODE_LANG: Record<string, string> = {
    txt: "plaintext", text: "plaintext", log: "plaintext",
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    py: "python", pyw: "python",
    json: "json", json5: "json",
    csv: "plaintext", tsv: "plaintext",
    css: "css", scss: "scss", less: "less",
    xml: "xml", svg: "xml", plist: "xml",
    yml: "yaml", yaml: "yaml",
    sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
    c: "c", h: "c",
    cpp: "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp", hxx: "cpp", hh: "cpp",
    java: "java", kt: "kotlin", kts: "kotlin",
    rs: "rust", go: "go", rb: "ruby", php: "php",
    sql: "sql", toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
    tex: "latex", lua: "lua",
    vue: "xml", svelte: "xml",
    swift: "swift", dart: "dart", scala: "scala", pl: "perl", pm: "perl",
    r: "r", m: "objectivec", makefile: "makefile", mk: "makefile",
    dockerfile: "dockerfile", gradle: "gradle", groovy: "groovy",
    diff: "diff", patch: "diff", env: "ini", properties: "ini"
};
// Extensions that are markdown.
const MD_EXT = new Set(["md", "markdown", "mdown", "mkd"]);
// Extensions rendered as an <img> (fit-width) in the panel instead of opening
// Discord's native lightbox.
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "apng", "avif"]);

// Dark-themed stylesheet injected into the markdown sandbox iframe.
const MD_STYLE = `<style>
:root { color-scheme: dark; }
html, body { margin: 0; padding: 0; background: #1e1f22; }
.md {
  box-sizing: border-box;
  max-width: 100%;
  padding: 16px 20px 48px;
  color: #dbdee1;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji";
  font-size: 15px;
  line-height: 1.6;
  word-wrap: break-word;
}
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { color: #f2f3f5; font-weight: 600; line-height: 1.3; margin: 24px 0 12px; }
.md h1 { font-size: 1.9em; border-bottom: 1px solid #3f4147; padding-bottom: .3em; }
.md h2 { font-size: 1.5em; border-bottom: 1px solid #3f4147; padding-bottom: .3em; }
.md h3 { font-size: 1.25em; }
.md h4 { font-size: 1.05em; }
.md p { margin: 0 0 14px; }
.md a { color: #00a8fc; text-decoration: none; }
.md a:hover { text-decoration: underline; }
.md ul, .md ol { margin: 0 0 14px; padding-left: 2em; }
.md li { margin: 4px 0; }
.md li > p { margin: 0; }
.md blockquote { margin: 0 0 14px; padding: 0 1em; color: #b5bac1; border-left: 4px solid #4e5058; }
.md hr { height: 1px; border: 0; background: #3f4147; margin: 24px 0; }
.md img { max-width: 100%; }
.md code { font-family: Consolas, "Andale Mono WT", "Andale Mono", monospace; font-size: 85%; background: #2b2d31; padding: .2em .4em; border-radius: 4px; }
.md pre { background: #2b2d31; padding: 14px 16px; border-radius: 6px; overflow: auto; margin: 0 0 14px; border: 1px solid #1e1f22; }
.md pre code { background: none; padding: 0; font-size: 88%; line-height: 1.5; }
.md table { border-collapse: collapse; margin: 0 0 14px; display: block; overflow: auto; max-width: 100%; }
.md table th, .md table td { border: 1px solid #3f4147; padding: 6px 13px; }
.md table th { background: #2b2d31; font-weight: 600; }
.md table tr:nth-child(2n) { background: #26282c; }
.md input[type=checkbox] { margin-right: 6px; }
/* compact hljs dark theme (github-dark-dimmed-ish) */
.hljs { color: #dbdee1; }
.hljs-comment, .hljs-quote { color: #768390; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-doctag, .hljs-formula { color: #f47067; }
.hljs-string, .hljs-meta .hljs-string, .hljs-regexp, .hljs-addition { color: #96d0ff; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable, .hljs-tag .hljs-attr { color: #6cb6ff; }
.hljs-title, .hljs-section, .hljs-title.class_, .hljs-title.function_ { color: #dcbdfb; }
.hljs-built_in, .hljs-class .hljs-title, .hljs-type { color: #f69d50; }
.hljs-attribute, .hljs-attr, .hljs-name { color: #6cb6ff; }
.hljs-symbol, .hljs-bullet, .hljs-link { color: #f69d50; }
.hljs-meta, .hljs-selector-id, .hljs-selector-class { color: #6cb6ff; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
.hljs-deletion { color: #ff938a; }
</style>`;

/** Decide the content type from an explicit hint or the url/name extension. */
function detectType(opts: { type?: ContentType; url?: string | null; name?: string | null }): ContentType {
    if (opts.type) return opts.type;
    const probe = (s?: string | null): string | null => {
        if (!s) return null;
        let path = s;
        try {
            path = new URL(s, location.href).pathname;
        } catch {
            /* keep raw */
        }
        const m = /\.([a-z0-9]+)(?:$|\?|#)/i.exec(path.split("/").pop() || "");
        return m ? m[1].toLowerCase() : null;
    };
    const ext = probe(opts.url) || probe(opts.name);
    if (ext === "pdf") return "pdf";
    if (ext && IMG_EXT.has(ext)) return "image";
    if (ext && MD_EXT.has(ext)) return "markdown";
    if (ext === "artifact" || ext === "html" || ext === "htm") return "html";
    if (ext && ext in CODE_LANG) return "code";
    return "html";
}

/** Resolve the hljs language id for an ext (default plaintext). */
function codeLangFor(ext: string | null): string {
    return (ext && CODE_LANG[ext]) || "plaintext";
}

// ---------------------------------------------------------------------------
// Code highlighter — prefer Discord's OWN bundled highlight.js, fall back.
// ---------------------------------------------------------------------------
type Highlighter = {
    highlight: (code: string, lang: string) => string; // returns HTML
    getLanguage: (lang: string) => boolean;
};
let _hl: Highlighter | null = null;

/** Try to find Discord's bundled hljs via Webpack (highlight + getLanguage). */
function discordHljs(): Highlighter | null {
    try {
        const mod = (findByProps as any)?.("highlight", "getLanguage") || (findByProps as any)?.("highlightAuto", "getLanguage");
        if (mod && typeof mod.highlight === "function" && typeof mod.getLanguage === "function") {
            return {
                getLanguage: (lang: string) => !!mod.getLanguage(lang),
                highlight: (code: string, lang: string) => {
                    try {
                        const r = mod.highlight(code, { language: lang, ignoreIllegals: true });
                        if (r && typeof r.value === "string") return r.value;
                    } catch {
                        /* fall through to legacy */
                    }
                    try {
                        const r = mod.highlight(lang, code, true);
                        if (r && typeof r.value === "string") return r.value;
                    } catch {
                        /* fall through */
                    }
                    return escapeHtml(code);
                }
            };
        }
    } catch {
        /* ignore */
    }
    return null;
}

/** Bundled highlight.js wrapped to the same Highlighter shape. */
function bundledHljs(): Highlighter {
    return {
        getLanguage: (lang: string) => !!(hljs as any).getLanguage(lang),
        highlight: (code: string, lang: string) => {
            try {
                return (hljs as any).highlight(code, { language: lang, ignoreIllegals: true }).value;
            } catch {
                return escapeHtml(code);
            }
        }
    };
}

/** Lazily resolve the highlighter (Discord's, else bundled). */
function getHighlighter(): Highlighter {
    if (_hl) return _hl;
    _hl = discordHljs() || bundledHljs();
    return _hl;
}

/** HTML-escape for the plaintext path (and as a highlight failure fallback). */
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/** Highlight `code` for `lang`, returning safe HTML (escaped if no language). */
function highlightCode(code: string, lang: string): string {
    if (!lang || lang === "plaintext") return escapeHtml(code);
    const hl = getHighlighter();
    if (!hl.getLanguage(lang)) return escapeHtml(code);
    return hl.highlight(code, lang);
}

let forceRender: (() => void) | null = null; // set when React panel mounts
// True for the duration of a resize-handle drag. The PDF ResizeObserver checks
// this to AVOID re-rastering mid-drag (which would clobber the live CSS-scale
// preview and cause a jump); the final crisp raster is driven by endLiveScale().
let resizeDragging = false;
// True while the pointer is over the dock panel — gates the image zoom keys so
// they only fire when the panel (not chat) is the surface the user is acting on.
let hostHovered = false;

/** The per-load CSP nonce the host document's own scripts carry. */
function pageNonce(): string | null {
    try {
        const sc = document.querySelector<HTMLScriptElement>("script[nonce]");
        return sc ? sc.nonce || sc.getAttribute("nonce") : null;
    } catch {
        return null;
    }
}

/** Stamp the host page's CSP nonce onto every INLINE <script> so it runs. */
function injectNonce(html: string, nonce: string): string {
    return html.replace(/<script(\s[^>]*)?>/gi, (full, attrs) => {
        const a = attrs || "";
        if (/\snonce\s*=/i.test(a)) return full; // already nonced
        if (/\ssrc\s*=/i.test(a)) return full; // external script: leave alone
        return `<script${a} nonce="${nonce}">`;
    });
}

/** Set the body HTML + build the nonce-stamped srcdoc the iframe renders. */
function setArtifactHtml(html: string) {
    content.html = html;
    const nonce = pageNonce();
    content.frameHtml = nonce ? injectNonce(html, nonce) : html;
}

/** Open a URL in the user's external browser (markdown / artifact links).
 *  Prefers VencordNative's native opener (desktop), falls back to window.open. */
function openExternalLink(href: string) {
    if (!href) return;
    let url: string;
    try {
        // resolve relative to the host page so relative md links still work
        url = new URL(href, location.href).href;
    } catch {
        url = href;
    }
    // only allow web/mailto schemes through (no javascript:, file:, etc.)
    if (!/^(https?:|mailto:)/i.test(url)) return;
    try {
        const native = (window as any).VencordNative?.native?.openExternal;
        if (typeof native === "function") {
            native(url);
            return;
        }
    } catch {
        /* fall through to window.open */
    }
    try {
        window.open(url, "_blank", "noopener,noreferrer");
    } catch {
        /* ignore */
    }
}

/** Pop the current (or given) artifact out into a standalone browser window. */
export function popoutArtifact(html?: string | null, name?: string | null) {
    const h = html ?? content.html;
    const n = name ?? content.name ?? "artifact";
    if (!h) return;
    const popup = window.open("", n, "width=900,height=700,menubar=no,toolbar=no");
    if (!popup) return;
    popup.document.open();
    popup.document.write(h);
    popup.document.close();
    popup.document.title = n;
}

/** Resolve a url to its absolute form against the host page (for download/copy). */
function absUrl(href: string): string {
    try {
        return new URL(href, location.href).href;
    } catch {
        return href;
    }
}

/** Trigger a browser download of `url` (best-effort filename = current name). */
function downloadUrl(url: string | null | undefined, name?: string | null) {
    if (!url) return;
    const a = document.createElement("a");
    a.href = absUrl(url);
    a.download = name || content.name || "";
    a.rel = "noopener";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    a.remove();
}

/** Copy text (a url) to the clipboard, with a non-secure-context fallback. */
function copyText(text: string | null | undefined) {
    if (!text) return;
    try {
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(() => fallbackCopy(text, () => { }));
            return;
        }
    } catch {
        /* fall through */
    }
    fallbackCopy(text, () => { });
}

/** Copy the current image (by url) to the clipboard as an image blob. */
async function copyImage(url: string | null | undefined) {
    if (!url) return;
    try {
        const resp = await fetch(absUrl(url));
        let blob = await resp.blob();
        // The async Clipboard API only reliably accepts PNG; transcode others
        // via a canvas. (GIF loses animation — acceptable for a still copy.)
        if (blob.type !== "image/png") {
            const png = await imageBlobToPng(blob);
            if (png) blob = png;
        }
        const Ctor = (window as any).ClipboardItem;
        if (Ctor && navigator.clipboard?.write) {
            await navigator.clipboard.write([new Ctor({ [blob.type]: blob })]);
        }
    } catch {
        /* clipboard image unsupported / blocked — silently no-op */
    }
}

/** Decode an image blob and re-encode it as PNG (for clipboard compatibility). */
function imageBlobToPng(blob: Blob): Promise<Blob | null> {
    return new Promise(resolve => {
        const objUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext("2d");
                if (!ctx) { URL.revokeObjectURL(objUrl); resolve(null); return; }
                ctx.drawImage(img, 0, 0);
                canvas.toBlob(b => { URL.revokeObjectURL(objUrl); resolve(b); }, "image/png");
            } catch {
                URL.revokeObjectURL(objUrl);
                resolve(null);
            }
        };
        img.onerror = () => { URL.revokeObjectURL(objUrl); resolve(null); };
        img.src = objUrl;
    });
}

/** Reset only the html/artifact-specific fields. */
function resetHtml() {
    content.html = null;
    content.frameHtml = null;
}
/** Reset only the pdf-specific fields (and bump the render token to abort). */
function resetPdf() {
    if (content.pdf.doc) {
        try {
            content.pdf.doc.destroy();
        } catch {
            /* ignore */
        }
    }
    content.pdf = { doc: null, pages: 0, renderToken: content.pdf.renderToken + 1 };
    resetPdfView();
}
/** Reset only the code/text-specific fields. */
function resetCode() {
    content.code = null;
    content.codeLang = "plaintext";
    codeRenderCache = null; // drop the (possibly large) memoized highlight HTML
}

/** HTML / artifact loader. */
function loadHtml(opts: { name: string; html?: string | null; url?: string | null }) {
    resetPdf();
    resetCode();
    if (opts.html != null) {
        setArtifactHtml(opts.html);
        content.loading = false;
    } else if (opts.url) {
        resetHtml();
        content.loading = true;
        const reqUrl = opts.url;
        fetch(reqUrl)
            .then(r => {
                if (!r.ok) throw new Error(r.status + " " + r.statusText);
                return r.text();
            })
            .then(text => {
                if (content.url !== reqUrl) return;
                setArtifactHtml(text);
                content.loading = false;
                content.error = null;
                forceRender?.();
            })
            .catch(e => {
                if (content.url !== reqUrl) return;
                content.loading = false;
                content.error = String(e?.message || e);
                forceRender?.();
            });
    } else {
        resetHtml();
        content.loading = false;
        content.error = "No artifact source";
    }
}

/** PDF loader: fetch -> ArrayBuffer -> pdf.js (main-thread worker). */
function loadPdf(opts: { name: string; url?: string | null }) {
    resetHtml();
    resetPdf();
    resetCode();
    if (!opts.url) {
        content.loading = false;
        content.error = "No PDF source";
        return;
    }
    content.loading = true;
    const reqUrl = opts.url;
    fetch(reqUrl)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.arrayBuffer();
        })
        .then(buf => {
            if (content.url !== reqUrl) return; // superseded
            const task = pdfjsLib.getDocument({ data: new Uint8Array(buf) });
            return task.promise;
        })
        .then((doc: any) => {
            if (!doc) return; // superseded above
            if (content.url !== reqUrl) {
                try { doc.destroy(); } catch { /* ignore */ }
                return;
            }
            content.pdf.doc = doc;
            content.pdf.pages = doc.numPages;
            pdfView.total = doc.numPages;
            pdfView.page = 1;
            content.pdf.renderToken += 1; // signal: a fresh doc is ready to render
            content.loading = false;
            content.error = null;
            forceRender?.();
        })
        .catch(e => {
            if (content.url !== reqUrl) return;
            content.loading = false;
            content.error = String(e?.message || e);
            forceRender?.();
        });
}

/** Pull the extension from a url/name (lowercased) for language resolution. */
function extOf(s: string | null | undefined): string | null {
    if (!s) return null;
    let path = s;
    try {
        path = new URL(s, location.href).pathname;
    } catch {
        /* keep raw */
    }
    const m = /\.([a-z0-9]+)(?:$|\?|#)/i.exec(path.split("/").pop() || "");
    return m ? m[1].toLowerCase() : null;
}

/** CODE / TEXT loader: fetch text and stash it + its resolved hljs language. */
function loadCode(opts: { name: string; url?: string | null }) {
    resetHtml();
    resetPdf();
    resetCode();
    if (!opts.url) {
        content.loading = false;
        content.error = "No source";
        return;
    }
    content.codeLang = codeLangFor(extOf(opts.url) || extOf(opts.name));
    content.loading = true;
    const reqUrl = opts.url;
    fetch(reqUrl)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.text();
        })
        .then(text => {
            if (content.url !== reqUrl) return; // superseded
            content.code = text;
            content.loading = false;
            content.error = null;
            forceRender?.();
        })
        .catch(e => {
            if (content.url !== reqUrl) return;
            content.loading = false;
            content.error = String(e?.message || e);
            forceRender?.();
        });
}

/** MARKDOWN loader: fetch -> marked -> dark doc -> nonce sandbox iframe path. */
function loadMarkdown(opts: { name: string; url?: string | null }) {
    resetPdf();
    resetCode();
    if (!opts.url) {
        resetHtml();
        content.loading = false;
        content.error = "No source";
        return;
    }
    resetHtml();
    content.loading = true;
    const reqUrl = opts.url;
    fetch(reqUrl)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.text();
        })
        .then(md => {
            if (content.url !== reqUrl) return; // superseded
            let bodyHtml: string;
            try {
                bodyHtml = marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
            } catch (e) {
                bodyHtml = "<pre>" + escapeHtml(String(e)) + "</pre>";
            }
            bodyHtml = highlightMarkdownCode(bodyHtml);
            setArtifactHtml(wrapMarkdownDoc(bodyHtml));
            content.loading = false;
            content.error = null;
            forceRender?.();
        })
        .catch(e => {
            if (content.url !== reqUrl) return;
            content.loading = false;
            content.error = String(e?.message || e);
            forceRender?.();
        });
}

/** IMAGE loader: nothing to fetch — the <img> renders content.url directly. */
function loadImage(opts: { name: string; url?: string | null }) {
    resetHtml();
    resetPdf();
    resetCode();
    if (!opts.url) {
        content.loading = false;
        content.error = "No image source";
        return;
    }
    // The <img> tag streams the url itself; no manual fetch/decode needed.
    resetImgView(); // each new image opens at fit (scale 1), un-panned
    content.loading = false;
    content.error = null;
}

/** Post-process marked's output: highlight fenced code blocks. */
function highlightMarkdownCode(html: string): string {
    return html.replace(
        /<pre><code(?:\s+class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g,
        (_full, fence: string | undefined, escaped: string) => {
            const raw = decodeEntities(escaped);
            const aliases: Record<string, string> = {
                js: "javascript", ts: "typescript", py: "python", rb: "ruby",
                sh: "bash", shell: "bash", yml: "yaml", "c++": "cpp", "c#": "csharp"
            };
            let language = fence ? (aliases[fence.toLowerCase()] || fence.toLowerCase()) : "plaintext";
            if (language !== "plaintext" && !getHighlighter().getLanguage(language)) language = "plaintext";
            const out = highlightCode(raw, language);
            return `<pre><code class="hljs language-${escapeHtml(language)}">${out}</code></pre>`;
        }
    );
}

/** Decode the small set of entities marked emits for code text. */
function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}

/** A tiny script injected into the markdown sandbox iframe so any link click is
 *  opened in the user's BROWSER (not navigated inside the sandbox). The iframe
 *  is sandboxed without allow-popups, so we can't window.open from inside; we
 *  postMessage the href up to the host, which opens it (VencordNative/window). */
const MD_LINK_SCRIPT = `<script>(function(){
  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!href || href[0] === "#") return; // in-page anchor: let it scroll
    e.preventDefault();
    try { parent.postMessage({ __dockViewOpenLink: href }, "*"); } catch (_) {}
  }, true);
})();</script>`;

/** Wrap rendered markdown HTML in a full dark-themed document. Anchors get a
 *  default target so even if the click handler is bypassed they don't navigate
 *  the sandbox itself; the injected script routes clicks to the host browser. */
function wrapMarkdownDoc(bodyHtml: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">${MD_STYLE}</head><body><article class="md">${bodyHtml}</article>${MD_LINK_SCRIPT}</body></html>`;
}

/** CONTENT-TYPE ROUTER. Load anything into the dock panel BODY and open it. */
export function load(opts: { name: string; html?: string | null; url?: string | null; type?: ContentType }) {
    content.name = opts.name || "file";
    content.url = opts.url ?? null;
    content.error = null;
    content.seq += 1;
    content.type = detectType(opts);

    if (content.type === "pdf") {
        loadPdf(opts);
    } else if (content.type === "image") {
        loadImage(opts);
    } else if (content.type === "code") {
        loadCode(opts);
    } else if (content.type === "markdown") {
        loadMarkdown(opts);
    } else {
        loadHtml(opts);
    }

    // Track what's shown so a channel switch can save it. Inline-html artifacts
    // (passed as `opts.html`, no url) can't be re-loaded by descriptor, so they
    // are NOT remembered per-channel (descriptor needs a url).
    activeDescriptor = content.url
        ? { name: content.name as string, url: content.url, type: content.type }
        : null;

    // Open FIRST, then persist — so the saved per-channel state records open:true.
    state.open = true;
    lsSet(LS_OPEN, "1");
    saveCurrentChannelState();
    ensureHost();
    applyOpenState();
    forceRender?.();
}

/** Clear the loaded content, returning the body to the placeholder. */
export function clearArtifact() {
    content.name = null;
    content.type = "html";
    resetHtml();
    resetPdf();
    resetCode();
    content.url = null;
    content.loading = false;
    content.error = null;
    activeDescriptor = null;
    saveCurrentChannelState();
    forceRender?.();
}

// ---------------------------------------------------------------------------
// Per-channel memory: save the current channel's panel state; restore another's
// by re-loading its descriptor. Channel switches come from Flux CHANNEL_SELECT
// (see index.tsx) which calls onChannelSelect(newId).
// ---------------------------------------------------------------------------

/** Persist the panel state (open + active descriptor) for the current channel. */
function saveCurrentChannelState() {
    if (currentChannelId == null) return;
    channelStates.set(currentChannelId, {
        open: state.open,
        descriptor: activeDescriptor
    });
}

/** Load a remembered descriptor WITHOUT re-saving channel state (avoid loops). */
function restoreDescriptor(d: ChannelDescriptor) {
    content.name = d.name || "file";
    content.url = d.url;
    content.error = null;
    content.seq += 1;
    content.type = d.type || detectType({ url: d.url, name: d.name });

    if (content.type === "pdf") loadPdf(d);
    else if (content.type === "image") loadImage(d);
    else if (content.type === "code") loadCode(d);
    else if (content.type === "markdown") loadMarkdown(d);
    else loadHtml(d);

    activeDescriptor = { name: content.name as string, url: d.url, type: content.type };
}

/**
 * React to a Discord channel switch: save the OUTGOING channel's panel state,
 * then restore the INCOMING channel's (re-load its descriptor, or close if it
 * had nothing). Width stays global. Called from the plugin's Flux handler.
 */
export function onChannelSelect(newId: string | null) {
    if (newId === currentChannelId) return;
    // 1. save what the leaving channel had.
    saveCurrentChannelState();
    // 2. switch.
    currentChannelId = newId;
    if (newId == null) return;

    const mem = channelStates.get(newId);
    if (mem && mem.open && mem.descriptor) {
        // restore: open + re-load the remembered file.
        state.open = true;
        lsSet(LS_OPEN, "1");
        restoreDescriptor(mem.descriptor);
        ensureHost();
        applyOpenState();
        forceRender?.();
    } else {
        // nothing remembered (or it was closed) -> empty + closed panel.
        clearLoadedContent();
        activeDescriptor = null;
        state.open = mem ? mem.open : false;
        lsSet(LS_OPEN, state.open ? "1" : "0");
        applyOpenState();
        forceRender?.();
    }
}

/** Clear only the loaded body (not the descriptor / channel bookkeeping). */
function clearLoadedContent() {
    content.name = null;
    content.type = "html";
    resetHtml();
    resetPdf();
    resetCode();
    content.url = null;
    content.loading = false;
    content.error = null;
}

function clampWidth(w: number): number {
    const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_WIDTH_FRAC));
    return Math.min(max, Math.max(MIN_WIDTH, w));
}

/** The PAGE INNER div = the page__'s child that directly contains chat_. */
function findPageInner(): HTMLElement | null {
    const page = document.querySelector<HTMLElement>('div[class*="page_"]');
    if (!page) return null;
    for (const child of Array.from(page.children)) {
        const el = child as HTMLElement;
        if (el.querySelector(':scope > div[class*="chat_"]')) return el;
    }
    const chat = page.querySelector<HTMLElement>('div[class*="chat_"]');
    if (chat) {
        let el: HTMLElement | null = chat;
        while (el && el.parentElement !== page) el = el.parentElement;
        if (el) return el;
    }
    return null;
}

/** The chat_ element (our in-flow sibling) inside the page inner div. */
function findChat(inner: HTMLElement): HTMLElement | null {
    return inner.querySelector<HTMLElement>(':scope > div[class*="chat_"]');
}

// The exclusive right slot (server member list / DM user-profile sidebar /
// native thread conversation sidebar) is hidden PREEMPTIVELY by CSS while the
// panel is open (see applyOpenState + style.css `html.dockview-open`), so it no
// longer needs to be located in JS — the stylesheet matches it by stable
// selector and hides it from its first paint (no flash on mount), and a sidebar
// Discord swaps out can't get stuck hidden. The page-inner is tagged
// `dockview-page-inner` (in applyOpenState) so the thread-sidebar rule can scope
// to its direct children without ever matching our own #dockview-root host.

// ---------------------------------------------------------------------------
// Body renderers (content-type router targets)
// ---------------------------------------------------------------------------

/** The HTML/artifact body: the existing nonce-stamped interactive iframe. */
function renderHtmlBody() {
    return React.createElement("iframe", {
        key: content.seq,
        className: "dockview-frame",
        srcDoc: content.frameHtml,
        sandbox: "allow-scripts allow-same-origin"
    });
}

/** The PDF body: a scrollable column of page wrappers (canvas + selectable text
 *  layer) rendered by pdf.js, with page navigation, fit-to-width zoom and
 *  an in-panel find. The body element (.dockview-body) owns the scroll; this
 *  container lays the pages out and the scroll listener keeps the current-page
 *  indicator in sync. Re-render (zoom / resize) is debounced and DPR-aware. */
function PdfBody() {
    const { useRef, useEffect } = React;
    const containerRef = useRef(null as HTMLDivElement | null);
    const passRef = useRef(0);
    const lastWidthRef = useRef(0);
    // per-page DOM + geometry, indexed [0..numPages-1]
    const pagesRef = useRef([] as Array<{
        wrap: HTMLDivElement;
        canvas: HTMLCanvasElement;
        textDiv: HTMLDivElement;
        baseW: number; // unscaled page width (pdf units @ scale 1)
        baseH: number;
    }>);
    // The UNIFORM document scale the pages are CURRENTLY rastered at. The page
    // boxes are sized via the container's `--scale-factor`; live resize just
    // re-points that variable (renderScale × dragRatio) so the whole column
    // reflows + visually scales in one shot, then drag-end re-rasters crisp.
    const renderScaleRef = useRef(1);
    // flat list of match locations: {pageIdx, spanEls}
    const matchesRef = useRef([] as Array<{ page: number; els: HTMLElement[] }>);

    // The scrollable ancestor (.dockview-body) so we can scroll pages into view.
    const scroller = () => containerRef.current?.closest(".dockview-body") as HTMLElement | null;

    useEffect(() => {
        const host = containerRef.current;
        if (!host) return;

        // Available content width = the scroll viewport width MINUS a small,
        // CONSTANT side inset. We read it from .dockview-body (the scroller),
        // which has scrollbar-gutter:stable so its clientWidth is the SAME
        // whether or not a scrollbar is showing — that stability is what makes
        // every page fit identically (the old code read host.clientWidth, which
        // jumped by the scrollbar width as pages appeared mid-render, so pages
        // rasterised before vs. after the scrollbar got different widths).
        const PDF_SIDE_INSET = 16;
        const availWidth = (): number => {
            const sc = scroller();
            return Math.max(1, (sc?.clientWidth || host.clientWidth || state.width) - PDF_SIDE_INSET);
        };

        const renderAll = async () => {
            const doc = content.pdf.doc;
            if (!doc) return;
            const myPass = ++passRef.current;
            const docToken = content.pdf.renderToken;

            const dpr = window.devicePixelRatio || 1;
            // Snapshot the fit geometry ONCE per pass so every page uses the
            // exact same target — pages can no longer drift in width.
            const sc = scroller();
            const availW = availWidth();
            const availH = Math.max(1, (sc?.clientHeight || 600) - PDF_SIDE_INSET);
            lastWidthRef.current = host.clientWidth;

            // Canonical pdf.js continuous-column model: a SINGLE uniform document
            // scale drives every page. We pick it from the WIDEST page so a
            // fit-width column never overflows, and pages keep their relative
            // sizes (no per-page stretch). That single scale also lets a live
            // resize be one container `--scale-factor` update (no per-page math),
            // which is what keeps the column perfectly connected while dragging.
            let refW = 0;
            let refH = 0; // height of the widest page, for "page" fit
            for (let n = 1; n <= doc.numPages; n++) {
                if (myPass !== passRef.current || docToken !== content.pdf.renderToken) return;
                let p: any;
                try { p = await doc.getPage(n); } catch { return; }
                const vp = p.getViewport({ scale: 1 });
                if (vp.width > refW) { refW = vp.width; refH = vp.height; }
            }
            if (!refW) return;
            const fitScale = pdfView.fit === "page"
                ? Math.min(availW / refW, availH / refH)
                : availW / refW;
            const docScale = fitScale * pdfView.zoom;
            renderScaleRef.current = docScale;
            // Drive the page-box + canvas + text-layer geometry off ONE variable
            // on the container (exactly how pdf.js sizes its pages). Clearing any
            // leftover live-resize value here resets the column to crisp 1:1.
            host.style.setProperty("--scale-factor", String(docScale));

            // dropping the find results — spans get rebuilt below
            matchesRef.current = [];

            const built: typeof pagesRef.current = [];
            const frag = document.createDocumentFragment();
            for (let n = 1; n <= doc.numPages; n++) {
                if (myPass !== passRef.current || docToken !== content.pdf.renderToken) return;
                let page: any;
                try {
                    page = await doc.getPage(n);
                } catch {
                    return;
                }
                if (myPass !== passRef.current || docToken !== content.pdf.renderToken) return;

                const base = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: docScale });

                // Page box sized in CSS off the container's --scale-factor (the
                // canonical pdf.js setLayerDimensions recipe): width/height are
                // `--scale-factor × <pdf unit>px`. Because the box tracks the
                // variable, a live-resize that re-points --scale-factor reflows
                // EVERY page in the column at once (gaps stay 8px, pages never
                // overlap or detach). `round(down, …, 1px)` snaps to whole pixels
                // like pdf.js so seams between canvas + box don't shimmer.
                const wrap = document.createElement("div");
                wrap.className = "dockview-pdf-page-wrap";
                wrap.style.width = `round(down, var(--scale-factor) * ${base.width}px, 1px)`;
                wrap.style.height = `round(down, var(--scale-factor) * ${base.height}px, 1px)`;
                wrap.setAttribute("data-page", String(n));

                // Canvas: backing store rastered at docScale×dpr (crisp), but its
                // CSS box fills the wrapper (100%/100%) so it STRETCHES with the
                // variable during a live resize — instant GPU-cheap visual scale,
                // exactly like pdf.js's CSS-zoom-then-redraw.
                const canvas = document.createElement("canvas");
                canvas.className = "dockview-pdf-page";
                canvas.width = Math.floor(viewport.width * dpr);
                canvas.height = Math.floor(viewport.height * dpr);
                const ctx = canvas.getContext("2d");
                if (!ctx) continue;
                wrap.appendChild(canvas);

                // Text layer overlay: pdf.js positions its (transparent) span
                // divs in % of the box using --total-scale-factor. It inherits
                // --scale-factor from the container; mirror it to
                // --total-scale-factor so the text tracks the same live variable
                // and stays glued over the canvas through resize/zoom.
                const textDiv = document.createElement("div");
                textDiv.className = "textLayer";
                textDiv.style.setProperty("--total-scale-factor", "var(--scale-factor)");
                wrap.appendChild(textDiv);

                frag.appendChild(wrap);
                if (n === 1) host.replaceChildren(frag);
                else host.appendChild(wrap);

                built.push({ wrap, canvas, textDiv, baseW: base.width, baseH: base.height });

                try {
                    await page.render({
                        canvasContext: ctx,
                        viewport,
                        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
                    }).promise;
                } catch {
                    return; // render cancelled
                }

                // Text layer (selectable). Best-effort: never let a text-layer
                // failure abort the canvas render loop.
                try {
                    const textContent = await page.getTextContent();
                    if (myPass !== passRef.current || docToken !== content.pdf.renderToken) return;
                    const tl = new (pdfjsLib as any).TextLayer({
                        textContentSource: textContent,
                        container: textDiv,
                        viewport
                    });
                    await tl.render();
                } catch {
                    /* text layer optional */
                }
            }
            if (myPass !== passRef.current || docToken !== content.pdf.renderToken) return;
            pagesRef.current = built;
            // re-apply an active find against the freshly built spans
            if (pdfView.findOpen && pdfView.findQuery) runFind(pdfView.findQuery, false);
            updateCurrentPage();
        };

        // --- current-page detection (which page dominates the viewport) -------
        const updateCurrentPage = () => {
            const sc = scroller();
            const pages = pagesRef.current;
            if (!sc || !pages.length) return;
            const mid = sc.scrollTop + sc.clientHeight / 2;
            let best = 1;
            for (let i = 0; i < pages.length; i++) {
                const top = pages[i].wrap.offsetTop;
                const bot = top + pages[i].wrap.offsetHeight;
                if (mid >= top && mid < bot) { best = i + 1; break; }
                if (mid >= bot) best = i + 1;
            }
            if (best !== pdfView.page) {
                pdfView.page = best;
                forceRender?.();
            }
        };

        // --- find -------------------------------------------------------------
        const clearHighlights = () => {
            host.querySelectorAll(".dockview-pdf-match,.dockview-pdf-match-active").forEach(el => {
                el.classList.remove("dockview-pdf-match", "dockview-pdf-match-active");
            });
        };
        const runFind = (query: string, jump: boolean) => {
            clearHighlights();
            matchesRef.current = [];
            pdfView.findMatches = 0;
            pdfView.findActive = 0;
            const q = query.trim().toLowerCase();
            if (!q) { forceRender?.(); return; }
            const pages = pagesRef.current;
            for (let i = 0; i < pages.length; i++) {
                const spans = Array.from(pages[i].textDiv.querySelectorAll("span")) as HTMLElement[];
                for (const span of spans) {
                    const t = (span.textContent || "").toLowerCase();
                    if (t && t.includes(q)) {
                        span.classList.add("dockview-pdf-match");
                        matchesRef.current.push({ page: i + 1, els: [span] });
                    }
                }
            }
            pdfView.findMatches = matchesRef.current.length;
            if (pdfView.findMatches > 0) {
                pdfView.findActive = 1;
                if (jump) focusMatch(0);
                else highlightActive();
            }
            forceRender?.();
        };
        const highlightActive = () => {
            host.querySelectorAll(".dockview-pdf-match-active").forEach(el => el.classList.remove("dockview-pdf-match-active"));
            const m = matchesRef.current[pdfView.findActive - 1];
            if (m) m.els.forEach(el => el.classList.add("dockview-pdf-match-active"));
        };
        const focusMatch = (idx: number) => {
            const m = matchesRef.current[idx];
            if (!m) return;
            pdfView.findActive = idx + 1;
            highlightActive();
            m.els[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
            forceRender?.();
        };

        // --- scroll a given (1-based) page to the top of the viewport ---------
        const scrollToPage = (n: number) => {
            const pages = pagesRef.current;
            const idx = Math.max(1, Math.min(pages.length, n)) - 1;
            const p = pages[idx];
            const sc = scroller();
            if (!p || !sc) return;
            sc.scrollTo({ top: Math.max(0, p.wrap.offsetTop - 8), behavior: "smooth" });
            pdfView.page = idx + 1;
            forceRender?.();
        };

        // Expose controls to the toolbar + keyboard while this PDF is mounted.
        const ctrls: PdfControls = {
            goToPage: (n: number) => scrollToPage(n),
            prevPage: () => scrollToPage(pdfView.page - 1),
            nextPage: () => scrollToPage(pdfView.page + 1),
            zoomIn: () => { pdfView.zoom = Math.min(PDF_MAX_ZOOM, pdfView.zoom * 1.25); scheduleRerender(); forceRender?.(); },
            zoomOut: () => { pdfView.zoom = Math.max(PDF_MIN_ZOOM, pdfView.zoom / 1.25); scheduleRerender(); forceRender?.(); },
            setFit: (f: PdfFit) => { if (pdfView.fit !== f) { pdfView.fit = f; pdfView.zoom = 1; scheduleRerender(); forceRender?.(); } },
            fitWidth: () => { if (pdfView.fit !== "width" || pdfView.zoom !== 1) { pdfView.fit = "width"; pdfView.zoom = 1; scheduleRerender(); forceRender?.(); } },
            toggleFind: () => { pdfView.findOpen = !pdfView.findOpen; if (!pdfView.findOpen) { clearHighlights(); pdfView.findMatches = 0; pdfView.findActive = 0; pdfView.findQuery = ""; } forceRender?.(); },
            setFindQuery: (qq: string) => { pdfView.findQuery = qq; runFind(qq, true); },
            findNext: () => { if (!pdfView.findMatches) return; focusMatch(pdfView.findActive % pdfView.findMatches); },
            findPrev: () => { if (!pdfView.findMatches) return; focusMatch((pdfView.findActive - 2 + pdfView.findMatches) % pdfView.findMatches); },
            // Live resize (the pdf.js "CSS zoom first, redraw after" pattern):
            // re-point the container's --scale-factor to renderScale × ratio. The
            // page boxes (sized in that variable) reflow as a connected column and
            // every canvas bitmap stretches with its box — instant, GPU-composited,
            // gaps stay 8px, pages never detach. In "width" fit the render scale is
            // proportional to width so this faithfully previews the new raster; in
            // "page" fit the height also bounds the scale, so a width ratio would
            // over-scale — we hold scale there (drag-end re-raster corrects).
            liveScale: (ratio: number) => {
                if (!Number.isFinite(ratio) || ratio <= 0) return;
                const host = containerRef.current;
                if (!host) return;
                const r = pdfView.fit === "page" ? 1 : ratio;
                host.style.setProperty("--scale-factor", String(renderScaleRef.current * r));
            },
            endLiveScale: () => {
                // Re-raster crisply at the final width. renderAll resets
                // --scale-factor to the new true docScale, so the live-stretched
                // bitmaps are replaced by sharp ones with no snap-back gap.
                if (content.pdf.doc) renderAll();
            }
        };
        pdfControls = ctrls;

        // zoom re-render is debounced (DPR-crisp re-raster of every page)
        let zoomDebounce: any = null;
        const scheduleRerender = () => {
            clearTimeout(zoomDebounce);
            zoomDebounce = setTimeout(() => { if (content.pdf.doc) renderAll(); }, 120);
        };

        renderAll();

        // scroll -> current-page indicator (throttled via rAF)
        let scrollRaf = 0;
        const sc = scroller();
        const onScroll = () => {
            if (scrollRaf) return;
            scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateCurrentPage(); });
        };
        sc?.addEventListener("scroll", onScroll, { passive: true });

        let roDebounce: any = null;
        const ro = new ResizeObserver(() => {
            clearTimeout(roDebounce);
            roDebounce = setTimeout(() => {
                if (!content.pdf.doc) return;
                // A resize DRAG drives its own live preview + drag-end re-raster
                // (endLiveScale); re-rastering here mid-drag would fight that and
                // jump. Only handle width changes from OTHER sources (zoom in the
                // toolbar already re-renders; this catches e.g. window resize).
                if (resizeDragging) return;
                if (Math.abs(host.clientWidth - lastWidthRef.current) < 8) return;
                renderAll();
            }, 200);
        });
        ro.observe(host);

        return () => {
            passRef.current++; // invalidate the in-flight pass
            clearTimeout(roDebounce);
            clearTimeout(zoomDebounce);
            if (scrollRaf) cancelAnimationFrame(scrollRaf);
            sc?.removeEventListener("scroll", onScroll);
            ro.disconnect();
            if (pdfControls === ctrls) pdfControls = null;
        };
    }, [content.pdf.renderToken, content.seq]);

    return React.createElement("div", {
        key: content.seq,
        ref: containerRef,
        className: "dockview-pdf-container"
    });
}

/** The PDF FIND bar: a small floating overlay (top-right of the PDF body) with a
 *  query input, a match counter and prev/next. Discord may intercept the global
 *  Ctrl+F, so this is our own UI (toggled from the toolbar's find button or the
 *  keyboard's Ctrl+F when the panel is the active surface). Best-effort match:
 *  highlights whole text-layer spans that contain the query. */
function PdfFindBar() {
    const { useRef, useEffect } = React;
    const inputRef = useRef(null as HTMLInputElement | null);
    // focus the input when the bar opens
    useEffect(() => { inputRef.current?.focus(); }, []);
    const counter = pdfView.findMatches > 0
        ? `${pdfView.findActive}/${pdfView.findMatches}`
        : (pdfView.findQuery ? "0/0" : "");
    return React.createElement(
        "div",
        { className: "dockview-pdf-find" },
        React.createElement("input", {
            ref: inputRef,
            className: "dockview-pdf-find-input",
            type: "text",
            placeholder: "Find in document",
            "aria-label": "Find in document",
            value: pdfView.findQuery,
            onChange: (e: any) => pdfControls?.setFindQuery(e.target.value),
            onKeyDown: (e: any) => {
                e.stopPropagation();
                if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) pdfControls?.findPrev(); else pdfControls?.findNext(); }
                else if (e.key === "Escape") { e.preventDefault(); pdfControls?.toggleFind(); }
            }
        }),
        React.createElement("span", { className: "dockview-pdf-find-count" }, counter),
        toolBtn("find-prev", "Previous match (Shift+Enter)",
            "M15.3 5.3a1 1 0 0 1 0 1.4L10 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0Z",
            () => pdfControls?.findPrev()),
        toolBtn("find-next", "Next match (Enter)",
            "M8.7 5.3a1 1 0 0 0 0 1.4L14 12l-5.3 5.3a1 1 0 0 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z",
            () => pdfControls?.findNext()),
        toolBtn("find-close", "Close find (Esc)",
            "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z",
            () => pdfControls?.toggleFind())
    );
}

/** The IMAGE body: a centered, fit(contain) <img> with zoom + pan, modelled on
 *  Discord's lightbox / a browser image viewer.
 *   - scale 1 = fit (CSS object-fit:contain keeps the whole image visible).
 *   - wheel = zoom toward the cursor; double-click = toggle fit <-> 100% (real
 *     pixels); drag = pan when zoomed past fit. The header toolbar +/-/reset and
 *     the keyboard (+/-/0) drive the same state via `imgControls`. */
function ImageBody() {
    const { useRef, useEffect, useState } = React;
    const wrapRef = useRef(null as HTMLDivElement | null);
    const imgRef = useRef(null as HTMLImageElement | null);
    const [, bump] = useState(0);
    // Re-render the WHOLE panel (not just this body) so the header toolbar's
    // zoom % readout stays in sync. forceRender bumps DockPanel's state; React
    // reconciles ImageBody by type (key=content.seq unchanged) so our refs +
    // view-state survive. Fall back to local bump if the panel isn't mounted.
    const rerender = () => (forceRender ? forceRender() : bump((n: number) => n + 1));

    // Clamp pan so the (scaled) image can't be dragged entirely out of view.
    const clampPan = () => {
        const wrap = wrapRef.current;
        if (!wrap || !imgView.natW || !imgView.natH) return;
        const cw = wrap.clientWidth;
        const ch = wrap.clientHeight;
        if (!cw || !ch) return;
        // fitted (scale 1) display size with object-fit: contain.
        const fitScale = Math.min(cw / imgView.natW, ch / imgView.natH, 1);
        const dispW = imgView.natW * fitScale * imgView.scale;
        const dispH = imgView.natH * fitScale * imgView.scale;
        const maxX = Math.max(0, (dispW - cw) / 2);
        const maxY = Math.max(0, (dispH - ch) / 2);
        imgView.tx = Math.max(-maxX, Math.min(maxX, imgView.tx));
        imgView.ty = Math.max(-maxY, Math.min(maxY, imgView.ty));
    };

    const applyScale = (next: number, originX?: number, originY?: number) => {
        const wrap = wrapRef.current;
        const prev = imgView.scale;
        next = Math.max(IMG_MIN_SCALE, Math.min(IMG_MAX_SCALE, next));
        if (next === prev) return;
        // Zoom toward a focal point (cursor) so the pixel under the cursor stays
        // put. Origin is relative to the wrap centre.
        if (wrap && originX != null && originY != null) {
            const cw = wrap.clientWidth;
            const ch = wrap.clientHeight;
            const ox = originX - cw / 2;
            const oy = originY - ch / 2;
            const ratio = next / prev;
            imgView.tx = ox - (ox - imgView.tx) * ratio;
            imgView.ty = oy - (oy - imgView.ty) * ratio;
        }
        imgView.scale = next;
        if (next === 1) {
            imgView.tx = 0;
            imgView.ty = 0;
        }
        clampPan();
        rerender();
    };

    // Expose controls to the toolbar + keyboard while this image is mounted.
    useEffect(() => {
        const ctrls: ImgControls = {
            zoomIn: () => applyScale(imgView.scale * 1.3),
            zoomOut: () => applyScale(imgView.scale / 1.3),
            reset: () => {
                resetImgView();
                rerender();
            },
            getScale: () => imgView.scale
        };
        imgControls = ctrls;
        return () => {
            if (imgControls === ctrls) imgControls = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Wheel zoom (cursor-focal). Bound natively (non-passive) so preventDefault
    // works and the panel body doesn't also scroll.
    useEffect(() => {
        const wrap = wrapRef.current;
        if (!wrap) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = wrap.getBoundingClientRect();
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            applyScale(imgView.scale * factor, e.clientX - rect.left, e.clientY - rect.top);
        };
        wrap.addEventListener("wheel", onWheel, { passive: false });
        return () => wrap.removeEventListener("wheel", onWheel);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Drag to pan (only meaningful when zoomed past fit).
    const drag = useRef({ on: false, x: 0, y: 0, tx: 0, ty: 0 });
    const onPointerDown = (e: any) => {
        if (imgView.scale <= 1) return;
        if (e.button != null && e.button !== 0) return;
        drag.current = { on: true, x: e.clientX, y: e.clientY, tx: imgView.tx, ty: imgView.ty };
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    };
    const onPointerMove = (e: any) => {
        if (!drag.current.on) return;
        imgView.tx = drag.current.tx + (e.clientX - drag.current.x);
        imgView.ty = drag.current.ty + (e.clientY - drag.current.y);
        clampPan();
        rerender();
    };
    const endDrag = (e: any) => {
        if (!drag.current.on) return;
        drag.current.on = false;
        try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    };

    // Double-click toggles fit <-> 100% (real pixels) at the cursor.
    const onDoubleClick = (e: any) => {
        const wrap = wrapRef.current;
        if (imgView.scale === 1) {
            // go to 100% real pixels: scale relative to the current fit scale.
            if (wrap && imgView.natW && imgView.natH) {
                const cw = wrap.clientWidth;
                const ch = wrap.clientHeight;
                const fitScale = Math.min(cw / imgView.natW, ch / imgView.natH, 1);
                const target = fitScale > 0 ? 1 / fitScale : 1;
                const rect = wrap.getBoundingClientRect();
                applyScale(target, e.clientX - rect.left, e.clientY - rect.top);
            } else {
                applyScale(2);
            }
        } else {
            resetImgView();
            rerender();
        }
    };

    const onImgLoad = () => {
        const img = imgRef.current;
        if (img) {
            imgView.natW = img.naturalWidth;
            imgView.natH = img.naturalHeight;
        }
        rerender();
    };

    const zoomed = imgView.scale > 1;
    return React.createElement(
        "div",
        {
            key: content.seq,
            ref: wrapRef,
            className: "dockview-img-wrap" + (zoomed ? " dockview-img-zoomed" : ""),
            tabIndex: 0,
            onPointerDown,
            onPointerMove,
            onPointerUp: endDrag,
            onPointerLeave: endDrag,
            onDoubleClick
        },
        React.createElement("img", {
            ref: imgRef,
            className: "dockview-img",
            src: content.url || "",
            alt: content.name || "image",
            draggable: false,
            onLoad: onImgLoad,
            style: {
                transform: `translate(${imgView.tx}px, ${imgView.ty}px) scale(${imgView.scale})`
            }
        })
    );
}

/** The CODE/TEXT body: a scrollable, selectable <pre><code> with a non-
 *  selectable line-number gutter (so copy yields code only) + a word-wrap
 *  toggle. Highlight HTML is unchanged; we render a parallel gutter column. */
function renderCodeBody() {
    const code = content.code || "";
    let html: string;
    let gutter: string;
    if (codeRenderCache && codeRenderCache.seq === content.seq) {
        html = codeRenderCache.html;
        gutter = codeRenderCache.gutter;
    } else {
        html = highlightCode(code, content.codeLang);
        // line count (don't count a single trailing newline as an extra blank line)
        const bodyText = code.endsWith("\n") ? code.slice(0, -1) : code;
        const lineCount = bodyText.length ? bodyText.split("\n").length : 1;
        gutter = "";
        for (let i = 1; i <= lineCount; i++) gutter += i + "\n";
        codeRenderCache = { seq: content.seq, html, gutter };
    }

    return React.createElement(
        "div",
        {
            key: content.seq,
            className: "dockview-code-scroll" + (codeView.wrap ? " dockview-code-wrap" : "")
        },
        // Gutter: aria-hidden + user-select:none (CSS) so selecting/copying the
        // code never picks up the line numbers.
        React.createElement("pre", {
            className: "dockview-code-gutter",
            "aria-hidden": true,
            children: gutter
        }),
        React.createElement(
            "pre",
            { className: "dockview-code-pre" },
            React.createElement("code", {
                className: `dockview-code hljs language-${content.codeLang}`,
                dangerouslySetInnerHTML: { __html: html }
            })
        )
    );
}

/** Body dispatcher: shared loading / error / placeholder, then route. */
function renderBody() {
    if (content.name == null) {
        return React.createElement(
            "div",
            { className: "dockview-placeholder" },
            "Empty dock panel"
        );
    }
    if (content.error != null) {
        return React.createElement(
            "div",
            { className: "dockview-status dockview-error" },
            "Failed to load: " + content.error
        );
    }
    if (content.type === "pdf") {
        if (content.loading || content.pdf.doc == null) {
            return React.createElement("div", { className: "dockview-status" }, "Loading…");
        }
        return React.createElement(PdfBody, null);
    }
    if (content.type === "image") {
        return React.createElement(ImageBody, null);
    }
    if (content.type === "code") {
        if (content.loading || content.code == null) {
            return React.createElement("div", { className: "dockview-status" }, "Loading…");
        }
        return renderCodeBody();
    }
    // markdown shares the html (frameHtml iframe) path; fall through.
    if (content.loading || content.frameHtml == null) {
        return React.createElement("div", { className: "dockview-status" }, "Loading…");
    }
    return renderHtmlBody();
}

// ---------------------------------------------------------------------------
// Content-type toolbar — a thin control strip under the header. Shows only the
// controls relevant to the current content type (image = zoom +/-/reset + %;
// code = language label, word-wrap toggle, copy). Built to be extended (PDF
// page nav lands here in pass 2). Uses small native-ish buttons.
// ---------------------------------------------------------------------------

/** A small SVG toolbar button (square, hover bg) — shared by all tool types. */
function toolBtn(key: string, label: string, path: string, onClick: () => void, active = false) {
    return React.createElement(
        "button",
        {
            key,
            type: "button",
            className: "dockview-tool-btn" + (active ? " dockview-tool-btn-active" : ""),
            "aria-label": label,
            title: label,
            onClick
        },
        React.createElement(
            "svg",
            { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: path })
        )
    );
}

function DockToolbar() {
    const { useState } = React;
    const [copied, setCopied] = useState(false);
    const [pageInput, setPageInput] = useState("");

    if (content.type === "pdf") {
        if (content.loading || content.error || content.pdf.doc == null) return null;
        const pct = Math.round(pdfView.zoom * 100);
        const commitPage = () => {
            const n = parseInt(pageInput, 10);
            if (!isNaN(n)) pdfControls?.goToPage(n);
            setPageInput("");
        };
        return React.createElement(
            "div",
            { className: "dockview-toolbar dockview-toolbar-pdf" },
            // LEFT: page navigation + indicator + jump input
            React.createElement(
                "div",
                { className: "dockview-tool-group" },
                toolBtn("pdf-prev", "Previous page (←)",
                    "M15.3 5.3a1 1 0 0 1 0 1.4L10 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0Z",
                    () => pdfControls?.prevPage()),
                React.createElement(
                    "span",
                    { className: "dockview-tool-pageind", title: "Current page / total" },
                    React.createElement("input", {
                        className: "dockview-tool-pageinput",
                        type: "text",
                        inputMode: "numeric",
                        "aria-label": "Go to page",
                        title: "Type a page number, Enter to jump",
                        value: pageInput,
                        placeholder: String(pdfView.page),
                        onChange: (e: any) => setPageInput(e.target.value.replace(/[^0-9]/g, "")),
                        onKeyDown: (e: any) => {
                            if (e.key === "Enter") { e.preventDefault(); commitPage(); }
                            e.stopPropagation();
                        },
                        onBlur: () => { if (pageInput) commitPage(); }
                    }),
                    React.createElement("span", { className: "dockview-tool-pagetotal" }, " / " + pdfView.total)
                ),
                toolBtn("pdf-next", "Next page (→)",
                    "M8.7 5.3a1 1 0 0 0 0 1.4L14 12l-5.3 5.3a1 1 0 0 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z",
                    () => pdfControls?.nextPage())
            ),
            // RIGHT: zoom -/%/+ , fit-to-width (reset zoom), find toggle
            React.createElement(
                "div",
                { className: "dockview-tool-group" },
                toolBtn("pdf-zoom-out", "Zoom out (-)",
                    "M19 11a1 1 0 0 1 0 2H5a1 1 0 1 1 0-2h14Z",
                    () => pdfControls?.zoomOut()),
                React.createElement("span", { className: "dockview-tool-pct", title: "Zoom level" }, pct + "%"),
                toolBtn("pdf-zoom-in", "Zoom in (+)",
                    "M13 5a1 1 0 1 0-2 0v6H5a1 1 0 1 0 0 2h6v6a1 1 0 1 0 2 0v-6h6a1 1 0 1 0 0-2h-6V5Z",
                    () => pdfControls?.zoomIn()),
                // Reset zoom to fit the panel width (100%). Visible effect after
                // any zoom; greyed/active when already at fit. Replaces the old
                // fit-width + fit-page toggle pair (fit-page was identical to
                // fit-width in this tall, narrow docked panel, so it did nothing).
                toolBtn("pdf-fit-width", pct === 100 ? "Fit to width (100%)" : "Reset zoom — fit to width",
                    "M4 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1Zm16 0a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1ZM8.7 8.3a1 1 0 0 0-1.4 1.4l.29.3H7a1 1 0 0 0 0 2h.59l-.3.3a1 1 0 1 0 1.42 1.4l2-2a1 1 0 0 0 0-1.4l-2-2Zm6.6 0a1 1 0 0 1 1.4 1.4l-.29.3H17a1 1 0 1 1 0 2h-.59l.3.3a1 1 0 0 1-1.42 1.4l-2-2a1 1 0 0 1 0-1.4l2-2Z",
                    () => pdfControls?.fitWidth(), pct === 100),
                toolBtn("pdf-find", "Find (Ctrl+F)",
                    "M10 4a6 6 0 1 0 3.71 10.71l4.29 4.3a1 1 0 0 0 1.42-1.42l-4.3-4.29A6 6 0 0 0 10 4Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z",
                    () => pdfControls?.toggleFind(), pdfView.findOpen)
            )
        );
    }

    if (content.type === "image") {
        if (content.loading || content.error || !content.url) return null;
        const pct = Math.round(imgView.scale * 100);
        return React.createElement(
            "div",
            { className: "dockview-toolbar" },
            React.createElement(
                "div",
                { className: "dockview-tool-group" },
                toolBtn("zoom-out", "Zoom out (-)",
                    "M19 11a1 1 0 0 1 0 2H5a1 1 0 1 1 0-2h14Z",
                    () => imgControls?.zoomOut()),
                React.createElement("span", { className: "dockview-tool-pct", title: "Zoom level" }, pct + "%"),
                toolBtn("zoom-in", "Zoom in (+)",
                    "M13 5a1 1 0 1 0-2 0v6H5a1 1 0 1 0 0 2h6v6a1 1 0 1 0 2 0v-6h6a1 1 0 1 0 0-2h-6V5Z",
                    () => imgControls?.zoomIn()),
                toolBtn("zoom-reset", "Reset zoom (0)",
                    "M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5 1 1 0 1 0-2 0 7 7 0 1 0 7-7Z",
                    () => imgControls?.reset())
            )
        );
    }

    if (content.type === "code") {
        if (content.loading || content.error || content.code == null) return null;
        const copy = () => {
            const text = content.code || "";
            const done = () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
            };
            try {
                if (navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
                } else {
                    fallbackCopy(text, done);
                }
            } catch {
                fallbackCopy(text, done);
            }
        };
        return React.createElement(
            "div",
            { className: "dockview-toolbar" },
            React.createElement("span", { className: "dockview-tool-lang", title: "Detected language" }, content.codeLang),
            React.createElement(
                "div",
                { className: "dockview-tool-group" },
                toolBtn("wrap", codeView.wrap ? "Disable word wrap" : "Enable word wrap",
                    "M4 6a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1Zm0 5a1 1 0 0 1 1-1h12a3 3 0 1 1 0 6h-1.59l.3.3a1 1 0 1 1-1.42 1.4l-2-2a1 1 0 0 1 0-1.4l2-2a1 1 0 0 1 1.42 1.4l-.3.3H17a1 1 0 1 0 0-2H5a1 1 0 0 1-1-1Zm0 6a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1Z",
                    () => { codeView.wrap = !codeView.wrap; forceRender?.(); },
                    codeView.wrap),
                React.createElement(
                    "button",
                    {
                        key: "copy",
                        type: "button",
                        className: "dockview-tool-btn dockview-tool-copy" + (copied ? " dockview-tool-copied" : ""),
                        "aria-label": "Copy code",
                        title: "Copy code",
                        onClick: copy
                    },
                    React.createElement(
                        "svg",
                        { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                        copied
                            ? React.createElement("path", { fill: "currentColor", d: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" })
                            : React.createElement("path", { fill: "currentColor", d: "M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2Zm2 0h5a2 2 0 0 1 2 2v5h2V5h-9v2ZM6 9v9h9V9H6Z" })
                    ),
                    React.createElement("span", { className: "dockview-tool-copy-label" }, copied ? "Copied" : "Copy")
                )
            )
        );
    }

    return null;
}

/** Clipboard fallback for environments where navigator.clipboard is blocked. */
function fallbackCopy(text: string, done: () => void) {
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        done();
    } catch {
        /* ignore */
    }
}

// ---------------------------------------------------------------------------
// Header "⋯ more" context menu — Discord-native Menu (ContextMenuApi). Holds
// only SECONDARY actions; the per-type toolbar already exposes zoom/page/etc.
// ---------------------------------------------------------------------------
function DockMoreMenu() {
    const url = content.url;
    const name = content.name as string | null;
    const type = content.type;
    const isHtml = type === "html";
    const isImage = type === "image";

    const items: any[] = [];

    // Open in new window: reuse the artifact popout for HTML, else a plain
    // window.open of the file url (PDF/image/code/markdown).
    items.push(React.createElement(Menu.MenuItem, {
        id: "dockview-more-popout",
        label: "새 창으로 열기",
        action: () => {
            if (isHtml && content.html != null) popoutArtifact();
            else if (url) window.open(absUrl(url), "_blank", "noopener,noreferrer");
        }
    }));

    if (url) {
        items.push(React.createElement(Menu.MenuItem, {
            id: "dockview-more-download",
            label: "다운로드",
            action: () => downloadUrl(url, name)
        }));
    }

    if (isImage && url) {
        items.push(React.createElement(Menu.MenuItem, {
            id: "dockview-more-copy-image",
            label: "이미지 복사",
            action: () => { copyImage(url); }
        }));
    }

    const linkGroup = url
        ? [
            React.createElement(Menu.MenuSeparator, { key: "sep" }),
            React.createElement(Menu.MenuGroup, { key: "link" },
                React.createElement(Menu.MenuItem, {
                    id: "dockview-more-copy-link",
                    label: "링크 복사",
                    action: () => copyText(absUrl(url))
                })
            )
        ]
        : [];

    return React.createElement(Menu.Menu, {
        navId: "dockview-more-menu",
        onClose: ContextMenuApi.closeContextMenu
    },
    React.createElement(Menu.MenuGroup, null, ...items),
    ...linkGroup
    );
}

// ---------------------------------------------------------------------------
// React panel — Discord's native thread-sidebar classes dress the card.
// ---------------------------------------------------------------------------
function DockPanel() {
    const { useState, useCallback, useEffect, useRef } = React;

    const [, bump] = useState(0);
    const rerender = useCallback(() => bump((n: number) => n + 1), []);
    useEffect(() => {
        forceRender = rerender;
        return () => {
            if (forceRender === rerender) forceRender = null;
        };
    }, [rerender]);

    const [width, setWidth] = useState(state.width);
    const resizing = useRef(false);

    useEffect(() => {
        state.width = width;
        lsSet(LS_WIDTH, String(Math.round(width)));
        applyOpenState();
    }, [width]);

    const onResizeStart = useCallback((e: any) => {
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        resizing.current = true;
        resizeDragging = true;
        const startX = e.clientX;
        const startWidth = state.width;
        // Width the rendered content currently assumes; the live PDF preview
        // scales by (newWidth / this). Use the clamped start width as the base.
        const baseWidth = clampWidth(startWidth);
        let liveScaled = false;

        const handle: HTMLElement | null = e.currentTarget || null;
        handle?.classList.add("dockview-resizing");

        const overlay = document.createElement("div");
        overlay.className = "dockview-drag-overlay";
        document.body.appendChild(overlay);

        // The drag is a PURE DOM operation, fully decoupled from React: every
        // pointermove records the latest pixel and a single rAF coalesces them
        // into one host-width write per frame. We deliberately do NOT touch React
        // state (no setWidth / forceRender) DURING the drag — a re-render would
        // re-run renderBody() and, for the code viewer, re-highlight the whole
        // file every frame (measured: ~30 full hljs passes / drag, multi-second
        // main-thread block). The content reflows purely from the host's CSS width
        // (iframe/code/image fill it; the PDF column reflows off --scale-factor),
        // so no render is needed to make the body follow the drag. We commit to
        // React ONCE on drag end (setWidth -> the [width] effect persists it).
        let pendingX = startX;
        let rafId = 0;
        const flush = () => {
            rafId = 0;
            if (!resizing.current) return;
            const delta = startX - pendingX; // drag left edge: leftward = wider
            const next = clampWidth(startWidth + delta);
            if (next !== state.width) {
                state.width = next;
                applyHostWidth(); // direct inline-style write, no React
            }
            // Instant feedback for the (debounced-re-raster) PDF view: scale the
            // already-painted pages so they track the drag with no blank/jump.
            // No-op for non-PDF content (pdfControls is null then).
            if (pdfControls) { pdfControls.liveScale(next / baseWidth); liveScaled = true; }
        };
        const onMove = (ev: MouseEvent) => {
            if (!resizing.current) return;
            pendingX = ev.clientX;
            if (!rafId) rafId = requestAnimationFrame(flush);
        };
        const onUp = () => {
            resizing.current = false;
            resizeDragging = false;
            if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            handle?.classList.remove("dockview-resizing");
            overlay.remove();
            // Make sure the host reflects the final pointer position, then sync
            // React's width state ONCE (its [width] effect persists to LS).
            const delta = startX - pendingX;
            const final = clampWidth(startWidth + delta);
            state.width = final;
            applyHostWidth();
            setWidth(final);
            // Drag ended: re-raster the PDF crisply at the final width (replaces
            // the CSS-scaled preview with no snap-back gap).
            if (liveScaled && pdfControls) pdfControls.endLiveScale();
        };
        document.body.style.cursor = "ew-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    }, []);

    const close = useCallback(() => {
        state.open = false;
        lsSet(LS_OPEN, "0");
        saveCurrentChannelState();
        applyOpenState();
        forceRender?.();
    }, []);

    const hasContent = content.name != null;
    const title = hasContent ? (content.name as string) : "DockView";

    const headerBtn = (
        key: string,
        label: string,
        titleAttr: string,
        path: string,
        onClick: (e: any) => void,
        extraCls = ""
    ) =>
        React.createElement(
            "div",
            {
                key,
                className: `${CLS.iconWrapper} ${CLS.clickable} ${extraCls}`.trim(),
                role: "button",
                tabIndex: 0,
                "aria-label": label,
                title: titleAttr,
                onClick
            },
            React.createElement(
                "svg",
                { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                React.createElement("path", { fill: "currentColor", d: path })
            )
        );

    const popoutBtn = hasContent && content.type === "html" && content.html != null
        ? headerBtn(
            "popout",
            "Open in new window",
            "Open in new window",
            "M10 5a1 1 0 0 0 0 2h5.59l-8.3 8.3a1 1 0 1 0 1.42 1.4l8.29-8.29V14a1 1 0 1 0 2 0V6a1 1 0 0 0-1-1h-8Z M5 8a3 3 0 0 1 3-3h2a1 1 0 1 1 0 2H8a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2a1 1 0 1 1 2 0v2a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8Z",
            () => popoutArtifact(),
            "dockview-popout"
        )
        : null;

    // "⋯" more-actions button (left of close): opens a Discord-native context
    // menu with secondary actions (popout / download / copy link / copy image).
    const moreBtn = hasContent
        ? headerBtn(
            "more",
            "More",
            "더 보기",
            "M7 12.001C7 13.105 6.105 14 5 14C3.895 14 3 13.105 3 12.001C3 10.896 3.895 10.001 5 10.001C6.105 10.001 7 10.896 7 12.001ZM14 12.001C14 13.105 13.105 14 12 14C10.895 14 10 13.105 10 12.001C10 10.896 10.895 10.001 12 10.001C13.105 10.001 14 10.896 14 12.001ZM19 14C20.105 14 21 13.105 21 12.001C21 10.896 20.105 10.001 19 10.001C17.895 10.001 17 10.896 17 12.001C17 13.105 17.895 14 19 14Z",
            (e: any) => ContextMenuApi.openContextMenu(e, () => React.createElement(DockMoreMenu)),
            "dockview-more"
        )
        : null;

    const closeBtn = headerBtn(
        "close",
        "Close",
        "Close (Ctrl+Alt+P)",
        "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z",
        close,
        "dockview-close"
    );

    return React.createElement(
        "div",
        {
            className: `${CLS.wrapper} dockview-wrapper`,
            onMouseEnter: () => { hostHovered = true; },
            onMouseLeave: () => { hostHovered = false; }
        },
        React.createElement("div", {
            className: `${CLS.resizeHandle} dockview-resize`,
            onMouseDown: onResizeStart
        }),
        React.createElement(
            "div",
            { className: `${CLS.card} dockview-card` },
            React.createElement(
                "section",
                { className: `${CLS.headerSection} dockview-header` },
                React.createElement(
                    "div",
                    { className: CLS.upper },
                    React.createElement(
                        "div",
                        { className: `${CLS.headerChildren} dockview-header-children` },
                        React.createElement(
                            "h2",
                            { className: `${CLS.title} dockview-title`, title },
                            title
                        )
                    ),
                    React.createElement(
                        "div",
                        { className: CLS.toolbar },
                        popoutBtn,
                        moreBtn,
                        closeBtn
                    )
                )
            ),
            React.createElement(DockToolbar, null),
            React.createElement(
                "div",
                { className: "dockview-body-wrap" },
                React.createElement(
                    "div",
                    { className: "dockview-body" },
                    renderBody()
                ),
                // PDF find overlay pins to the non-scrolling body wrapper.
                hasContent && content.type === "pdf" && pdfView.findOpen && content.pdf.doc
                    ? React.createElement(PdfFindBar, null)
                    : null
            )
        )
    );
}

// ---------------------------------------------------------------------------
// Host injection + React mount
// ---------------------------------------------------------------------------
let root: Root | null = null; // React root
let rootHost: HTMLElement | null = null; // the node `root` is bound to
// Set true between start() and stop(). A heartbeat/observer callback that was
// already in flight when stop() ran must NOT re-inject the host afterwards.
let active = false;

function ensureHost(): boolean {
    if (!active) return false; // plugin stopped — never (re)inject
    const inner = findPageInner();
    if (!inner) return false;
    const chat = findChat(inner);
    if (!chat) return false;

    let host = document.getElementById(HOST_ID);
    const inPlace = host && host.parentElement === inner && host === inner.lastElementChild;

    if (!inPlace) {
        let freshHost = false;
        if (!host) {
            host = document.createElement("div");
            host.id = HOST_ID;
            freshHost = true;
        }
        inner.appendChild(host);

        if (!root || freshHost || rootHost !== host) {
            root = createRoot(host);
            rootHost = host;
            root.render(React.createElement(DockPanel));
        }
    }
    applyOpenState();
    return true;
}

/** Reflect open/closed across the spacer host AND the exclusive right slot
 *  (server member list / DM user-profile panel / native thread sidebar).
 *
 *  Exclusion is PREEMPTIVE, driven entirely by CSS: we set `dockview-open` on
 *  <html> and tag the page-inner flex row with `dockview-page-inner`, and the
 *  injected stylesheet (style.css) hides the exclusive occupant by stable
 *  selector. Because the rule keys off a document state class — not per-node
 *  attributes applied after Discord mounts and paints the sidebar — any sidebar
 *  that gets (re)mounted while the panel is open is hidden from its first paint,
 *  so a channel switch / thread open never flashes the sidebar before it
 *  disappears. Closing the panel removes the html class = instant restore (and a
 *  sidebar Discord swapped out from under us can't get "stuck hidden", since we
 *  no longer tag individual nodes). */
function applyOpenState() {
    const host = document.getElementById(HOST_ID);
    const inner = findPageInner();
    // Tag the page-inner so the thread-sidebar CSS rule (scoped to its direct
    // children) can target the native thread card without touching our host.
    if (inner) inner.classList.add("dockview-page-inner");

    if (state.open) {
        if (host) {
            // Drive open/closed via a class (display:block !important) instead of
            // inline display — Discord's layout code intermittently resets our
            // injected sibling's inline `display` to none, but it never beats the
            // class rule. width/flex stay inline (Discord leaves those alone).
            host.classList.add("dockview-open");
            host.style.flex = `0 0 ${state.width}px`;
            host.style.width = `${state.width}px`;
        }
        // Set the document state class — the stylesheet hides the member list /
        // DM profile / native thread (whichever is present) preemptively.
        document.documentElement.classList.add("dockview-open");
    } else {
        if (host) host.classList.remove("dockview-open");
        document.documentElement.classList.remove("dockview-open");
    }
}

/** Write ONLY the host's width/flex from state.width, nothing else. Used in the
 *  resize drag's rAF loop so a width change is a single cheap inline-style write
 *  (no React render, no document-class / page-inner work like applyOpenState). */
function applyHostWidth() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    host.style.flex = `0 0 ${state.width}px`;
    host.style.width = `${state.width}px`;
}

/** Drop the document state class (restoring any preemptively-hidden sidebar) and
 *  the page-inner tag, so no DockView marks linger after the plugin stops. Used
 *  on plugin stop; a normal close goes through applyOpenState. */
function restoreHiddenMembers() {
    document.documentElement.classList.remove("dockview-open");
    document.querySelectorAll(".dockview-page-inner").forEach(el => el.classList.remove("dockview-page-inner"));
}

function toggle() {
    state.open = !state.open;
    lsSet(LS_OPEN, state.open ? "1" : "0");
    if (state.open) ensureHost();
    saveCurrentChannelState();
    applyOpenState();
    forceRender?.();
}

// ---------------------------------------------------------------------------
// Re-injection: debounced observer scoped to the PAGE INNER div only.
// ---------------------------------------------------------------------------
let observer: MutationObserver | null = null;
let observedParent: HTMLElement | null = null;
let debounce: any = null;

function attachObserver() {
    const inner = findPageInner();
    if (!inner) return; // no chat layout yet; the heartbeat poll will retry
    if (inner === observedParent && observer) return;

    observer?.disconnect();
    observedParent = inner;
    observer = new MutationObserver(() => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            ensureHost(); // also re-applies open/exclusion state
            const cur = findPageInner();
            if (cur && cur !== observedParent) attachObserver();
        }, 150);
    });
    observer.observe(inner, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Lifecycle — start/stop (replaces the fork's top-level boot()).
// ---------------------------------------------------------------------------
let heartbeat: any = null;
let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
let onResize: (() => void) | null = null;
let onMessage: ((e: MessageEvent) => void) | null = null;

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

/** Start the panel: heartbeat, observer, hotkey + resize listeners. */
export function startPanel() {
    active = true;
    // Seed the per-channel memory with whatever channel we boot into, so the
    // first save targets the right channel (no spurious save to "null").
    currentChannelId = getCurrentChannelId();
    // Persistent low-frequency heartbeat. ensureHost() is cheap (early-returns
    // when the host is already in place), so this is safe to run forever.
    heartbeat = setInterval(() => {
        if (ensureHost()) attachObserver();
    }, 800);

    // toggle hotkey: Ctrl+Alt+P; image zoom (+/-/0) and PDF page-nav/zoom/find
    // when the panel is the focus (hovered or contains the focused element) so we
    // never steal Discord keys.
    onKeyDown = (e: KeyboardEvent) => {
        if (e.ctrlKey && e.altKey && (e.key === "p" || e.key === "P" || e.code === "KeyP")) {
            e.preventDefault();
            toggle();
            return;
        }
        if (!state.open) return;
        const host = document.getElementById(HOST_ID);
        if (!host) return;
        // The dock panel must be the ACTIVE surface (hovered or holds keyboard
        // focus); otherwise ignore so typing in chat is never hijacked.
        const focused = host.contains(document.activeElement);
        if (!(focused || hostHovered)) return;

        // PDF branch: Ctrl+F (our find, since Discord may eat the global one),
        // and — with NO modifier — ←/→ or PageUp/PageDown for page nav, +/- zoom.
        if (content.type === "pdf" && pdfControls) {
            if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
                e.preventDefault();
                if (!pdfView.findOpen) pdfControls.toggleFind();
                else pdfControls.findNext();
                return;
            }
            if (e.ctrlKey || e.altKey || e.metaKey) return;
            // don't hijack typing in the find input / page-jump input
            const ae = document.activeElement as HTMLElement | null;
            if (ae && ae.tagName === "INPUT") return;
            if (e.key === "ArrowRight" || e.key === "PageDown") {
                e.preventDefault(); pdfControls.nextPage();
            } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
                e.preventDefault(); pdfControls.prevPage();
            } else if (e.key === "+" || e.key === "=") {
                e.preventDefault(); pdfControls.zoomIn();
            } else if (e.key === "-" || e.key === "_") {
                e.preventDefault(); pdfControls.zoomOut();
            }
            return;
        }

        // Image zoom keys — only when no modifier.
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (content.type !== "image" || !imgControls) return;
        if (e.key === "+" || e.key === "=") {
            e.preventDefault();
            imgControls.zoomIn();
        } else if (e.key === "-" || e.key === "_") {
            e.preventDefault();
            imgControls.zoomOut();
        } else if (e.key === "0") {
            e.preventDefault();
            imgControls.reset();
        }
    };
    window.addEventListener("keydown", onKeyDown);

    // re-clamp width if the window shrinks
    onResize = () => {
        const w = clampWidth(state.width);
        if (w !== state.width) {
            state.width = w;
            applyOpenState();
            forceRender?.();
        }
    };
    window.addEventListener("resize", onResize);

    // Markdown/artifact sandbox iframes postMessage link clicks up to us; open
    // them in the external browser instead of navigating inside the sandbox.
    onMessage = (e: MessageEvent) => {
        const d = e?.data;
        if (d && typeof d === "object" && typeof d.__dockViewOpenLink === "string") {
            openExternalLink(d.__dockViewOpenLink);
        }
    };
    window.addEventListener("message", onMessage);

    // Mount immediately if a chat layout is already present.
    if (ensureHost()) attachObserver();
}

/** Stop the panel: tear down EVERYTHING (the new lifecycle requirement). */
export function stopPanel() {
    // 0. mark inactive FIRST so any in-flight heartbeat/observer callback that
    //    fires during teardown can't re-inject the host (ensureHost early-returns).
    active = false;
    // 1. heartbeat
    if (heartbeat != null) {
        clearInterval(heartbeat);
        heartbeat = null;
    }
    // 2. window listeners
    if (onKeyDown) {
        window.removeEventListener("keydown", onKeyDown);
        onKeyDown = null;
    }
    if (onResize) {
        window.removeEventListener("resize", onResize);
        onResize = null;
    }
    if (onMessage) {
        window.removeEventListener("message", onMessage);
        onMessage = null;
    }
    // 3. observer + its debounce
    observer?.disconnect();
    observer = null;
    observedParent = null;
    clearTimeout(debounce);
    debounce = null;
    // 4. close panel state + restore the member list (mutual-exclusion undo)
    state.open = false;
    restoreHiddenMembers();
    // 5. unmount React + remove the host DOM node. React 18's root.unmount()
    //    may defer; remove the host(s) in a microtask AFTER unmount settles so
    //    we don't race React detaching its container. Sweep ALL matching hosts
    //    (defensive against any duplicate) by id.
    const r = root;
    root = null;
    rootHost = null;
    forceRender = null;
    const removeHosts = () => {
        document.querySelectorAll(`#${HOST_ID}`).forEach(el => el.remove());
    };
    if (r) {
        try { r.unmount(); } catch { /* ignore */ }
    }
    removeHosts();
    // unmount can detach asynchronously; sweep again next tick to be sure.
    Promise.resolve().then(removeHosts);
    setTimeout(removeHosts, 0);
    // 6. release any pdf document
    resetPdf();
    // 7. drop per-channel memory (in-memory only).
    channelStates.clear();
    currentChannelId = null;
    activeDescriptor = null;
}

// Debug surface: a single neutral window handle so manual console testing
// still works. Removed again on stop().
export function exposeDebug() {
    (window as any).__dockView = {
        toggle, ensureHost, applyOpenState, state, DockPanel, CLS, findPageInner,
        onChannelSelect, getCurrentChannelId, channelStates,
        load, clear: clearArtifact, popout: popoutArtifact, content, detectType
    };
}
export function unexposeDebug() {
    try { delete (window as any).__dockView; } catch { /* ignore */ }
}
