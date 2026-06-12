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

import * as DataStore from "@api/DataStore";
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

// Single catalogue of every user-facing string (one English voice).
import { STRINGS } from "./strings";

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

// Header leading glyphs, one per content type. Each entry is an array of [d,
// extraAttrs] tuples (a type can layer a document frame + a type mark). All drawn
// on a 24x24 grid in Discord's icon tone — single colour (currentColor, the
// muted header text), consistent visual weight, document-framed so they read as
// "a file" the way a real thread header reads as "a thread".
//
// IMPORTANT: these are PLAIN DATA (path strings), NOT React elements. `React`
// from @webpack/common is a lazy proxy that is NOT ready at module-eval time, so
// calling React.createElement here would throw and break the whole plugin import.
// The header builds the <path> elements lazily at render time (see leadingIcon).
type IconPath = [string] | [string, Record<string, any>];
// A shared rounded document outline (page with a folded corner) used as the base
// frame for the text-ish types so they share one silhouette.
const DOC_FRAME = "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-7-7Zm0 2.5L17.5 9H14a1 1 0 0 1-1-1V4.5Z";
const FILE_TYPE_ICON: Record<string, IconPath[]> = {
    // PDF: document frame + "PDF" marked by three short text rules.
    pdf: [
        [DOC_FRAME],
        ["M7 12.5h10V14H7v-1.5Zm0 3h10V17H7v-1.5Zm0 3h7V20H7v-1.5Z"]
    ],
    // Markdown: document frame + the canonical "M▼" markdown mark.
    markdown: [
        [DOC_FRAME],
        ["M6.5 12.5h11a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-6a.5.5 0 0 1 .5-.5Zm1.25 5.25v-2.4l1.25 1.5 1.25-1.5v2.4h1.25v-4h-1.25l-1.25 1.55L9 13.75H7.75v4h0Zm7-4h-1.25v2h-1l1.625 2 1.625-2h-1v-2Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // HTML / interactive artifact: angle-bracket code mark on a document.
    html: [
        [DOC_FRAME],
        ["M10 12.6 7.3 15.3a1 1 0 0 0 0 1.4L10 19.4l1-1-2.2-2.2L11 14l-1-1.4Zm4 0-1 1.4 2.2 1.9-2.2 2.2 1 1 2.7-2.7a1 1 0 0 0 0-1.4L14 12.6Z"]
    ],
    // Code / text: a document with angle brackets (same family as html, leaner).
    code: [
        [DOC_FRAME],
        ["M9.7 13 7 15.7a1 1 0 0 0 0 1.4L9.7 19.8 11 18.6l-2.4-2.2L11 14.2 9.7 13Zm4.6 0L13 14.2l2.4 2.2L13 18.6l1.3 1.2 2.7-2.7a1 1 0 0 0 0-1.4L14.3 13Z"]
    ],
    // Image: the classic Discord "framed picture" (rect + sun + mountain).
    image: [
        ["M4 5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5Zm3-1a1 1 0 0 0-1 1v9.59l2.3-2.3a1 1 0 0 1 1.4 0l2.3 2.3 3.3-3.3a1 1 0 0 1 1.4 0L18 14.6V5a1 1 0 0 0-1-1H7Zm2.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Fallback (unknown / binary): a plain document frame.
    unknown: [[DOC_FRAME]]
};

// --- persistence (panel width + open state) ---------------------------------
// Vencord's renderer runs in an ISOLATED context where `localStorage` is
// undefined (both window.* and globalThis.*), so the old localStorage-backed
// lsGet/lsSet were silent no-ops and width/open never survived a restart.
//
// We persist through Vencord's DataStore (IndexedDB, available in the isolated
// context). DataStore is async, but the existing call sites read/write the
// state SYNCHRONOUSLY (state init, toggle, resize). So we keep a synchronous
// in-memory mirror (`persistCache`) that all the lsGet/lsSet sites hit, and:
//   - load() the persisted values from DataStore once at startPanel(), seeding
//     the mirror + applying them to `state`/DOM (write-back load),
//   - write-through every lsSet: update the mirror immediately AND fire an
//     async DataStore.set (fire-and-forget; ordering is per-key last-write-wins).
const persistCache = new Map<string, string>();
let persistLoaded = false;

function lsGet(k: string): string | null {
    return persistCache.has(k) ? persistCache.get(k)! : null;
}
function lsSet(k: string, v: string): void {
    persistCache.set(k, v);
    // Don't write back before the initial load completes — an early write
    // (module-init defaults) must not clobber the stored value we're about to
    // read. After load, every change is durably written through.
    if (!persistLoaded) return;
    try {
        DataStore.set(k, v).catch(() => { /* ignore — best-effort persist */ });
    } catch {
        /* DataStore unavailable: stay in-memory only */
    }
}

/** Load persisted width/open from DataStore into the in-memory mirror + state,
 *  then apply to the live panel. Called once at startPanel(); idempotent. */
async function loadPersistedState(): Promise<void> {
    if (persistLoaded) return;
    let openStr: string | null = null;
    let widthStr: string | null = null;
    try {
        [openStr, widthStr] = await DataStore.getMany([LS_OPEN, LS_WIDTH]);
    } catch {
        /* DataStore unavailable — fall through with defaults already in state */
    }
    persistLoaded = true;
    if (typeof openStr === "string") persistCache.set(LS_OPEN, openStr);
    if (typeof widthStr === "string") persistCache.set(LS_WIDTH, widthStr);

    // Apply to live state. open is only forced TRUE from storage — if a channel
    // switch already opened the panel during the async gap we don't slam it shut.
    if (typeof widthStr === "string") {
        const w = clampWidth(parseInt(widthStr, 10) || DEFAULT_WIDTH);
        if (w !== state.width) {
            state.width = w;
            if (state.open) applyHostWidth();
        }
    }
    if (openStr === "1" && !state.open) {
        state.open = true;
        ensureHost();
        applyOpenState();
    }
    forceRender?.();
}

// --- shared open/width state (kept outside React) ---------------------------
const state = {
    open: lsGet(LS_OPEN) === "1",
    width: clampWidth(parseInt(lsGet(LS_WIDTH) || "", 10) || DEFAULT_WIDTH)
};

// --- panel content state ----------------------------------------------------
// "unknown" = a file whose extension we don't recognise. We DON'T guess "html"
// for it anymore (that dumped raw bytes — often binary garbage — into an iframe).
// Instead loadUnknown() fetches it and sniffs text-vs-binary: a text file is
// retyped to "code" (plaintext viewer), a binary one stays "unknown" and renders
// the unsupported-format fallback screen (download / open-in-new-window).
type ContentType = "html" | "pdf" | "code" | "markdown" | "image" | "unknown";

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
    // true once an "unknown" file is sniffed as binary -> renderUnsupportedBody.
    binary: boolean;
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
    binary: false,
    seq: 0
};

// --- monotonic load token (race guard) --------------------------------------
// Every load()/restoreDescriptor() bumps this and captures the value as its
// request token. Async loaders compare their captured token against the live
// `loadSeq`; a mismatch means a newer load has superseded them, so they bail and
// never write stale content. This replaces the old `content.url !== reqUrl`
// string compare, which couldn't distinguish a re-click of the SAME url or two
// rapid switches to the same file (the last click always wins now).
let loadSeq = 0;

// --- per-file content LRU cache ---------------------------------------------
// Keyed by the file's load key (url|type). An entry holds the already-resolved
// content (so a re-open needs no fetch) PLUS the saved view-state (scroll, zoom,
// fit, page, image pan) so the file reopens EXACTLY where the user left it. The
// currently-displayed file's entry is the one `content` mirrors; we snapshot its
// live view-state into the cache on every switch-away. Capacity is small (most-
// recent files); eviction destroys the pdf.js doc + revokes blob urls so nothing
// leaks. Inline-html artifacts (no url) are never cached (no stable key).
const CONTENT_CACHE_MAX = 3;

interface CachedView {
    // pdf
    pdfPage?: number;
    pdfZoom?: number;
    pdfFit?: PdfFit;
    // image
    imgScale?: number;
    imgTx?: number;
    imgTy?: number;
    // shared scroll (px) of the .dockview-body scroller
    scrollTop?: number;
    // code
    codeWrap?: boolean;
}
interface CacheEntry {
    key: string;
    name: string;
    type: ContentType;
    url: string;
    // resolved payloads (whichever the type needs)
    html?: string | null;
    frameHtml?: string | null;
    code?: string | null;
    codeLang?: string;
    pdfDoc?: any | null; // pdfjs PDFDocumentProxy (kept alive while cached)
    pdfPages?: number;
    binary?: boolean; // sniffed-binary unknown file -> unsupported fallback
    error?: string | null;
    loading: boolean; // true while the initial fetch is still in flight
    view: CachedView;
}
const contentCache = new Map<string, CacheEntry>();
let activeCacheKey: string | null = null;

/** The cache key for a file: its url + content type (type disambiguates e.g. a
 *  .svg opened as image vs code, though in practice url is unique enough). */
function cacheKeyFor(url: string | null, type: ContentType): string | null {
    return url ? `${type}|${url}` : null;
}

/** Fully tear down a pdf.js document, releasing its worker-side resources. In
 *  this pdf.js v6 build the PDFDocumentProxy itself has NO destroy(); the real
 *  teardown lives on its loadingTask (.destroy() returns a promise). We prefer
 *  that, fall back to a bare doc.destroy() (older builds) and finally cleanup().
 *  (The original resetPdf called the non-existent doc.destroy() inside a swallow
 *  try/catch, so it was silently leaking every PDF — this fixes that too.) */
function destroyPdfDoc(doc: any) {
    if (!doc) return;
    try {
        const lt = doc.loadingTask;
        if (lt && typeof lt.destroy === "function") { lt.destroy(); return; }
    } catch { /* fall through */ }
    try { if (typeof doc.destroy === "function") { doc.destroy(); return; } } catch { /* fall through */ }
    try { if (typeof doc.cleanup === "function") doc.cleanup(); } catch { /* ignore */ }
}

/** Destroy/release everything an evicted entry owns. The big resource is the
 *  pdf.js document (worker-side page caches); releasing it is what keeps memory
 *  bounded. We do NOT revoke the entry's url — the plugin never creates object
 *  urls (it loads CDN http urls + the <img>/iframe stream them), so the url is
 *  owned by the caller and may be reused. */
function disposeCacheEntry(e: CacheEntry) {
    if (e.pdfDoc) {
        destroyPdfDoc(e.pdfDoc);
        e.pdfDoc = null;
    }
}

/** Insert/refresh an entry as most-recently-used and evict past capacity. The
 *  active (currently-shown) entry is never evicted — its pdf doc is live. */
function cacheTouch(entry: CacheEntry) {
    // re-insert at the end (Map preserves insertion order = LRU order).
    contentCache.delete(entry.key);
    contentCache.set(entry.key, entry);
    while (contentCache.size > CONTENT_CACHE_MAX) {
        // evict the oldest non-active entry.
        let victim: string | null = null;
        for (const k of contentCache.keys()) {
            if (k !== activeCacheKey) { victim = k; break; }
        }
        if (victim == null) break; // only the active entry remains
        const e = contentCache.get(victim)!;
        contentCache.delete(victim);
        disposeCacheEntry(e);
    }
}

/** Drop the whole cache (plugin stop), releasing every doc. */
function clearContentCache() {
    for (const e of contentCache.values()) disposeCacheEntry(e);
    contentCache.clear();
    activeCacheKey = null;
}

/** The scrollable body element (px scroll position lives here). */
function bodyScroller(): HTMLElement | null {
    return document.querySelector<HTMLElement>(`#${HOST_ID} .dockview-body`);
}

/** Snapshot the CURRENT live view-state into the active cache entry so that
 *  reopening this file (re-click / channel return) lands on the same spot. */
function snapshotActiveView() {
    if (activeCacheKey == null) return;
    const e = contentCache.get(activeCacheKey);
    if (!e) return;
    const sc = bodyScroller();
    e.view.scrollTop = sc ? sc.scrollTop : e.view.scrollTop;
    if (e.type === "pdf") {
        e.view.pdfPage = pdfView.page;
        e.view.pdfZoom = pdfView.zoom;
        e.view.pdfFit = pdfView.fit;
    } else if (e.type === "image") {
        e.view.imgScale = imgView.scale;
        e.view.imgTx = imgView.tx;
        e.view.imgTy = imgView.ty;
    } else if (e.type === "code") {
        e.view.codeWrap = codeView.wrap;
    }
}

/** Apply a cache entry's saved view-state into the module view objects so the
 *  body renderer opens at the remembered zoom/page/scroll. (Scroll itself is
 *  re-applied after the body mounts — see consumePendingScroll.) */
let pendingScrollTop: number | null = null;
function applyCachedView(e: CacheEntry) {
    if (e.type === "pdf") {
        pdfView.zoom = e.view.pdfZoom ?? 1;
        pdfView.fit = e.view.pdfFit ?? "width";
        pdfView.page = e.view.pdfPage ?? 1;
        pdfView.total = e.pdfPages ?? 0;
        pdfView.findOpen = false;
        pdfView.findQuery = "";
        pdfView.findMatches = 0;
        pdfView.findActive = 0;
        pdfView.findCase = false;
    } else if (e.type === "image") {
        imgView.scale = e.view.imgScale ?? 1;
        imgView.tx = e.view.imgTx ?? 0;
        imgView.ty = e.view.imgTy ?? 0;
    } else if (e.type === "code") {
        codeView.wrap = e.view.codeWrap ?? false;
        // find never persists across files — a restored file opens with find closed.
        resetCodeView();
    }
    pendingScrollTop = e.view.scrollTop ?? null;
}

/** After a restore, re-apply the saved scroll once the body has its content. */
function consumePendingScroll() {
    if (pendingScrollTop == null) return;
    const target = pendingScrollTop;
    pendingScrollTop = null;
    const sc = bodyScroller();
    if (sc) sc.scrollTop = target;
}

/** Point `content` at a cached entry WITHOUT any fetch. Returns true on hit. The
 *  caller is responsible for the open/render bookkeeping around this. */
function mountFromCache(e: CacheEntry): boolean {
    // Tear down the OUTGOING pdf doc only if it's not itself cached (cached docs
    // stay alive in their entry). resetPdf() would destroy content.pdf.doc; here
    // we just re-point, since the live doc belongs to its own cache entry.
    content.name = e.name;
    content.type = e.type;
    content.url = e.url;
    content.error = e.error ?? null;
    content.loading = e.loading;
    // payloads
    content.html = e.html ?? null;
    content.frameHtml = e.frameHtml ?? null;
    content.code = e.code ?? null;
    content.codeLang = e.codeLang ?? "plaintext";
    content.binary = e.binary ?? false;
    // pdf: re-point the live doc to the cached one (no destroy, no re-fetch).
    content.pdf = {
        doc: e.pdfDoc ?? null,
        pages: e.pdfPages ?? 0,
        renderToken: content.pdf.renderToken + 1
    };
    applyCachedView(e);
    activeCacheKey = e.key;
    cacheTouch(e);
    return true;
}

// The code body is no longer a single memoized highlight blob — CodeBody builds
// a line-addressable DOM imperatively (keyed on content.seq) and the controller
// (codeCtrl) fills it progressively, so there's nothing to memoize across React
// re-renders: a stray DockPanel re-render reconciles the SAME CodeBody (same
// seq) and never rebuilds it. Cross-file freshness comes from the seq key.

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

// --- code viewer view-state (word-wrap toggle + find), shared with the toolbar
// The find fields mirror pdfView's: the bar/keyboard drive them, the controller
// (codeCtrl) reads them to repaint matches. Matching is against the ORIGINAL
// source so it's independent of how far progressive highlighting has reached.
const codeView = {
    wrap: false,
    findOpen: false,
    findQuery: "",
    findMatches: 0,
    findActive: 0, // 1-based index of the active match (0 = none)
    findCase: false
};
function resetCodeView() {
    codeView.findOpen = false;
    codeView.findQuery = "";
    codeView.findMatches = 0;
    codeView.findActive = 0;
    codeView.findCase = false;
}

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
    findActive: 0, // 1-based index of the active match (0 = none)
    findCase: false // case-sensitive toggle (false = case-insensitive, the default)
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
    pdfView.findCase = false;
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
    toggleFindCase: () => void;
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
    // ONLY genuine HTML-intent extensions take the iframe path. Everything else
    // unrecognised is "unknown" (sniffed text/binary at load) — NOT "html", so a
    // .xyz / binary file is never dumped raw into a sandbox iframe.
    if (ext === "artifact" || ext === "html" || ext === "htm") return "html";
    if (ext && ext in CODE_LANG) return "code";
    return "unknown";
}

/** Resolve the hljs language id for an ext (default plaintext). */
function codeLangFor(ext: string | null): string {
    return (ext && CODE_LANG[ext]) || "plaintext";
}

// ---------------------------------------------------------------------------
// Code highlighter — prefer Discord's OWN bundled highlight.js, fall back.
// ---------------------------------------------------------------------------
// `highlight` does the whole-string pass (small files / markdown fences).
// `highlightChunk` is the CHUNKED entry the big-file progressive renderer uses:
//   it highlights ONE slice and threads hljs's parser state (`top`) forward so a
//   multiline construct (block comment, template literal) that straddles a chunk
//   boundary keeps the right state — the chunk after the one that OPENED a
//   comment is still highlighted as comment. hljs's legacy 4-arg signature
//   `highlight(lang, code, ignoreIllegals, continuation)` carries this state via
//   the returned `result.top`; we probe support once and fall back to per-chunk
//   independent highlight (boundary syntax may break) when it's absent.
type ChunkResult = { html: string; top: any };
type Highlighter = {
    highlight: (code: string, lang: string) => string; // returns HTML
    getLanguage: (lang: string) => boolean;
    // null `continuation` starts fresh; pass the previous chunk's `top` to resume.
    highlightChunk: (code: string, lang: string, continuation: any) => ChunkResult;
};
let _hl: Highlighter | null = null;

/** Wrap a raw hljs-shaped module (Discord's or the bundled one) into our
 *  Highlighter, including the continuation-aware chunk path. `mod` must expose
 *  `highlight` + `getLanguage`; the chunk path uses the legacy 4-arg call so it
 *  can thread parser state, degrading to the object form when that's rejected. */
function wrapHljs(mod: any): Highlighter {
    const whole = (code: string, lang: string): string => {
        try {
            const r = mod.highlight(code, { language: lang, ignoreIllegals: true });
            if (r && typeof r.value === "string") return r.value;
        } catch { /* fall through to legacy */ }
        try {
            const r = mod.highlight(lang, code, true);
            if (r && typeof r.value === "string") return r.value;
        } catch { /* fall through */ }
        return escapeHtml(code);
    };
    return {
        getLanguage: (lang: string) => { try { return !!mod.getLanguage(lang); } catch { return false; } },
        highlight: whole,
        highlightChunk: (code: string, lang: string, continuation: any): ChunkResult => {
            // Legacy signature carries continuation; only it returns a resumable
            // `top`. If the build rejects it we lose cross-chunk state but still
            // produce correct in-chunk HTML.
            try {
                const r = mod.highlight(lang, code, true, continuation);
                if (r && typeof r.value === "string") return { html: r.value, top: r.top ?? null };
            } catch { /* fall through */ }
            return { html: whole(code, lang), top: null };
        }
    };
}

/** Try to find Discord's bundled hljs via Webpack (highlight + getLanguage). */
function discordHljs(): Highlighter | null {
    try {
        const mod = (findByProps as any)?.("highlight", "getLanguage") || (findByProps as any)?.("highlightAuto", "getLanguage");
        if (mod && typeof mod.highlight === "function" && typeof mod.getLanguage === "function") {
            return wrapHljs(mod);
        }
    } catch {
        /* ignore */
    }
    return null;
}

/** Bundled highlight.js wrapped to the same Highlighter shape. */
function bundledHljs(): Highlighter {
    return wrapHljs(hljs);
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
/** Is `el` a text-entry surface (chat box, search, modal field, …)? Single-key
 *  viewer shortcuts must never fire while one of these holds focus — covers
 *  <input>/<textarea>, contenteditable (Discord's Slate chat box) and ARIA
 *  textboxes. Modifier combos (e.g. Ctrl+Alt+P) are exempt by their callers. */
function isEditableTarget(el: Element | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (el.getAttribute("role") === "textbox") return true;
    return false;
}

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
/** Reset only the pdf-specific fields (and bump the render token to abort).
 *  The live doc is OWNED by its cache entry now, so we do NOT destroy it here —
 *  eviction (disposeCacheEntry) is the single place a doc is destroyed. We just
 *  drop our pointer + bump the token so the in-flight render aborts. */
function resetPdf() {
    content.pdf = { doc: null, pages: 0, renderToken: content.pdf.renderToken + 1 };
    resetPdfView();
}
/** Reset only the code/text-specific fields. */
function resetCode() {
    content.code = null;
    content.codeLang = "plaintext";
    resetCodeView(); // a fresh code load opens with find closed
}

/** fetch() wrapper for the loaders. `noCache` (a retry from the error card)
 *  forces a fresh network round-trip via Cache-Control: no-cache, bypassing the
 *  HTTP cache without mutating the url (so signed CDN params stay intact). */
function dvFetch(url: string, noCache?: boolean): Promise<Response> {
    return noCache ? fetch(url, { cache: "reload" }) : fetch(url);
}

/** HTML / artifact loader. `token` is the load token captured by load(); a
 *  mismatch on resolve means a newer load superseded us. `entry` (when present)
 *  is the cache entry this load fills on success. */
function loadHtml(opts: { name: string; html?: string | null; url?: string | null; noCache?: boolean }, token: number, entry: CacheEntry | null) {
    resetPdf();
    resetCode();
    if (opts.html != null) {
        setArtifactHtml(opts.html);
        content.loading = false;
    } else if (opts.url) {
        resetHtml();
        content.loading = true;
        const reqUrl = opts.url;
        dvFetch(reqUrl, opts.noCache)
            .then(r => {
                if (!r.ok) throw new Error(r.status + " " + r.statusText);
                return r.text();
            })
            .then(text => {
                if (entry) { entry.html = text; const nonce = pageNonce(); entry.frameHtml = nonce ? injectNonce(text, nonce) : text; entry.loading = false; entry.error = null; }
                if (token !== loadSeq) return;
                setArtifactHtml(text);
                content.loading = false;
                content.error = null;
                forceRender?.();
            })
            .catch(e => {
                if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
                if (token !== loadSeq) return;
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

/** PDF loader: fetch -> ArrayBuffer -> pdf.js (main-thread worker). On success
 *  the doc is stored in `entry` (the cache owns it); a stale resolve (token !=
 *  loadSeq) destroys the freshly-built doc to avoid a leak. */
function loadPdf(opts: { name: string; url?: string | null; noCache?: boolean }, token: number, entry: CacheEntry | null) {
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
    dvFetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.arrayBuffer();
        })
        .then(buf => {
            const task = pdfjsLib.getDocument({ data: new Uint8Array(buf) });
            return task.promise;
        })
        .then((doc: any) => {
            if (!doc) return;
            // Only keep the doc if `entry` is STILL the cache's live entry for its
            // key (a rapid re-click could have disposed + replaced it). Otherwise
            // the entry is detached and storing the doc there would leak it — so
            // destroy it. The doc is persisted even when token !== loadSeq (so a
            // re-open is instant), as long as the entry is still live.
            const live = entry != null && contentCache.get(entry.key) === entry;
            if (live) { entry!.pdfDoc = doc; entry!.pdfPages = doc.numPages; entry!.loading = false; entry!.error = null; }
            else { destroyPdfDoc(doc); }
            if (token !== loadSeq) return; // superseded — don't touch content
            content.pdf.doc = doc;
            content.pdf.pages = doc.numPages;
            pdfView.total = doc.numPages;
            // keep the cached/restored page if any (applyCachedView set it); else 1.
            content.pdf.renderToken += 1; // signal: a fresh doc is ready to render
            content.loading = false;
            content.error = null;
            forceRender?.();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (token !== loadSeq) return;
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
function loadCode(opts: { name: string; url?: string | null; noCache?: boolean }, token: number, entry: CacheEntry | null) {
    resetHtml();
    resetPdf();
    resetCode();
    if (!opts.url) {
        content.loading = false;
        content.error = "No source";
        return;
    }
    const lang = codeLangFor(extOf(opts.url) || extOf(opts.name));
    content.codeLang = lang;
    if (entry) entry.codeLang = lang;
    content.loading = true;
    const reqUrl = opts.url;
    dvFetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.text();
        })
        .then(text => {
            if (entry) { entry.code = text; entry.loading = false; entry.error = null; }
            if (token !== loadSeq) return;
            content.code = text;
            content.loading = false;
            content.error = null;
            forceRender?.();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (token !== loadSeq) return;
            content.loading = false;
            content.error = String(e?.message || e);
            forceRender?.();
        });
}

/** Heuristic: does this byte buffer look like TEXT (vs binary)?
 *  - A UTF-8/16 BOM, or a complete absence of NUL bytes plus a low ratio of
 *    other C0 control chars, reads as text. A NUL byte (the single strongest
 *    binary tell) or a high control-char ratio reads as binary. We sample the
 *    leading bytes only — enough to classify without scanning huge files. */
function looksLikeText(buf: ArrayBuffer): boolean {
    const bytes = new Uint8Array(buf);
    const n = Math.min(bytes.length, 4096);
    if (n === 0) return true; // empty file: harmless to show as (empty) text
    // BOMs => definitely text.
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return true; // UTF-8
    if ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF)) return true; // UTF-16
    let control = 0;
    for (let i = 0; i < n; i++) {
        const b = bytes[i];
        if (b === 0) return false; // NUL: the definitive binary marker
        // C0 controls except the common text whitespace (TAB 9, LF 10, CR 13,
        // FF 12) and ESC 27 (ANSI logs). Everything >=0x20 is printable/UTF-8.
        if (b < 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27) control++;
    }
    return control / n < 0.1; // <10% odd control bytes => treat as text
}

/** UNKNOWN-extension loader. We don't know the type from the name, so fetch the
 *  bytes and sniff: text -> retype to a plaintext code viewer; binary -> mark
 *  `content.binary` and render the unsupported-format fallback (download / open
 *  in new window). Either way nothing raw is ever injected into an iframe. */
function loadUnknown(opts: { name: string; url?: string | null; noCache?: boolean }, token: number, entry: CacheEntry | null) {
    resetHtml();
    resetPdf();
    resetCode();
    if (!opts.url) {
        content.loading = false;
        content.error = "No source";
        return;
    }
    content.loading = true;
    const reqUrl = opts.url;
    dvFetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.arrayBuffer();
        })
        .then(buf => {
            const isText = looksLikeText(buf);
            if (isText) {
                const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
                // Retype to a plaintext code view (cache entry too, so a re-open /
                // channel return restores it as code, not as an unknown re-fetch).
                if (entry) {
                    entry.type = "code";
                    entry.code = text;
                    entry.codeLang = "plaintext";
                    entry.binary = false;
                    entry.loading = false;
                    entry.error = null;
                }
                if (token !== loadSeq) return;
                content.type = "code";
                content.code = text;
                content.codeLang = "plaintext";
                content.binary = false;
                content.loading = false;
                content.error = null;
                forceRender?.();
            } else {
                if (entry) { entry.binary = true; entry.loading = false; entry.error = null; }
                if (token !== loadSeq) return;
                content.binary = true;
                content.loading = false;
                content.error = null;
                forceRender?.();
            }
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (token !== loadSeq) return;
            content.loading = false;
            content.error = String(e?.message || e);
            forceRender?.();
        });
}

/** MARKDOWN loader: fetch -> marked -> dark doc -> nonce sandbox iframe path. */
function loadMarkdown(opts: { name: string; url?: string | null; noCache?: boolean }, token: number, entry: CacheEntry | null) {
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
    dvFetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.text();
        })
        .then(md => {
            let bodyHtml: string;
            try {
                bodyHtml = marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
            } catch (e) {
                bodyHtml = "<pre>" + escapeHtml(String(e)) + "</pre>";
            }
            bodyHtml = highlightMarkdownCode(bodyHtml);
            const fullHtml = wrapMarkdownDoc(bodyHtml);
            if (entry) { entry.html = fullHtml; const nonce = pageNonce(); entry.frameHtml = nonce ? injectNonce(fullHtml, nonce) : fullHtml; entry.loading = false; entry.error = null; }
            if (token !== loadSeq) return;
            setArtifactHtml(fullHtml);
            content.loading = false;
            content.error = null;
            forceRender?.();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (token !== loadSeq) return;
            content.loading = false;
            content.error = String(e?.message || e);
            forceRender?.();
        });
}

/** IMAGE loader: nothing to fetch — the <img> renders content.url directly. */
function loadImage(opts: { name: string; url?: string | null }, _token: number, entry: CacheEntry | null) {
    resetHtml();
    resetPdf();
    resetCode();
    if (!opts.url) {
        content.loading = false;
        content.error = "No image source";
        return;
    }
    // The <img> tag streams the url itself; no manual fetch/decode needed. A
    // FRESH image opens at fit (scale 1); a cache RESTORE keeps the saved view
    // (applyCachedView already populated imgView), so only reset on a fresh load.
    if (entry) entry.loading = false;
    resetImgView();
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

/** Show a file in the panel body. Returns "noop" (already shown), "cache"
 *  (restored from cache, no fetch) or "fetch" (a fresh fetch was kicked off).
 *  The shared engine behind both load() (chip click) and restoreDescriptor()
 *  (channel return). It picks the renderer, hits/populates the cache, and bumps
 *  the load token. It does NOT touch open-state / channel bookkeeping — the
 *  callers do that around it. */
function showContent(opts: { name: string; html?: string | null; url?: string | null; type: ContentType; noCache?: boolean }): "noop" | "cache" | "fetch" {
    const name = opts.name || "file";
    const type = opts.type;
    const url = opts.url ?? null;
    const key = opts.html != null ? null : cacheKeyFor(url, type);

    // --- same file already shown? -> no-op (keep DOM, scroll, zoom as-is) -----
    // A retry (noCache) skips the no-op shortcut so it actually re-fetches.
    if (!opts.noCache && key != null && key === activeCacheKey && content.name != null && content.error == null) {
        content.name = name;
        activeDescriptor = { name, url: url as string, type };
        return "noop";
    }

    // Leaving the current file: snapshot its live view-state into its entry.
    snapshotActiveView();

    // --- cache hit on a DIFFERENT file -> instant restore (no fetch) ----------
    // A retry (noCache) skips the cache and always re-fetches.
    const hit = !opts.noCache && key != null ? contentCache.get(key) : null;
    if (hit && hit.error == null && !hit.loading) {
        loadSeq += 1; // supersede any in-flight loader
        content.seq += 1; // new body identity (different file)
        hit.name = name; // honour the (possibly fresh) display name
        mountFromCache(hit);
        activeDescriptor = { name, url: hit.url, type: hit.type };
        return "cache";
    }

    // --- miss (or inline html / errored entry) -> fetch + populate cache ------
    const token = ++loadSeq;
    content.name = name;
    content.url = url;
    content.error = null;
    content.binary = false;
    content.seq += 1;
    content.type = type;

    // Build a fresh cache entry for url-backed files (inline html isn't cached).
    let entry: CacheEntry | null = null;
    if (key != null && url != null) {
        // If a stale entry for this key exists (e.g. an errored one, or one whose
        // fetch is still in flight after we navigated away and came back), dispose
        // it first so its half-built doc can't leak when its loader resolves.
        const prior = contentCache.get(key);
        if (prior) { contentCache.delete(key); disposeCacheEntry(prior); }
        entry = { key, name, type, url, codeLang: "plaintext", loading: true, view: {} };
        contentCache.set(key, entry);
        activeCacheKey = key;
        cacheTouch(entry);
    } else {
        activeCacheKey = null;
    }
    // a brand-new load opens at the default view (no cached view to apply).
    pendingScrollTop = null;

    if (type === "pdf") loadPdf(opts, token, entry);
    else if (type === "image") loadImage(opts, token, entry);
    else if (type === "code") loadCode(opts, token, entry);
    else if (type === "markdown") loadMarkdown(opts, token, entry);
    else if (type === "unknown") loadUnknown(opts, token, entry);
    else loadHtml(opts, token, entry);

    // Inline-html artifacts (no url) can't be re-loaded by descriptor, so they
    // are NOT remembered per-channel (descriptor needs a url).
    activeDescriptor = url ? { name, url, type } : null;
    return "fetch";
}

/** CONTENT-TYPE ROUTER. Load anything into the dock panel BODY and open it.
 *  Backed by the content cache: re-clicking the file already shown is a no-op
 *  (no fetch, no re-render, no flicker); clicking a different file we've seen
 *  restores it instantly from cache (no fetch); only a genuinely new file
 *  fetches. The view-state of the file we're leaving is snapshotted first. */
export function load(opts: { name: string; html?: string | null; url?: string | null; type?: ContentType; noCache?: boolean }) {
    const result = showContent({ name: opts.name, html: opts.html, url: opts.url, type: detectType(opts), noCache: opts.noCache });

    // Open FIRST, then persist — so the saved per-channel state records open:true.
    state.open = true;
    lsSet(LS_OPEN, "1");
    saveCurrentChannelState();
    ensureHost();
    applyOpenState();
    // A no-op didn't change the body; everything else needs a render.
    if (result !== "noop") forceRender?.();
}

/** Re-fetch the file currently shown, bypassing both the in-memory content cache
 *  and the HTTP cache. Invoked by the error card's "Try again" button — the active
 *  descriptor (name/url/type) is re-loaded fresh so a transient/expired-link
 *  failure can recover without the user re-clicking the original chip. */
export function retryActiveLoad() {
    const d = activeDescriptor;
    if (!d || !d.url) return;
    load({ name: d.name || "file", url: d.url, type: d.type, noCache: true });
}

/** Clear the loaded content, returning the body to the placeholder. The file is
 *  kept in the cache (so reopening it is still instant); we just detach it. */
export function clearArtifact() {
    snapshotActiveView();
    content.name = null;
    content.type = "html";
    resetHtml();
    resetPdf();
    resetCode();
    content.url = null;
    content.loading = false;
    content.error = null;
    activeCacheKey = null;
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

/** Load a remembered descriptor WITHOUT re-saving channel state (avoid loops).
 *  Goes through the content cache via showContent: a channel we return to
 *  re-shows its file from cache instantly (no fetch, view-state preserved); only
 *  an evicted file is re-fetched. */
function restoreDescriptor(d: ChannelDescriptor) {
    const type = d.type || detectType({ url: d.url, name: d.name });
    showContent({ name: d.name || "file", url: d.url, type });
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
        // restore: open + re-load the remembered file (cache makes this instant).
        state.open = true;
        lsSet(LS_OPEN, "1");
        restoreDescriptor(mem.descriptor);
        ensureHost();
        applyOpenState();
        forceRender?.();
    } else {
        // nothing remembered (or it was closed) -> empty + closed panel. Snapshot
        // the outgoing file's view first so returning to ITS channel restores it.
        snapshotActiveView();
        clearLoadedContent();
        activeDescriptor = null;
        state.open = mem ? mem.open : false;
        lsSet(LS_OPEN, state.open ? "1" : "0");
        applyOpenState();
        forceRender?.();
    }
}

/** Clear only the loaded body (not the descriptor / channel bookkeeping). The
 *  file stays cached; we just detach the live pointer (no doc destroy here). */
function clearLoadedContent() {
    content.name = null;
    content.type = "html";
    resetHtml();
    resetPdf();
    resetCode();
    content.url = null;
    content.loading = false;
    content.error = null;
    activeCacheKey = null;
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
    // per-page DOM + geometry + lazy-raster bookkeeping, indexed [0..numPages-1].
    // A page's box is built up-front (cheap); its canvas is only rastered + its
    // text layer only built when it nears the viewport (or is targeted by a jump
    // / needed by find). `rasterScale` records the scale the bitmap was drawn at
    // so a later zoom/resize knows to re-raster; `textBuilt` gates text-layer
    // construction; `rendering` guards against overlapping raster of one page.
    const pagesRef = useRef([] as Array<{
        n: number; // 1-based page number
        wrap: HTMLDivElement;
        canvas: HTMLCanvasElement;
        textDiv: HTMLDivElement;
        baseW: number; // unscaled page width (pdf units @ scale 1)
        baseH: number;
        page: any | null; // cached pdfjs PDFPageProxy (lazy)
        rasterScale: number; // scale the canvas bitmap was drawn at (0 = blank)
        textScale: number; // scale the text layer was built at (0 = none)
        rendering: boolean;
    }>);
    // The UNIFORM document scale the pages are CURRENTLY sized at. The page boxes
    // are sized via the container's `--scale-factor`; live resize just re-points
    // that variable (renderScale × dragRatio) so the whole column reflows +
    // visually scales in one shot, then drag-end re-rasters the visible pages.
    const renderScaleRef = useRef(1);
    // flat list of match OCCURRENCES in document order. Each entry is one
    // substring hit (NOT a whole span): `range` is the live DOM Range we paint via
    // the CSS Custom Highlight API. When a page's text layer is rebuilt (zoom /
    // resize replaces its spans, detaching old Ranges) that page's entries are
    // re-collected fresh (reapplyFindOnPage / runFind), so the Ranges stay valid.
    const matchesRef = useRef([] as Array<{ page: number; range: Range }>);
    // IntersectionObserver that rasters pages as they near the viewport.
    const ioRef = useRef(null as IntersectionObserver | null);

    // The scrollable ancestor (.dockview-body) so we can scroll pages into view.
    const scroller = () => containerRef.current?.closest(".dockview-body") as HTMLElement | null;

    useEffect(() => {
        const host = containerRef.current;
        if (!host) return;

        const PDF_SIDE_INSET = 16;
        const dpr = window.devicePixelRatio || 1;
        const availWidth = (): number => {
            const sc = scroller();
            return Math.max(1, (sc?.clientWidth || host.clientWidth || state.width) - PDF_SIDE_INSET);
        };

        // Raster ONE page's canvas (+ build its text layer) at the current
        // document scale, if it isn't already current. Idempotent + reentrancy-
        // guarded so the IntersectionObserver and jumps can call it freely.
        const rasterPage = async (idx: number) => {
            const docToken = content.pdf.renderToken;
            const p = pagesRef.current[idx];
            if (!p) return;
            const docScale = renderScaleRef.current;
            // already crisp at this scale (and text built) — nothing to do.
            if (p.rasterScale === docScale && p.textScale === docScale) return;
            if (p.rendering) return;
            p.rendering = true;
            try {
                const doc = content.pdf.doc;
                if (!doc) return;
                if (!p.page) {
                    try { p.page = await doc.getPage(p.n); } catch { return; }
                    if (docToken !== content.pdf.renderToken) return;
                }
                const viewport = p.page.getViewport({ scale: docScale });
                // canvas raster (crisp at docScale × dpr)
                if (p.rasterScale !== docScale) {
                    p.canvas.width = Math.floor(viewport.width * dpr);
                    p.canvas.height = Math.floor(viewport.height * dpr);
                    const ctx = p.canvas.getContext("2d");
                    if (!ctx) return;
                    try {
                        await p.page.render({
                            canvasContext: ctx,
                            viewport,
                            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
                        }).promise;
                    } catch { return; } // render cancelled
                    if (docToken !== content.pdf.renderToken) return;
                    p.rasterScale = docScale;
                }
                // text layer (selectable). rebuilt on scale change so span boxes
                // match the new geometry. best-effort — never throws upward.
                if (p.textScale !== docScale) {
                    try {
                        const textContent = await p.page.getTextContent();
                        if (docToken !== content.pdf.renderToken) return;
                        p.textDiv.replaceChildren();
                        const tl = new (pdfjsLib as any).TextLayer({
                            textContentSource: textContent,
                            container: p.textDiv,
                            viewport
                        });
                        await tl.render();
                        p.textScale = docScale;
                        // a live find must light up matches on a freshly-built page
                        if (pdfView.findOpen && pdfView.findQuery) reapplyFindOnPage(idx);
                    } catch { /* text layer optional */ }
                }
            } finally {
                p.rendering = false;
            }
        };

        // Raster the page band around `centerPage` (1-based): the page + a few
        // neighbours each way, so scrolling never shows a blank page.
        const RASTER_NEIGHBOURS = 2;
        const rasterAround = (centerPage: number) => {
            const lo = Math.max(0, centerPage - 1 - RASTER_NEIGHBOURS);
            const hi = Math.min(pagesRef.current.length - 1, centerPage - 1 + RASTER_NEIGHBOURS);
            for (let i = lo; i <= hi; i++) rasterPage(i);
        };

        // Build the page COLUMN: all wrap boxes sized to the uniform doc scale,
        // each holding an (initially blank) canvas + empty text layer. NO raster
        // here — that's lazy. This is the cheap pass that makes the first page
        // appear almost immediately regardless of page count.
        const buildLayout = async () => {
            const doc = content.pdf.doc;
            if (!doc) return;
            const myPass = ++passRef.current;
            const docToken = content.pdf.renderToken;

            const sc = scroller();
            const availW = availWidth();
            const availH = Math.max(1, (sc?.clientHeight || 600) - PDF_SIDE_INSET);
            lastWidthRef.current = host.clientWidth;

            // Uniform document scale from the WIDEST page (so a fit-width column
            // never overflows + pages keep relative sizes). Pre-scan viewports —
            // cheap (no raster), and needed so the column has correct heights.
            let refW = 0;
            let refH = 0;
            for (let n = 1; n <= doc.numPages; n++) {
                if (myPass !== passRef.current || docToken !== content.pdf.renderToken) return;
                let pg: any;
                try { pg = await doc.getPage(n); } catch { return; }
                const vp = pg.getViewport({ scale: 1 });
                if (vp.width > refW) { refW = vp.width; refH = vp.height; }
            }
            if (!refW) return;
            const fitScale = pdfView.fit === "page"
                ? Math.min(availW / refW, availH / refH)
                : availW / refW;
            const docScale = fitScale * pdfView.zoom;
            renderScaleRef.current = docScale;
            host.style.setProperty("--scale-factor", String(docScale));

            matchesRef.current = [];
            ioRef.current?.disconnect();

            const built: typeof pagesRef.current = [];
            const frag = document.createDocumentFragment();
            for (let n = 1; n <= doc.numPages; n++) {
                if (myPass !== passRef.current || docToken !== content.pdf.renderToken) return;
                let page: any;
                try { page = await doc.getPage(n); } catch { return; }
                const base = page.getViewport({ scale: 1 });

                const wrap = document.createElement("div");
                wrap.className = "dockview-pdf-page-wrap";
                wrap.style.width = `round(down, var(--scale-factor) * ${base.width}px, 1px)`;
                wrap.style.height = `round(down, var(--scale-factor) * ${base.height}px, 1px)`;
                wrap.setAttribute("data-page", String(n));

                const canvas = document.createElement("canvas");
                canvas.className = "dockview-pdf-page";
                wrap.appendChild(canvas);

                const textDiv = document.createElement("div");
                textDiv.className = "textLayer";
                textDiv.style.setProperty("--total-scale-factor", "var(--scale-factor)");
                wrap.appendChild(textDiv);

                frag.appendChild(wrap);
                built.push({ n, wrap, canvas, textDiv, baseW: base.width, baseH: base.height, page, rasterScale: 0, textScale: 0, rendering: false });
            }
            if (myPass !== passRef.current || docToken !== content.pdf.renderToken) return;
            host.replaceChildren(frag);
            pagesRef.current = built;

            // Observe every page; raster those near the viewport. A generous
            // rootMargin pre-rasters one screenful ahead/behind so scrolling
            // stays smooth. The scroller is the root.
            const io = new IntersectionObserver((entries) => {
                for (const e of entries) {
                    if (!e.isIntersecting) continue;
                    const n = parseInt((e.target as HTMLElement).getAttribute("data-page") || "0", 10);
                    if (n) rasterAround(n);
                }
            }, { root: scroller(), rootMargin: "150% 0px", threshold: 0.01 });
            ioRef.current = io;
            for (const p of built) io.observe(p.wrap);

            // Restore scroll/page: a cache restore lands on the saved scrollTop;
            // otherwise honour any saved page (e.g. zoom re-layout keeps the page
            // the user was on). Then raster the landing band immediately so the
            // first visible page paints without waiting on the observer.
            if (pendingScrollTop != null) {
                consumePendingScroll();
            } else if (pdfView.page > 1) {
                const p = built[Math.min(built.length, pdfView.page) - 1];
                if (sc && p) sc.scrollTop = Math.max(0, p.wrap.offsetTop - 8);
            }
            updateCurrentPage();
            rasterAround(pdfView.page || 1);
        };

        // Re-scale the EXISTING column to a new fit×zoom WITHOUT rebuilding the
        // DOM: recompute the uniform doc scale, re-point --scale-factor (boxes
        // resize via CSS), invalidate every page's raster/text (so it re-rasters
        // crisp at the new scale when next near the viewport), and immediately
        // re-raster the band the user is looking at. Scroll is preserved by
        // anchoring on the current page's top. Cheaper than buildLayout (no
        // viewport pre-scan, no DOM teardown) — used for zoom / window-resize /
        // drag-end. Returns false if there's no column yet (caller falls back to
        // buildLayout).
        const rescale = async (): Promise<boolean> => {
            const pages = pagesRef.current;
            if (!pages.length) return false;
            const docToken = content.pdf.renderToken;
            const sc = scroller();
            const availW = availWidth();
            const availH = Math.max(1, (sc?.clientHeight || 600) - PDF_SIDE_INSET);
            // widest page from cached base geometry (no pdf.js round-trip).
            let refW = 0, refH = 0;
            for (const p of pages) if (p.baseW > refW) { refW = p.baseW; refH = p.baseH; }
            if (!refW) return false;
            const fitScale = pdfView.fit === "page" ? Math.min(availW / refW, availH / refH) : availW / refW;
            const docScale = fitScale * pdfView.zoom;
            const prevScale = renderScaleRef.current || docScale;
            const ratio = docScale / prevScale;
            // anchor: remember the current page + its in-page scroll offset so
            // zoom keeps the user roughly where they were.
            const anchorIdx = Math.max(0, (pdfView.page || 1) - 1);
            const anchor = pages[anchorIdx];
            const beforeTop = anchor ? anchor.wrap.offsetTop : 0;
            const scrollBefore = sc ? sc.scrollTop : 0;
            const delta = scrollBefore - beforeTop; // px into the anchor page

            renderScaleRef.current = docScale;
            host.style.setProperty("--scale-factor", String(docScale));
            lastWidthRef.current = host.clientWidth;
            // invalidate rasters (boxes already resized via the variable).
            for (const p of pages) { p.rasterScale = 0; p.textScale = 0; }

            // re-anchor scroll to the same page (its offsetTop moved as boxes
            // resized) + scale the in-page offset by the zoom ratio.
            if (sc && anchor) sc.scrollTop = Math.max(0, anchor.wrap.offsetTop + Math.round(delta * ratio));
            // re-raster the band the user is on.
            rasterAround(pdfView.page || 1);
            // if a find is active, re-light it (text layers were invalidated).
            if (pdfView.findOpen && pdfView.findQuery) runFind(pdfView.findQuery, false);
            if (docToken !== content.pdf.renderToken) return true;
            return true;
        };

        // re-lay-out + re-raster the visible band at a new scale. Prefer the
        // cheap in-place rescale; fall back to a full rebuild if no column yet.
        const renderAll = async () => { if (!(await rescale())) await buildLayout(); };

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
        // Matching is OCCURRENCE-based (Acrobat / browser-viewer semantics): every
        // substring hit is one match, and we paint each hit's exact character
        // RANGE — not the enclosing span — via the CSS Custom Highlight API
        // (`CSS.highlights` + `Highlight` + `Range`). That API draws over arbitrary
        // text ranges WITHOUT mutating the DOM, so the pdf.js textLayer span model
        // (percentage left/top + per-span --font-height / --scale-x transforms) is
        // left completely untouched — no span splitting, no class soup, and it
        // coexists with native ::selection. Two registries ("dockview-pdf-find" =
        // all hits, dim; "dockview-pdf-find-active" = the current hit, strong) give
        // the standard all-vs-current distinction. Each match keeps the live Range;
        // re-rastering a page replaces its spans, so we rebuild that page's matches
        // (and thus its Ranges) when its text layer is rebuilt.
        const HL_ALL = "dockview-pdf-find";
        const HL_ACTIVE = "dockview-pdf-find-active";
        const CSSwithHL = (CSS as any);
        const HighlightCtor = (window as any).Highlight;
        const hlSupported = typeof HighlightCtor === "function" && !!CSSwithHL?.highlights;
        const hlAll: any = hlSupported ? new HighlightCtor() : null;
        const hlActive: any = hlSupported ? new HighlightCtor() : null;
        if (hlSupported) {
            CSSwithHL.highlights.set(HL_ALL, hlAll);
            CSSwithHL.highlights.set(HL_ACTIVE, hlActive);
        }
        // Rebuild the two highlight registries from the current match Ranges (the
        // active match goes ONLY into the active registry so its stronger paint
        // isn't muddied by the dim layer underneath).
        const repaintHighlights = () => {
            if (!hlSupported) return;
            hlAll.clear();
            hlActive.clear();
            const activeIdx = pdfView.findActive - 1;
            for (let i = 0; i < matchesRef.current.length; i++) {
                const r = matchesRef.current[i].range;
                if (i === activeIdx) hlActive.add(r);
                else hlAll.add(r);
            }
        };
        const clearHighlights = () => {
            matchesRef.current = [];
            if (hlSupported) { hlAll.clear(); hlActive.clear(); }
        };
        // Build the text layer of a page WITHOUT rastering its canvas (find needs
        // the spans; getTextContent is raster-free). Used so find covers pages
        // that have never been scrolled to. Returns once the spans exist.
        const ensureTextLayer = async (idx: number) => {
            const docToken = content.pdf.renderToken;
            const p = pagesRef.current[idx];
            if (!p || p.textScale === renderScaleRef.current) return;
            const doc = content.pdf.doc;
            if (!doc) return;
            if (!p.page) {
                try { p.page = await doc.getPage(p.n); } catch { return; }
                if (docToken !== content.pdf.renderToken) return;
            }
            try {
                const viewport = p.page.getViewport({ scale: renderScaleRef.current });
                const textContent = await p.page.getTextContent();
                if (docToken !== content.pdf.renderToken) return;
                p.textDiv.replaceChildren();
                const tl = new (pdfjsLib as any).TextLayer({ textContentSource: textContent, container: p.textDiv, viewport });
                await tl.render();
                p.textScale = renderScaleRef.current;
            } catch { /* optional */ }
        };
        // Find every occurrence of `q` inside ONE page's text layer and return the
        // located Ranges in reading order. Matching is per-span (a span = one
        // glyph run pdf.js laid out); occurrences that straddle two spans are NOT
        // matched (see report — scoped out). Walks each span's text nodes and uses
        // indexOf in a loop so repeated hits inside a single span each become their
        // own Range (the bug fix: the old code counted such a span ONCE).
        const collectPageMatches = (idx: number, q: string): Range[] => {
            const p = pagesRef.current[idx];
            if (!p) return [];
            const cmp = pdfView.findCase ? q : q.toLowerCase();
            const out: Range[] = [];
            const spans = p.textDiv.querySelectorAll("span");
            for (const span of Array.from(spans)) {
                // pdf.js puts the glyph text in a single text node per span.
                const node = span.firstChild;
                if (!node || node.nodeType !== Node.TEXT_NODE) continue;
                const raw = node.textContent || "";
                if (!raw) continue;
                const hay = pdfView.findCase ? raw : raw.toLowerCase();
                let from = 0;
                for (;;) {
                    const at = hay.indexOf(cmp, from);
                    if (at < 0) break;
                    const range = document.createRange();
                    range.setStart(node, at);
                    range.setEnd(node, at + cmp.length);
                    out.push(range);
                    from = at + cmp.length; // non-overlapping, like browser find
                }
            }
            return out;
        };
        // Re-locate matches for a SINGLE page whose text layer was just (re)built —
        // both for late-rastered pages during a live find and after a zoom/resize
        // rebuild invalidated the old Ranges. Replaces that page's slice in the
        // ordered match list, preserving the active occurrence's identity when
        // possible so next/prev don't jump around under the user.
        const reapplyFindOnPage = (idx: number) => {
            const q = pdfView.findQuery.trim();
            if (!q || !hlSupported) return;
            const page = idx + 1;
            // remember which match was active (so we can re-aim at the same page)
            const activeWasOnPage = matchesRef.current[pdfView.findActive - 1]?.page === page;
            const fresh = collectPageMatches(idx, q).map(range => ({ page, range }));
            // rebuild the ordered list: drop this page's old entries, splice fresh
            // ones in at the page-ordered position. Matches are kept in page order;
            // within a page collectPageMatches already returns reading order.
            const before = matchesRef.current.filter(m => m.page < page);
            const after = matchesRef.current.filter(m => m.page > page);
            matchesRef.current = [...before, ...fresh, ...after];
            pdfView.findMatches = matchesRef.current.length;
            // keep a sane active index: if it was on this page, re-point at this
            // page's first fresh hit; otherwise leave it (clamped) where it was.
            if (pdfView.findMatches === 0) pdfView.findActive = 0;
            else if (activeWasOnPage && fresh.length) pdfView.findActive = before.length + 1;
            else if (pdfView.findActive === 0) pdfView.findActive = 1;
            else if (pdfView.findActive > pdfView.findMatches) pdfView.findActive = pdfView.findMatches;
            repaintHighlights();
            forceRender?.();
        };
        const runFind = async (query: string, jump: boolean) => {
            clearHighlights();
            pdfView.findMatches = 0;
            pdfView.findActive = 0;
            const q = query.trim();
            if (!q) { forceRender?.(); return; }
            if (!hlSupported) { forceRender?.(); return; }
            const myToken = content.pdf.renderToken;
            const pages = pagesRef.current;
            // Build text layers for every page (raster-free) so find sees the
            // WHOLE document, not just the pages that happen to be rastered.
            for (let i = 0; i < pages.length; i++) {
                await ensureTextLayer(i);
                if (myToken !== content.pdf.renderToken || pdfView.findQuery.trim() !== q) return;
            }
            const all: typeof matchesRef.current = [];
            for (let i = 0; i < pages.length; i++) {
                for (const range of collectPageMatches(i, q)) all.push({ page: i + 1, range });
            }
            matchesRef.current = all;
            pdfView.findMatches = all.length;
            if (all.length > 0) {
                pdfView.findActive = 1;
                if (jump) focusMatch(0);
                else { repaintHighlights(); forceRender?.(); }
            } else {
                repaintHighlights();
                forceRender?.();
            }
        };
        const focusMatch = (idx: number) => {
            const m = matchesRef.current[idx];
            if (!m) return;
            pdfView.findActive = idx + 1;
            repaintHighlights();
            // ensure the match's page (+ neighbours) are crisp before we land.
            rasterAround(m.page);
            // scroll the occurrence's range into view (centre). Use the start
            // container's parent element — Range has no scrollIntoView itself.
            const anchor = (m.range.startContainer.parentElement || null);
            anchor?.scrollIntoView({ block: "center", behavior: "smooth" });
            forceRender?.();
        };

        // --- scroll a given (1-based) page to the top of the viewport ---------
        const scrollToPage = (n: number) => {
            const pages = pagesRef.current;
            const idx = Math.max(1, Math.min(pages.length, n)) - 1;
            const p = pages[idx];
            const sc = scroller();
            if (!p || !sc) return;
            // raster the target band UP FRONT so a jump to a far, un-rastered page
            // lands on a painted page (the IO would only catch it after the scroll
            // animation finishes). Smooth scroll a short hop, instant a long one.
            rasterAround(idx + 1);
            const far = Math.abs(p.wrap.offsetTop - sc.scrollTop) > sc.clientHeight * 3;
            sc.scrollTo({ top: Math.max(0, p.wrap.offsetTop - 8), behavior: far ? "auto" : "smooth" });
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
            toggleFindCase: () => { pdfView.findCase = !pdfView.findCase; runFind(pdfView.findQuery, false); forceRender?.(); },
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
            ioRef.current?.disconnect();
            ioRef.current = null;
            // drop cached PDFPageProxy refs (the doc itself lives in the cache).
            pagesRef.current = [];
            matchesRef.current = [];
            // CSS.highlights is a GLOBAL document registry — tear our entries down
            // so a stale highlight can't survive into the next-mounted PDF.
            if (hlSupported) { CSSwithHL.highlights.delete(HL_ALL); CSSwithHL.highlights.delete(HL_ACTIVE); }
            if (pdfControls === ctrls) pdfControls = null;
        };
    }, [content.pdf.renderToken, content.seq]);

    return React.createElement("div", {
        key: content.seq,
        ref: containerRef,
        className: "dockview-pdf-container",
        // Focusable so a click into the PDF body gives the panel keyboard focus;
        // page-nav / zoom keys are gated on that focus (never on hover).
        tabIndex: 0
    });
}

// The FIND bar is a small one-row dropdown surface (input + counter + Aa +
// prev/next + close). Discord may intercept the global Ctrl+F, so this is our
// own UI. It is a GENERIC, reusable component (PERF-4 / CODE-2 prep): the PDF
// viewer drives it today, the code viewer will reuse it verbatim. All behaviour
// (query, counter, case, next/prev, close) is supplied through a `FindBarModel`
// so the bar itself knows nothing about pdf.js vs code — only how to lay the
// row out. No behaviour change from the old PdfFindBar: same fields, same keys,
// same handlers, just parameterised.
interface FindBarModel {
    query: string;
    matches: number;
    active: number; // 1-based index of the active match (0 = none)
    caseSensitive: boolean;
    placeholder: string;
    setQuery: (q: string) => void;
    next: () => void;
    prev: () => void;
    toggleCase: () => void;
    close: () => void;
}

/** Reusable find bar. `model` wires it to whichever viewer is active. */
function FindBar({ model }: { model: FindBarModel }) {
    const { useRef, useEffect } = React;
    const inputRef = useRef(null as HTMLInputElement | null);
    // focus the input when the bar opens
    useEffect(() => { inputRef.current?.focus(); }, []);
    const counter = model.matches > 0
        ? `${model.active}/${model.matches}`
        : (model.query ? "0/0" : "");
    return React.createElement(
        "div",
        { className: "dockview-find" },
        React.createElement("input", {
            ref: inputRef,
            className: "dockview-find-input",
            type: "text",
            placeholder: model.placeholder,
            "aria-label": model.placeholder,
            value: model.query,
            onChange: (e: any) => model.setQuery(e.target.value),
            onKeyDown: (e: any) => {
                e.stopPropagation();
                if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) model.prev(); else model.next(); }
                else if (e.key === "Escape") { e.preventDefault(); model.close(); }
            }
        }),
        React.createElement("span", { className: "dockview-find-count" }, counter),
        // Case-sensitivity toggle (default off). Text "Aa" rather than an icon —
        // the universal find-bar convention (browsers, VS Code, Acrobat).
        React.createElement("button", {
            key: "find-case",
            type: "button",
            className: "dockview-tool-btn dockview-find-case" + (model.caseSensitive ? " dockview-tool-btn-active" : ""),
            "aria-label": STRINGS.find.matchCase,
            "aria-pressed": model.caseSensitive,
            title: STRINGS.find.matchCase,
            onMouseDown: (e: any) => e.preventDefault(), // keep focus in the input
            onClick: () => model.toggleCase()
        }, "Aa"),
        toolBtn("find-prev", STRINGS.find.prevMatch,
            "M15.3 5.3a1 1 0 0 1 0 1.4L10 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0Z",
            () => model.prev()),
        toolBtn("find-next", STRINGS.find.nextMatch,
            "M8.7 5.3a1 1 0 0 0 0 1.4L14 12l-5.3 5.3a1 1 0 0 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z",
            () => model.next()),
        toolBtn("find-close", STRINGS.find.close,
            "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z",
            () => model.close())
    );
}

/** The PDF find bar = the generic FindBar wired to the PDF view-state. */
function PdfFindBar() {
    return React.createElement(FindBar, {
        model: {
            query: pdfView.findQuery,
            matches: pdfView.findMatches,
            active: pdfView.findActive,
            caseSensitive: pdfView.findCase,
            placeholder: STRINGS.find.placeholderPdf,
            setQuery: (q: string) => pdfControls?.setFindQuery(q),
            next: () => pdfControls?.findNext(),
            prev: () => pdfControls?.findPrev(),
            toggleCase: () => pdfControls?.toggleFindCase(),
            close: () => pdfControls?.toggleFind()
        }
    });
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

// ---------------------------------------------------------------------------
// CODE viewer — line DOM + progressive (chunked) highlight + in-panel find.
// ---------------------------------------------------------------------------
// A 50k-line file used to highlight + build the whole <pre> in ONE synchronous
// pass inside React render: ~4–6 s of main-thread block, a hard UI freeze, with
// no incremental paint at all (measured: a single 4.2 s longtask). We replace
// that with a line-addressable DOM filled progressively:
//   1. First paint is PLAIN TEXT — every line is escaped (no hljs) and written
//      in ONE shot. That's the only blocking step and it's cheap (a string
//      build + innerHTML), so the file shows instantly; nothing is ever blank.
//   2. hljs then runs in CHUNKS scheduled across rAF/idle ticks (~CHUNK_LINES
//      lines per tick). Each highlighted chunk's HTML is split back into its
//      lines and patched into the already-painted plain rows. The parser's
//      `top` state is threaded chunk→chunk so a block comment / template literal
//      that straddles a chunk boundary stays correctly coloured.
//   3. Find matches the ORIGINAL source string, so a match in a not-yet-
//      highlighted region still counts and can be scrolled to (the highlight
//      progress and the find index are independent).
// No virtualisation: the full line DOM keeps native selection, "copy whole
// file", gutter alignment, and "scroll to a match anywhere" all trivially
// correct — and progressive highlight already removes the freeze (the reason
// virtualisation was on the table). The gutter is a parallel per-line column so
// rows stay aligned in BOTH nowrap and word-wrap modes.

// Tuning for the progressive code renderer (chosen by measurement on a 50k-line
// file): FIRST_BATCH rows paint synchronously (instant top-of-file), then rows
// stream in ROW_BATCH at a time and highlight CHUNK_LINES at a time — each tick
// kept well under a frame so the main thread never stalls.
// Tuning for the progressive code renderer, picked by measurement on a 50k-line
// file. FIRST_BATCH rows paint synchronously (instant top-of-file, <150 ms).
// Rows then stream in ROW_BATCH at a time. Highlighting is viewport-driven: the
// frontier advances CHUNK_LINES at a time, only as far as the visible band needs
// (plus a buffer) on mount/scroll, then idles ahead. Each highlight step is a
// short task — the whole file is never bulk-highlighted in one burst.
const FIRST_BATCH = 200;  // rows painted synchronously on mount (one screenful+)
const ROW_BATCH = 1500;   // plain-text rows appended per scheduled tick
const CHUNK_LINES = 250;  // source lines highlighted per frontier step

/** Split ONE chunk of hljs HTML (which may contain spans crossing `\n`) into an
 *  array of per-line HTML strings, re-balancing open <span> tags at each line
 *  break: a span still open at a line's end is closed there and re-opened at the
 *  next line's start, so every line is independently valid markup. `expected`
 *  is how many source lines this chunk held (so a chunk ending in a newline
 *  yields the right count). Standard hljs-line-numbers technique. */
function splitHighlightLines(html: string, expected: number): string[] {
    const lines: string[] = [];
    const openStack: string[] = []; // the literal <span ...> open tags currently open
    let buf = "";
    let i = 0;
    const n = html.length;
    const pushLine = () => {
        // close every still-open span for THIS line, deepest first
        let tail = "";
        for (let k = openStack.length - 1; k >= 0; k--) tail += "</span>";
        lines.push(buf + tail);
        // re-open them at the start of the NEXT line, outermost first
        buf = openStack.join("");
    };
    while (i < n) {
        const ch = html[i];
        if (ch === "\n") {
            pushLine();
            i++;
            continue;
        }
        if (ch === "<") {
            // a tag: either <span ...>, </span>, or (rare) other markup we keep verbatim
            const gt = html.indexOf(">", i);
            const tag = gt < 0 ? html.slice(i) : html.slice(i, gt + 1);
            if (/^<\/span/i.test(tag)) {
                openStack.pop();
            } else if (/^<span/i.test(tag)) {
                openStack.push(tag);
            }
            buf += tag;
            i = gt < 0 ? n : gt + 1;
            continue;
        }
        buf += ch;
        i++;
    }
    // final line (no trailing newline consumed)
    pushLine();
    // hljs may emit a trailing empty segment when the source ended in "\n";
    // normalise to exactly `expected` lines.
    while (lines.length < expected) lines.push("");
    if (lines.length > expected) lines.length = expected;
    return lines;
}

/** The live code-render controller: owns the line DOM, the progressive-highlight
 *  scheduler, and the find state for the currently-mounted code file. Recreated
 *  per file (keyed on content.seq); torn down by CodeBody's effect cleanup. */
interface CodeController {
    seq: number;
    lineEls: HTMLElement[]; // body line rows, 1:1 with source lines (sparse until built)
    lines: string[]; // ORIGINAL source lines (for find — never escaped)
    lang: string;
    rowsBuilt: number; // how many plain-text rows have been appended so far
    highlighted: boolean[]; // per-line: has hljs HTML been patched in yet?
    cancelled: boolean;
    rafId: number;
    // find
    findHl: any; // Highlight (all matches)
    findActiveHl: any; // Highlight (current match)
    matches: { line: number; start: number; end: number }[]; // offsets within a line
    pump: () => void; // the rAF pump (append rows / advance highlight frontier)
    ensureHighlighted: (target: number) => void; // catch the frontier up to a line
    onScroll: (() => void) | null; // scroll listener (drives the frontier)
    scroller: HTMLElement | null; // the .dockview-body element onScroll is bound to
    rebuildFind: (query: string) => void;
    focusMatch: (idx: number) => void;
    teardown: () => void;
}
let codeCtrl: CodeController | null = null;

/** CSS Custom Highlight API registries for code find (separate from the PDF
 *  ones). `dockview-code-find` = every match (dim), `…-active` = the current
 *  one (strong). Painted over Ranges into the line text nodes — works whether
 *  or not the line has been highlighted yet (Ranges target text, not spans). */
const HL_CODE_ALL = "dockview-code-find";
const HL_CODE_ACTIVE = "dockview-code-find-active";

/** Build the per-line code DOM + start progressive highlighting. Returns the
 *  controller (also stored in `codeCtrl`). Called once per code file mount. */
function buildCodeController(bodyEl: HTMLElement): CodeController {
    const code = content.code || "";
    const lang = content.codeLang;
    // Split into lines. A single trailing newline is NOT its own line (matches
    // the old gutter count + how editors show files).
    const bodyText = code.endsWith("\n") ? code.slice(0, -1) : code;
    const lines = bodyText.length ? bodyText.split("\n") : [""];
    const lineCount = lines.length;

    // The line NUMBER is a CSS ::before on each row (the `data-n` attribute), not
    // a second DOM column — that halves the node count (one element per line, not
    // two), keeps numbers perfectly aligned in both wrap modes, makes them non-
    // selectable for free (pseudo-elements never copy), and lets the gutter stick
    // during h-scroll via `position:sticky` on the ::before. So 50k lines = 50k
    // <div> rows, not 100k.

    // Build one row's markup. `inner` is the row's HTML (escaped plain text at
    // first, hljs HTML later); the line number rides on data-n.
    const ROW_OPEN = '<div class="dockview-code-line" data-n="';
    const rowHtml = (n: number, inner: string) =>
        ROW_OPEN + n + '">' + (inner.length ? inner : "​") + "</div>";

    const lineEls: HTMLElement[] = new Array(lineCount);

    const CSSwithHL = (CSS as any);
    const HighlightCtor = (window as any).Highlight;
    const hlSupported = typeof HighlightCtor === "function" && !!CSSwithHL?.highlights;
    const findHl: any = hlSupported ? new HighlightCtor() : null;
    const findActiveHl: any = hlSupported ? new HighlightCtor() : null;
    if (hlSupported) {
        CSSwithHL.highlights.set(HL_CODE_ALL, findHl);
        CSSwithHL.highlights.set(HL_CODE_ACTIVE, findActiveHl);
    }

    const ctrl: CodeController = {
        seq: content.seq,
        lineEls,
        lines,
        lang,
        rowsBuilt: 0,
        highlighted: new Array(lineCount).fill(false),
        cancelled: false,
        rafId: 0,
        findHl,
        findActiveHl,
        matches: [],
        pump: () => { /* set below */ },
        ensureHighlighted: () => { /* set below */ },
        onScroll: null,
        scroller: null,
        rebuildFind: () => { /* set below */ },
        focusMatch: () => { /* set below */ },
        teardown: () => { /* set below */ }
    };

    // --- phase 1: build PLAIN-TEXT rows, batched across rAF ticks --------------
    // Laying out 50k rows in one shot costs ~1.4 s. We instead append rows in
    // batches: the FIRST batch (one screenful + buffer) goes in synchronously so
    // the top of the file paints instantly (<300 ms), and the rest stream in over
    // the next few ticks, each batch a sub-100ms layout. Until a row exists it
    // can't be scrolled to, but the whole file finishes appending in well under a
    // second, before any find/scroll-to a far row would realistically happen.
    const appendRows = (from: number, to: number) => {
        let s = "";
        for (let i = from; i < to; i++) s += rowHtml(i + 1, escapeHtml(lines[i]));
        // parse into a fragment off-DOM, then attach once (one reflow per batch).
        const tmp = document.createElement("template");
        tmp.innerHTML = s;
        const frag = tmp.content;
        const kids = frag.children;
        for (let i = 0; i < kids.length; i++) lineEls[from + i] = kids[i] as HTMLElement;
        bodyEl.appendChild(frag);
        ctrl.rowsBuilt = to;
    };

    // --- find ----------------------------------------------------------------
    // Locate the text node inside a line row that holds character offset
    // [start,end). With highlighting on, a row may be several text nodes (one per
    // hljs span); we walk them accumulating length until the offset lands.
    const rangeForMatch = (lineIdx: number, start: number, end: number): Range | null => {
        const row = lineEls[lineIdx];
        if (!row) return null;
        const range = document.createRange();
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let acc = 0;
        let startSet = false;
        let node: Node | null;
        // The empty-line filler (​) has length 1 but the source line length
        // is 0 — a zero-width match can't land there, so such lines never match.
        while ((node = walker.nextNode())) {
            const text = node.textContent || "";
            // skip the zero-width filler so its phantom char doesn't shift offsets
            const len = (text === "​") ? 0 : text.length;
            if (!startSet && start <= acc + len) {
                range.setStart(node, Math.max(0, start - acc));
                startSet = true;
            }
            if (startSet && end <= acc + len) {
                range.setEnd(node, Math.max(0, end - acc));
                return range;
            }
            acc += len;
        }
        return null;
    };

    const repaintCodeMatches = () => {
        if (!hlSupported) return;
        findHl.clear();
        findActiveHl.clear();
        const activeIdx = codeView.findActive - 1;
        for (let i = 0; i < ctrl.matches.length; i++) {
            const m = ctrl.matches[i];
            const r = rangeForMatch(m.line, m.start, m.end);
            if (!r) continue;
            if (i === activeIdx) findActiveHl.add(r);
            else findHl.add(r);
        }
    };

    ctrl.rebuildFind = (query: string) => {
        ctrl.matches = [];
        const q = query;
        codeView.findMatches = 0;
        codeView.findActive = 0;
        if (!q || !hlSupported) { repaintCodeMatches(); forceRender?.(); return; }
        const cmp = codeView.findCase ? q : q.toLowerCase();
        const qlen = q.length;
        // Match against the ORIGINAL source lines (highlight-independent), one
        // line at a time so a Range maps to exactly one row.
        for (let li = 0; li < lines.length; li++) {
            const raw = lines[li];
            if (!raw) continue;
            const hay = codeView.findCase ? raw : raw.toLowerCase();
            let from = 0;
            for (;;) {
                const at = hay.indexOf(cmp, from);
                if (at < 0) break;
                ctrl.matches.push({ line: li, start: at, end: at + qlen });
                from = at + qlen; // non-overlapping, like browser find
            }
        }
        codeView.findMatches = ctrl.matches.length;
        codeView.findActive = ctrl.matches.length ? 1 : 0;
        repaintCodeMatches();
        if (ctrl.matches.length) ctrl.focusMatch(0);
        else forceRender?.();
    };

    ctrl.focusMatch = (idx: number) => {
        const m = ctrl.matches[idx];
        if (!m) return;
        codeView.findActive = idx + 1;
        // If the target row hasn't been appended yet (find raced ahead of the
        // streaming row build), build up to it NOW so we can paint + scroll to it.
        if (ctrl.rowsBuilt <= m.line) appendRows(ctrl.rowsBuilt, Math.min(lineCount, m.line + 1));
        // and bring the highlight frontier down to it so the jumped-to line shows
        // highlighted (not plain) — bounded catch-up, the idle pump finishes rest.
        ctrl.ensureHighlighted(m.line + 1);
        repaintCodeMatches();
        // scroll the matched row to the middle of the viewport.
        lineEls[m.line]?.scrollIntoView({ block: "center", behavior: "smooth" });
        forceRender?.();
    };

    ctrl.teardown = () => {
        ctrl.cancelled = true;
        if (ctrl.rafId) {
            try { (window.cancelAnimationFrame || window.clearTimeout)(ctrl.rafId); } catch { /* ignore */ }
            ctrl.rafId = 0;
        }
        if (ctrl.onScroll && ctrl.scroller) {
            ctrl.scroller.removeEventListener("scroll", ctrl.onScroll);
            ctrl.onScroll = null;
            ctrl.scroller = null;
        }
        // CSS.highlights is a GLOBAL registry — drop our entries so a stale code
        // highlight can't bleed into the next-mounted file.
        if (hlSupported) {
            try { CSSwithHL.highlights.delete(HL_CODE_ALL); CSSwithHL.highlights.delete(HL_CODE_ACTIVE); } catch { /* ignore */ }
        }
    };

    // --- highlighting: contiguous from the top, viewport-driven + idle-ahead ----
    // hljs runs forward from line 0, ALWAYS contiguous, carrying its parser `top`
    // state from one chunk to the next — that's what keeps a block comment /
    // template literal correct no matter how deep it straddles. We never bulk-
    // mutate all 50k rows in a burst (that triggered a multi-hundred-ms style/
    // layout recalc over the content-visibility subtree per burst): instead we
    // highlight only as far as the VIEWPORT needs (plus a buffer), then nudge a
    // little further every idle frame. A scroll keeps the highlight frontier
    // ahead of what's on screen; un-highlighted rows below the frontier are
    // already visible as plain text (never blank). Each highlight step is capped
    // at CHUNK_LINES so it stays a short task.
    const hl = getHighlighter();
    const canHighlight = !!(lang && lang !== "plaintext" && hl.getLanguage(lang));
    let hlNext = 0;        // first not-yet-highlighted line (frontier)
    let hlTop: any = null;  // hljs parser state AT the frontier
    const LINE_PX = 19.5;   // must match contain-intrinsic-size / line-height
    const VIEW_BUFFER = 1500; // px of look-ahead below the viewport to pre-highlight

    // Highlight ONE chunk forward from the frontier (≤ CHUNK_LINES lines). Cheap:
    // hljs+split+writes measured ~6 ms / 150 lines; the only real cost is the
    // engine recalc the mutation triggers, which is why we keep the touched band
    // small and frequent rather than one giant pass.
    const highlightOneChunk = () => {
        const from = hlNext;
        const to = Math.min(lineCount, from + CHUNK_LINES);
        if (from >= to) return;
        const chunkText = lines.slice(from, to).join("\n");
        let pieces: string[];
        try {
            const r = hl.highlightChunk(chunkText, lang, hlTop);
            hlTop = r.top;
            pieces = splitHighlightLines(r.html, to - from);
        } catch {
            pieces = lines.slice(from, to).map(escapeHtml);
            hlTop = null;
        }
        for (let i = from; i < to; i++) {
            const piece = pieces[i - from];
            if (lineEls[i]) lineEls[i].innerHTML = piece && piece.length ? piece : "​";
            ctrl.highlighted[i] = true;
        }
        hlNext = to;
        // text nodes of the rows we just replaced changed → restamp find matches.
        if (ctrl.matches.length) repaintCodeMatches();
    };

    // The line index the viewport (plus buffer) currently needs highlighted to.
    const neededLine = (): number => {
        const sc = bodyScroller();
        if (!sc) return Math.min(lineCount, FIRST_BATCH);
        // estimate the bottom-most visible line from the scroll offset (rows are
        // ~LINE_PX tall; a generous buffer + slack covers wrap-mode taller rows).
        const bottom = sc.scrollTop + sc.clientHeight + VIEW_BUFFER;
        return Math.min(lineCount, Math.ceil(bottom / LINE_PX) + 8);
    };

    // How far the idle pump should keep the frontier ahead of the viewport before
    // it goes quiet (resumes on the next scroll). Each highlightOneChunk mutates a
    // content-visibility subtree → a style/layout recalc, so we DON'T grind the
    // whole 50k-line file in the background; we keep a few screens ready and stop.
    const idleTarget = () => Math.min(lineCount, neededLine() + CHUNK_LINES * 4);
    // A far jump must not highlight thousands of lines in ONE task. Cap the
    // synchronous catch-up; the visible band beyond the cap stays plain text (a
    // beat) until the pump's frontier arrives — never blank.
    const MAX_SYNC_CHUNKS = 3;

    // The rAF pump. Priority 1: finish appending plain rows (so any row can be
    // scrolled to). Priority 2: advance the highlight frontier to idleTarget(),
    // one short chunk per frame, yielding between — then go quiet.
    const pump = () => {
        ctrl.rafId = 0;
        if (ctrl.cancelled) return;
        let more = false;
        if (ctrl.rowsBuilt < lineCount) {
            appendRows(ctrl.rowsBuilt, Math.min(lineCount, ctrl.rowsBuilt + ROW_BATCH));
            more = true;
        } else if (canHighlight && hlNext < idleTarget()) {
            highlightOneChunk();
            more = hlNext < idleTarget();
        }
        if (more) ctrl.rafId = (window.requestAnimationFrame || window.setTimeout)(pump) as unknown as number;
    };
    ctrl.pump = pump;

    // Drive the frontier toward a target line NOW (scroll / find-jump): a small
    // bounded synchronous catch-up so the visible band highlights promptly without
    // one giant task, then hand the rest to the idle pump.
    ctrl.ensureHighlighted = (target: number) => {
        if (!canHighlight) return;
        const cap = Math.min(lineCount, target);
        let n = 0;
        while (hlNext < cap && n++ < MAX_SYNC_CHUNKS) highlightOneChunk();
        if (hlNext < idleTarget() && !ctrl.rafId) {
            ctrl.rafId = (window.requestAnimationFrame || window.setTimeout)(pump) as unknown as number;
        }
    };

    // Scroll → keep the frontier ahead of the viewport (throttled via rAF).
    if (canHighlight) {
        const sc = bodyScroller();
        if (sc) {
            let scRaf = 0;
            const onScroll = () => {
                if (scRaf || ctrl.cancelled) return;
                scRaf = requestAnimationFrame(() => { scRaf = 0; ctrl.ensureHighlighted(neededLine()); });
            };
            sc.addEventListener("scroll", onScroll, { passive: true });
            ctrl.onScroll = onScroll;
            ctrl.scroller = sc;
        }
    }

    // First batch synchronous = instant top-of-file paint. If we're RESTORING a
    // saved scroll (cache return), build enough rows up front that the scroll
    // container is already tall enough to reach that offset — otherwise
    // consumePendingScroll would clamp to the short (still-streaming) height and
    // land too high. Each row is ~LINE_PX tall; cover the target + a screenful.
    let firstCount = FIRST_BATCH;
    if (pendingScrollTop != null) {
        const sc = bodyScroller();
        const view = sc ? sc.clientHeight : 0;
        const need = Math.ceil((pendingScrollTop + view) / LINE_PX) + FIRST_BATCH;
        firstCount = Math.max(FIRST_BATCH, Math.min(lineCount, need));
    }
    appendRows(0, Math.min(lineCount, firstCount));
    if (!canHighlight) ctrl.highlighted.fill(true); // plaintext: rows are final
    else ctrl.ensureHighlighted(neededLine());
    if (ctrl.rowsBuilt < lineCount || (canHighlight && hlNext < idleTarget())) {
        ctrl.rafId = (window.requestAnimationFrame || window.setTimeout)(pump) as unknown as number;
    }

    codeCtrl = ctrl;
    return ctrl;
}

/** The CODE/TEXT body: a scrollable, selectable line DOM. Each row carries its
 *  line number as a non-selectable CSS ::before "gutter" (so copy yields code
 *  only) and a word-wrap toggle switches its white-space. The DOM is built
 *  imperatively (50k React elements would be pathological) and filled
 *  progressively by the controller — React just mounts the empty scroll column,
 *  keyed on content.seq so a new file remounts fresh. */
function CodeBody() {
    const { useRef, useEffect } = React;
    const bodyRef = useRef(null as HTMLElement | null);
    useEffect(() => {
        const b = bodyRef.current;
        if (!b) return;
        const ctrl = buildCodeController(b);
        // restore find if it was open for this file (e.g. cache return), else
        // restore the saved scroll once the rows exist.
        if (codeView.findOpen && codeView.findQuery) ctrl.rebuildFind(codeView.findQuery);
        else consumePendingScroll();
        return () => {
            ctrl.teardown();
            if (codeCtrl === ctrl) codeCtrl = null;
        };
    }, [content.seq]);
    return React.createElement(
        "div",
        {
            key: content.seq,
            className: "dockview-code-scroll" + (codeView.wrap ? " dockview-code-wrap" : ""),
            // focusable so a click into the code body gives the panel keyboard
            // focus — Ctrl+F / find keys are gated on that focus (never on hover).
            tabIndex: 0
        },
        React.createElement("div", {
            ref: bodyRef,
            className: `dockview-code-pre dockview-code hljs language-${content.codeLang}`
        })
    );
}

/** The CODE find bar = the generic FindBar wired to the code view-state. */
function CodeFindBar() {
    return React.createElement(FindBar, {
        model: {
            query: codeView.findQuery,
            matches: codeView.findMatches,
            active: codeView.findActive,
            caseSensitive: codeView.findCase,
            placeholder: STRINGS.find.placeholderCode,
            setQuery: (q: string) => { codeView.findQuery = q; codeCtrl?.rebuildFind(q); },
            next: () => {
                if (!codeView.findMatches) return;
                codeCtrl?.focusMatch(codeView.findActive % codeView.findMatches);
            },
            prev: () => {
                if (!codeView.findMatches) return;
                codeCtrl?.focusMatch((codeView.findActive - 2 + codeView.findMatches) % codeView.findMatches);
            },
            toggleCase: () => { codeView.findCase = !codeView.findCase; codeCtrl?.rebuildFind(codeView.findQuery); forceRender?.(); },
            close: () => toggleCodeFind()
        }
    });
}

/** Toggle the code find bar. Closing clears the query + highlights. */
function toggleCodeFind() {
    codeView.findOpen = !codeView.findOpen;
    if (!codeView.findOpen) {
        codeView.findQuery = "";
        codeView.findMatches = 0;
        codeView.findActive = 0;
        if (codeCtrl) { codeCtrl.matches = []; codeCtrl.rebuildFind(""); }
    }
    forceRender?.();
}

/** Turn a raw loader error (e.g. "404 ", "TypeError: Failed to fetch", "No
 *  source") into a calm, human title + subtitle. Copy lives in STRINGS.error —
 *  error voice leads with information, never wit. */
function humanizeError(raw: string): { title: string; sub: string } {
    const E = STRINGS.error;
    const status = /^(\d{3})\b/.exec(raw);
    if (status) {
        const code = status[1];
        if (code === "404" || code === "403" || code === "410") return E.gone;
        if (code === "401") return E.forbidden;
        if (code.startsWith("5")) return E.server;
        return { title: E.http.title, sub: E.http.sub(code) };
    }
    // fetch() rejects (offline / DNS / CORS) surface as a TypeError.
    if (/failed to fetch|networkerror|load failed/i.test(raw)) return E.offline;
    if (/^no\b.*source/i.test(raw)) return E.noSource;
    return { title: E.generic.title, sub: E.generic.sub(raw) };
}

/** Error fallback: a centered card mirroring the unsupported-format layout, with
 *  Retry / Open-in-new-window / Download actions. Replaces the old one-line
 *  "Failed to load: <raw>" dead end. Retry re-fetches the same url bypassing the
 *  cache; the other two reuse the existing ⋯-menu handlers. */
function renderErrorBody(raw: string) {
    const { title, sub } = humanizeError(raw);
    const url = content.url;
    const name = content.name || "file";
    const actions: any[] = [];
    // Retry only makes sense when there's a url to re-fetch (inline-html
    // artifacts have none, but they don't take the fetch path anyway).
    if (url) {
        actions.push(React.createElement(
            "button",
            {
                key: "retry",
                type: "button",
                className: "dockview-unsupported-btn dockview-unsupported-btn-primary",
                onClick: () => retryActiveLoad()
            },
            STRINGS.actions.retry
        ));
        actions.push(React.createElement(
            "button",
            {
                key: "open",
                type: "button",
                className: "dockview-unsupported-btn",
                onClick: () => { window.open(absUrl(url), "_blank", "noopener,noreferrer"); }
            },
            STRINGS.actions.openInNewWindow
        ));
        actions.push(React.createElement(
            "button",
            {
                key: "dl",
                type: "button",
                className: "dockview-unsupported-btn",
                onClick: () => downloadUrl(url, name)
            },
            STRINGS.actions.download
        ));
    }
    return React.createElement(
        "div",
        { className: "dockview-unsupported dockview-error-card", key: content.seq },
        React.createElement(
            "svg",
            { className: "dockview-unsupported-icon dockview-error-icon", width: 48, height: 48, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", {
                fill: "currentColor",
                d: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 5h2v7h-2V7Zm0 9h2v2h-2v-2Z"
            })
        ),
        React.createElement("div", { className: "dockview-unsupported-title" }, title),
        React.createElement("div", { className: "dockview-unsupported-sub" }, sub),
        actions.length
            ? React.createElement("div", { className: "dockview-unsupported-actions" }, ...actions)
            : null
    );
}

/** Unsupported-format fallback: a clean centered card for a binary file we can't
 *  preview, with Download + Open-in-new-window actions (no raw-byte iframe dump).
 *  Reached for an "unknown"-extension file that sniffed as binary. */
function renderUnsupportedBody() {
    const url = content.url;
    const name = content.name || "file";
    const ext = extOf(name) || extOf(url);
    return React.createElement(
        "div",
        { className: "dockview-unsupported", key: content.seq },
        React.createElement(
            "svg",
            { className: "dockview-unsupported-icon", width: 48, height: 48, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", {
                fill: "currentColor",
                d: "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-7-7Zm0 2.5L17.5 9H14a1 1 0 0 1-1-1V4.5ZM8 13h8v1.5H8V13Zm0 3.5h8V18H8v-1.5Z"
            })
        ),
        React.createElement("div", { className: "dockview-unsupported-title" }, STRINGS.unsupported.title),
        React.createElement(
            "div",
            { className: "dockview-unsupported-sub" },
            STRINGS.unsupported.sub(ext)
        ),
        React.createElement(
            "div",
            { className: "dockview-unsupported-actions" },
            React.createElement(
                "button",
                {
                    type: "button",
                    className: "dockview-unsupported-btn dockview-unsupported-btn-primary",
                    onClick: () => downloadUrl(url, name)
                },
                STRINGS.actions.download
            ),
            React.createElement(
                "button",
                {
                    type: "button",
                    className: "dockview-unsupported-btn",
                    onClick: () => { if (url) window.open(absUrl(url), "_blank", "noopener,noreferrer"); }
                },
                STRINGS.actions.openInNewWindow
            )
        )
    );
}

/** Loading state — the mini version of the shared state card (spinner glyph +
 *  one title line, no actions). Visibility is DELAYED ~150ms so a fast cache
 *  hit or quick fetch never flashes a spinner; only a genuinely slow load shows
 *  it. The card keeps the same centred rhythm as empty / error / unsupported. */
function LoadingBody() {
    const { useState, useEffect } = React;
    const [show, setShow] = useState(false);
    useEffect(() => {
        const t = setTimeout(() => setShow(true), 150);
        return () => clearTimeout(t);
    }, []);
    if (!show) {
        // Hold an empty body for the first ~150ms (no flicker on fast loads).
        return React.createElement("div", { className: "dockview-status" });
    }
    return React.createElement(
        "div",
        { className: "dockview-loading" },
        React.createElement("div", {
            className: "dockview-loading-spinner",
            "aria-hidden": true
        }),
        React.createElement(
            "div",
            { className: "dockview-loading-title", role: "status", "aria-live": "polite" },
            STRINGS.loading.title
        )
    );
}

/** Body dispatcher: shared loading / error / placeholder, then route. */
function renderBody() {
    if (content.name == null) {
        // Native empty-state pattern: a centred muted glyph + one restrained line
        // of guidance (no illustration, no long copy). Reuses the unsupported-card
        // layout for the same centred icon/title rhythm.
        return React.createElement(
            "div",
            { className: "dockview-empty" },
            React.createElement(
                "svg",
                { className: "dockview-empty-icon", width: 48, height: 48, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                React.createElement("path", {
                    fill: "currentColor",
                    d: "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-7-7Zm0 2.5L17.5 9H14a1 1 0 0 1-1-1V4.5ZM8 13h8v1.5H8V13Zm0 3.5h8V18H8v-1.5Z"
                })
            ),
            React.createElement("div", { className: "dockview-empty-text" }, STRINGS.empty.text)
        );
    }
    if (content.error != null) {
        return renderErrorBody(content.error);
    }
    if (content.type === "pdf") {
        if (content.loading || content.pdf.doc == null) {
            return React.createElement(LoadingBody, null);
        }
        return React.createElement(PdfBody, null);
    }
    if (content.type === "image") {
        return React.createElement(ImageBody, null);
    }
    if (content.type === "code") {
        if (content.loading || content.code == null) {
            return React.createElement(LoadingBody, null);
        }
        return React.createElement(CodeBody, null);
    }
    if (content.type === "unknown") {
        // Still sniffing (a text file gets retyped to "code" on resolve, so the
        // only "unknown" left after load is a sniffed-binary file).
        if (content.loading) {
            return React.createElement(LoadingBody, null);
        }
        return renderUnsupportedBody();
    }
    // markdown shares the html (frameHtml iframe) path; fall through.
    if (content.loading || content.frameHtml == null) {
        return React.createElement(LoadingBody, null);
    }
    return renderHtmlBody();
}

// ---------------------------------------------------------------------------
// Header control groups — the per-viewer CORE controls now live INLINE in the
// single header row (right of the filename, left of ⋯/popout/close), so every
// viewer is one bar tall like a native thread header. The old second
// `dockview-toolbar` strip is gone; secondary controls (PDF fit-width) moved to
// the ⋯ menu. What stays in the header per the spec's priority table:
//   PDF   = page indicator + prev/next, zoom group, find toggle
//   image = zoom group + reset
//   code  = language label, wrap toggle, copy
// All buttons share `toolBtn`; PDF + image share one `zoomGroup`. Active toggles
// use ONE low-chroma visual language (see .dockview-tool-btn-active in CSS) — no
// competing blurple. Controls collapse priority-low first at narrow width (CSS).
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
            "aria-pressed": active || undefined,
            onClick
        },
        React.createElement(
            "svg",
            { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: path })
        )
    );
}

const ZOOM_OUT_PATH = "M19 11a1 1 0 0 1 0 2H5a1 1 0 1 1 0-2h14Z";
const ZOOM_IN_PATH = "M13 5a1 1 0 1 0-2 0v6H5a1 1 0 1 0 0 2h6v6a1 1 0 1 0 2 0v-6h6a1 1 0 1 0 0-2h-6V5Z";

/** The shared zoom group: [− %readout +]. Identical layout / icons / spacing for
 *  PDF + image (IMG-1 / spec §2.2 "zoom group unified"). `keyPrefix` keys the two
 *  buttons; `pct` is the integer percent shown between them. */
function zoomGroup(keyPrefix: string, pct: number, onOut: () => void, onIn: () => void) {
    return React.createElement(
        "div",
        { className: "dockview-tool-group dockview-zoom-group" },
        toolBtn(keyPrefix + "-zoom-out", STRINGS.zoom.out, ZOOM_OUT_PATH, onOut),
        React.createElement("span", { className: "dockview-tool-pct", title: STRINGS.zoom.level }, pct + "%"),
        toolBtn(keyPrefix + "-zoom-in", STRINGS.zoom.in, ZOOM_IN_PATH, onIn)
    );
}

/** PDF header controls: page indicator + prev/next, zoom group, find toggle.
 *  (fit-width moved to the ⋯ menu.) Its own component so the page-jump input has
 *  local state without re-rendering the whole header on each keystroke. */
function PdfHeaderControls() {
    const { useState } = React;
    const [pageInput, setPageInput] = useState("");
    if (content.loading || content.error || content.pdf.doc == null) return null;
    const pct = Math.round(pdfView.zoom * 100);
    const commitPage = () => {
        const n = parseInt(pageInput, 10);
        if (!isNaN(n)) pdfControls?.goToPage(n);
        setPageInput("");
    };
    return React.createElement(
        React.Fragment,
        null,
        // page navigation + indicator + jump input. The prev/next ARROWS are the
        // lowest-priority items (scroll + ←/→ keys cover them) so they collapse
        // first at narrow width; the readout/jump input is kept (it's the only way
        // to SEE/type the page number) — see the container queries in CSS.
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            React.createElement(
                "span",
                { className: "dockview-collapse-low" },
                toolBtn("pdf-prev", STRINGS.pdf.prevPage,
                    "M15.3 5.3a1 1 0 0 1 0 1.4L10 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0Z",
                    () => pdfControls?.prevPage())
            ),
            React.createElement(
                "span",
                { className: "dockview-tool-pageind", title: STRINGS.pdf.pageIndicator },
                React.createElement("input", {
                    className: "dockview-tool-pageinput",
                    type: "text",
                    inputMode: "numeric",
                    "aria-label": STRINGS.pdf.goToPage,
                    title: STRINGS.pdf.goToPageHint,
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
            React.createElement(
                "span",
                { className: "dockview-collapse-low" },
                toolBtn("pdf-next", STRINGS.pdf.nextPage,
                    "M8.7 5.3a1 1 0 0 0 0 1.4L14 12l-5.3 5.3a1 1 0 0 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z",
                    () => pdfControls?.nextPage())
            )
        ),
        // zoom group (shared w/ image) — a CORE control, last to collapse.
        zoomGroup("pdf", pct, () => pdfControls?.zoomOut(), () => pdfControls?.zoomIn()),
        // find toggle (the only header toggle for PDF; fit-width is in ⋯).
        // Mid priority: collapses before the zoom group but after the arrows.
        React.createElement(
            "div",
            { className: "dockview-tool-group dockview-collapse-mid" },
            toolBtn("pdf-find", STRINGS.pdf.find,
                "M10 4a6 6 0 1 0 3.71 10.71l4.29 4.3a1 1 0 0 0 1.42-1.42l-4.3-4.29A6 6 0 0 0 10 4Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z",
                () => pdfControls?.toggleFind(), pdfView.findOpen)
        )
    );
}

/** Image header controls: the shared zoom group + a reset-to-fit. */
function ImageHeaderControls() {
    if (content.loading || content.error || !content.url) return null;
    const pct = Math.round(imgView.scale * 100);
    return React.createElement(
        React.Fragment,
        null,
        zoomGroup("img", pct, () => imgControls?.zoomOut(), () => imgControls?.zoomIn()),
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            toolBtn("zoom-reset", STRINGS.zoom.reset,
                "M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5 1 1 0 1 0-2 0 7 7 0 1 0 7-7Z",
                () => imgControls?.reset())
        )
    );
}

/** Code header controls: language label, wrap toggle, copy. Own component for
 *  the copy "Copied" flash state. */
function CodeHeaderControls() {
    const { useState } = React;
    const [copied, setCopied] = useState(false);
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
        React.Fragment,
        null,
        // language label = lowest priority (informational); collapses first.
        React.createElement("span", { className: "dockview-tool-lang dockview-collapse-low", title: STRINGS.code.detectedLanguage }, content.codeLang),
        // find toggle (mirrors PDF). Mid priority: collapses before wrap/copy.
        React.createElement(
            "div",
            { className: "dockview-tool-group dockview-collapse-mid" },
            toolBtn("code-find", STRINGS.code.find,
                "M10 4a6 6 0 1 0 3.71 10.71l4.29 4.3a1 1 0 0 0 1.42-1.42l-4.3-4.29A6 6 0 0 0 10 4Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z",
                () => toggleCodeFind(), codeView.findOpen)
        ),
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            toolBtn("wrap", codeView.wrap ? STRINGS.code.disableWrap : STRINGS.code.enableWrap,
                "M4 6a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1Zm0 5a1 1 0 0 1 1-1h12a3 3 0 1 1 0 6h-1.59l.3.3a1 1 0 1 1-1.42 1.4l-2-2a1 1 0 0 1 0-1.4l2-2a1 1 0 0 1 1.42 1.4l-.3.3H17a1 1 0 1 0 0-2H5a1 1 0 0 1-1-1Zm0 6a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1Z",
                () => { codeView.wrap = !codeView.wrap; forceRender?.(); },
                codeView.wrap),
            React.createElement(
                "button",
                {
                    key: "copy",
                    type: "button",
                    className: "dockview-tool-btn dockview-tool-copy" + (copied ? " dockview-tool-copied" : ""),
                    "aria-label": STRINGS.code.copyCode,
                    title: STRINGS.code.copyCode,
                    onClick: copy
                },
                React.createElement(
                    "svg",
                    { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                    copied
                        ? React.createElement("path", { fill: "currentColor", d: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" })
                        : React.createElement("path", { fill: "currentColor", d: "M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2Zm2 0h5a2 2 0 0 1 2 2v5h2V5h-9v2ZM6 9v9h9V9H6Z" })
                ),
                React.createElement("span", { className: "dockview-tool-copy-label" }, copied ? STRINGS.code.copied : STRINGS.code.copy)
            )
        )
    );
}

/** The header control cluster for the current content type (rendered inside the
 *  header toolbar, left of ⋯/popout/close). Empty for markdown/artifact/unknown. */
function HeaderControls() {
    if (content.type === "pdf") return React.createElement(PdfHeaderControls, null);
    if (content.type === "image") return React.createElement(ImageHeaderControls, null);
    if (content.type === "code") return React.createElement(CodeHeaderControls, null);
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

// A leading icon for a native Menu.MenuItem. Discord's MenuItem renders the
// `icon` prop in its left slot — supplying one matches the density of every
// native context menu (each row carries a 16-18px glyph), instead of an
// icon-less text list. Returns a component (MenuItem calls it).
const menuIcon = (d: string) => () =>
    React.createElement(
        "svg",
        { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true, className: "dockview-menu-icon" },
        React.createElement("path", { fill: "currentColor", d })
    );
const MENU_ICON = {
    popout: menuIcon("M10 5a1 1 0 0 0 0 2h5.59l-8.3 8.3a1 1 0 1 0 1.42 1.4l8.29-8.29V14a1 1 0 1 0 2 0V6a1 1 0 0 0-1-1h-8Z M5 8a3 3 0 0 1 3-3h2a1 1 0 1 1 0 2H8a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2a1 1 0 1 1 2 0v2a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8Z"),
    download: menuIcon("M12 3a1 1 0 0 1 1 1v9.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42l2.3 2.3V4a1 1 0 0 1 1-1ZM5 18a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z"),
    copyImage: menuIcon("M4 5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5Zm3-1a1 1 0 0 0-1 1v9.59l2.3-2.3a1 1 0 0 1 1.4 0l2.3 2.3 3.3-3.3a1 1 0 0 1 1.4 0L18 14.6V5a1 1 0 0 0-1-1H7Zm2.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"),
    copyLink: menuIcon("M9.88 13.41a1 1 0 0 1 0-1.41l2.12-2.12a1 1 0 0 1 1.42 1.41L11.3 13.4a1 1 0 0 1-1.42 0Zm-2.3 4.6a3 3 0 0 1 0-4.24l2.12-2.12a1 1 0 0 1 1.42 1.41l-2.12 2.12a1 1 0 0 0 1.41 1.42l2.12-2.13a1 1 0 0 1 1.42 1.42l-2.13 2.12a3 3 0 0 1-4.24 0Zm9.9-9.9a3 3 0 0 1 0 4.25l-2.13 2.12a1 1 0 0 1-1.41-1.41l2.12-2.13a1 1 0 0 0-1.41-1.41l-2.12 2.12a1 1 0 1 1-1.42-1.42l2.13-2.12a3 3 0 0 1 4.24 0Z"),
    fitWidth: menuIcon("M4 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1Zm16 0a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1ZM8.7 8.3a1 1 0 0 0-1.4 1.4l.29.3H7a1 1 0 0 0 0 2h.59l-.3.3a1 1 0 1 0 1.42 1.4l2-2a1 1 0 0 0 0-1.4l-2-2Zm6.6 0a1 1 0 0 1 1.4 1.4l-.29.3H17a1 1 0 1 1 0 2h-.59l.3.3a1 1 0 0 1-1.42 1.4l-2-2a1 1 0 0 1 0-1.4l2-2Z")
};

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
    const isPdf = type === "pdf";

    const items: any[] = [];

    // PDF-only: "Fit to width" (reset zoom to 100%). A secondary control moved
    // off the header (spec §2.1 PDF "fit-width → ⋯"). Shown only when zoomed away
    // from fit, since at 100% it's a no-op. The header keeps the zoom group +/-.
    if (isPdf && content.pdf.doc != null && Math.round(pdfView.zoom * 100) !== 100) {
        items.push(React.createElement(Menu.MenuItem, {
            id: "dockview-more-fit-width",
            label: STRINGS.menu.fitToWidth,
            icon: MENU_ICON.fitWidth,
            action: () => pdfControls?.fitWidth()
        }));
    }

    // Open in new window: reuse the artifact popout for HTML, else a plain
    // window.open of the file url (PDF/image/code/markdown).
    items.push(React.createElement(Menu.MenuItem, {
        id: "dockview-more-popout",
        label: STRINGS.menu.openInNewWindow,
        icon: MENU_ICON.popout,
        action: () => {
            if (isHtml && content.html != null) popoutArtifact();
            else if (url) window.open(absUrl(url), "_blank", "noopener,noreferrer");
        }
    }));

    if (url) {
        items.push(React.createElement(Menu.MenuItem, {
            id: "dockview-more-download",
            label: STRINGS.menu.download,
            icon: MENU_ICON.download,
            action: () => downloadUrl(url, name)
        }));
    }

    if (isImage && url) {
        items.push(React.createElement(Menu.MenuItem, {
            id: "dockview-more-copy-image",
            label: STRINGS.menu.copyImage,
            icon: MENU_ICON.copyImage,
            action: () => { copyImage(url); }
        }));
    }

    const linkGroup = url
        ? [
            React.createElement(Menu.MenuSeparator, { key: "sep" }),
            React.createElement(Menu.MenuGroup, { key: "link" },
                React.createElement(Menu.MenuItem, {
                    id: "dockview-more-copy-link",
                    label: STRINGS.menu.copyLink,
                    icon: MENU_ICON.copyLink,
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

    // After a cache RESTORE of a non-PDF file (code / image / iframe), re-apply
    // the saved scroll once the body DOM is committed. The PDF body restores its
    // OWN scroll after its lazy page boxes are built (it needs the column height
    // to exist first), so we skip it here.
    useEffect(() => {
        if (content.type !== "pdf") consumePendingScroll();
    });

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

    // Leading file-type glyph (mirrors a real thread header's [thread glyph] +
    // title structure). One muted, single-colour, document-framed icon per
    // content type so the header reads as "a file is docked here" at a glance.
    // Paths are built lazily here (React is ready now) from the plain-data map.
    const leadingIcon = hasContent
        ? React.createElement(
            "svg",
            {
                className: "dockview-header-icon",
                width: 20,
                height: 20,
                viewBox: "0 0 24 24",
                fill: "none",
                "aria-hidden": true
            },
            ...(FILE_TYPE_ICON[content.type] || FILE_TYPE_ICON.unknown).map(
                ([d, extra]: IconPath, i: number) =>
                    React.createElement("path", { key: i, fill: "currentColor", d, ...(extra || {}) })
            )
        )
        : null;

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
            STRINGS.header.openInNewWindow,
            STRINGS.header.openInNewWindow,
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
            STRINGS.header.more,
            STRINGS.header.more,
            "M7 12.001C7 13.105 6.105 14 5 14C3.895 14 3 13.105 3 12.001C3 10.896 3.895 10.001 5 10.001C6.105 10.001 7 10.896 7 12.001ZM14 12.001C14 13.105 13.105 14 12 14C10.895 14 10 13.105 10 12.001C10 10.896 10.895 10.001 12 10.001C13.105 10.001 14 10.896 14 12.001ZM19 14C20.105 14 21 13.105 21 12.001C21 10.896 20.105 10.001 19 10.001C17.895 10.001 17 10.896 17 12.001C17 13.105 17.895 14 19 14Z",
            (e: any) => ContextMenuApi.openContextMenu(e, () => React.createElement(DockMoreMenu)),
            "dockview-more"
        )
        : null;

    const closeBtn = headerBtn(
        "close",
        STRINGS.header.close,
        STRINGS.header.closeHint,
        "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z",
        close,
        "dockview-close"
    );

    return React.createElement(
        "div",
        {
            className: `${CLS.wrapper} dockview-wrapper`
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
                    { className: `${CLS.upper} dockview-header-upper` },
                    React.createElement(
                        "div",
                        { className: `${CLS.headerChildren} dockview-header-children` },
                        leadingIcon,
                        React.createElement(
                            "h2",
                            { className: `${CLS.title} dockview-title`, title },
                            title
                        )
                    ),
                    // Per-viewer CORE controls now live INLINE in this one header
                    // row (the second toolbar strip is gone). They sit between the
                    // filename and the always-visible ⋯/popout/close actions, and
                    // collapse priority-low first at narrow width (CSS).
                    React.createElement(
                        "div",
                        { className: "dockview-header-controls" },
                        React.createElement(HeaderControls, null)
                    ),
                    React.createElement(
                        "div",
                        { className: `${CLS.toolbar} dockview-header-actions` },
                        popoutBtn,
                        moreBtn,
                        closeBtn
                    )
                )
            ),
            (() => {
                // The find bar is a one-row dropdown pinned to the TOP of the
                // body-wrap; when it's open we add a modifier so the scrolling
                // body is inset below it (no content hidden under the bar). PDF and
                // code share the same FindBar component, each wired to its viewer.
                const pdfFind = hasContent && content.type === "pdf" && pdfView.findOpen && content.pdf.doc;
                const codeFind = hasContent && content.type === "code" && codeView.findOpen && content.code != null;
                const findShown = pdfFind || codeFind;
                return React.createElement(
                    "div",
                    { className: "dockview-body-wrap" + (findShown ? " dockview-find-open" : "") },
                    React.createElement(
                        "div",
                        { className: "dockview-body" },
                        renderBody()
                    ),
                    pdfFind ? React.createElement(PdfFindBar, null)
                        : codeFind ? React.createElement(CodeFindBar, null)
                            : null
                );
            })()
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
    // Restore persisted width + open state from DataStore (async; seeds the
    // in-memory mirror, corrects `state`, and applies to the live panel). Until
    // it resolves the panel uses module-init defaults (closed, 420px).
    loadPersistedState();
    // Seed the per-channel memory with whatever channel we boot into, so the
    // first save targets the right channel (no spurious save to "null").
    currentChannelId = getCurrentChannelId();
    // Persistent low-frequency heartbeat. ensureHost() is cheap (early-returns
    // when the host is already in place), so this is safe to run forever.
    heartbeat = setInterval(() => {
        if (ensureHost()) attachObserver();
    }, 800);

    // toggle hotkey: Ctrl+Alt+P (works anywhere, even while typing — it's a
    // modifier combo). Single-key viewer shortcuts (image zoom +/-/0, PDF
    // page-nav/zoom/find) ONLY fire when the panel actually holds keyboard focus
    // and that focus isn't a text field, so we never steal keys from chat.
    onKeyDown = (e: KeyboardEvent) => {
        if (e.ctrlKey && e.altKey && (e.key === "p" || e.key === "P" || e.code === "KeyP")) {
            e.preventDefault();
            toggle();
            return;
        }
        if (!state.open) return;
        const host = document.getElementById(HOST_ID);
        if (!host) return;
        // The dock panel must hold keyboard focus (the user clicked/tabbed into
        // it). Hovering is NOT enough — otherwise a mouse merely resting over the
        // docked panel would let the viewer swallow keys typed into chat. The PDF
        // body and image wrap are tabIndex=0, so a click focuses them.
        const ae = document.activeElement as HTMLElement | null;
        const focused = host.contains(ae);
        if (!focused) return;
        // Belt-and-braces: if focus is on a text field (the panel's own find /
        // page-jump inputs, or anything editable), single-key shortcuts must not
        // fire. The panel inputs also stopPropagation, this is the backstop.
        if (isEditableTarget(ae)) return;

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

        // Code branch: Ctrl+F toggles our find (Discord may eat the global one);
        // when find is already open Ctrl+F jumps to the next match, matching the
        // PDF UX. The find input itself handles Enter/Shift+Enter/Esc once focused.
        if (content.type === "code" && content.code != null) {
            if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
                e.preventDefault();
                if (!codeView.findOpen) toggleCodeFind();
                else if (codeView.findMatches) codeCtrl?.focusMatch(codeView.findActive % codeView.findMatches);
                return;
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
    // 6. release any pdf document + the whole content cache (destroys all the
    //    cached pdf docs + revokes blob urls — no leak across plugin restarts).
    resetPdf();
    clearContentCache();
    // 7. drop per-channel memory (in-memory only).
    channelStates.clear();
    currentChannelId = null;
    activeDescriptor = null;
    // 8. reset the persistence latch so a re-start re-loads from DataStore. The
    //    mirror itself is kept (already-correct values) but writes are paused
    //    until the next loadPersistedState resolves.
    persistLoaded = false;
}

// Debug surface: a single neutral window handle so manual console testing
// still works. Removed again on stop().
export function exposeDebug() {
    (window as any).__dockView = {
        toggle, ensureHost, applyOpenState, state, DockPanel, CLS, findPageInner,
        onChannelSelect, getCurrentChannelId, channelStates,
        load, retry: retryActiveLoad, clear: clearArtifact, popout: popoutArtifact, content, detectType,
        contentCache, get loadSeq() { return loadSeq; }, get activeCacheKey() { return activeCacheKey; },
        pdfView, get pdfControls() { return pdfControls; }
    };
}
export function unexposeDebug() {
    try { delete (window as any).__dockView; } catch { /* ignore */ }
}
