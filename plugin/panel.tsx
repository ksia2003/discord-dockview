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
import { getCurrentChannel } from "@utils/discord";
import { findByProps, findCssClasses } from "@webpack";
import { Button, ChannelStore, ContextMenuApi, createRoot, DraftType, Menu, MessageActions, MessageStore, React, SelectedChannelStore, UploadHandler } from "@webpack/common";
import type { Root } from "react-dom/client";

// MCP bridge connect info (enable/token/port) — persisted by Vencord, read at
// connect time in startMcpClient(). See settings.ts for why NOT localStorage.
import { settings } from "./settings";

// pdf.js — bundled into the renderer by esbuild. We ALSO import the worker
// module and register it on globalThis.pdfjsWorker so pdf.js runs the worker
// message handler ON THE MAIN THREAD (its "fake worker" path) using THIS
// already-bundled code. No `new Worker(url)`, no blob: URL, no dynamic
// import() — all three of which Discord's CSP would block.
import * as pdfjsLib from "pdfjs-dist";
import { WorkerMessageHandler as PdfWorkerMessageHandler } from "pdfjs-dist/build/pdf.worker.mjs";

// marked — markdown -> HTML, bundled into the renderer IIFE.
import { marked } from "marked";

// mammoth — .docx (OOXML Word) -> HTML, bundled into the renderer IIFE. We fetch
// the attachment as an ArrayBuffer (binary), convert to an HTML string, then wrap
// it in the SAME dark sandboxed-iframe document the markdown viewer uses, so a
// .docx renders dark-themed + sandboxed with zero new render plumbing.
import * as mammoth from "mammoth";

// SheetJS (xlsx) — .xlsx/.xls (OOXML / BIFF spreadsheet) -> rows, bundled into
// the renderer IIFE. We read the workbook from an ArrayBuffer, serialise the first
// sheet to CSV text, and feed that straight into the EXISTING csv grid path (the
// load RETYPES the file to "csv", mirroring how loadUnknown retypes text to code).
import * as XLSX from "xlsx";

// mermaid — diagram source (.mmd / .mermaid) -> SVG, bundled into the renderer
// IIFE. mermaid is heavy and lays diagrams out against the live DOM, so we render
// on the MAIN side (mermaid.render) and inject only the finished SVG into a dark
// sandboxed iframe — no mermaid runtime ever runs inside the sandbox.
import mermaid from "mermaid";

// KaTeX — TeX -> static HTML/CSS math, bundled into the renderer IIFE. The
// markdown body is a sandboxed srcdoc iframe (no runtime JS, no external assets),
// so we PRE-render each math span to self-contained HTML on the main side here
// and inline KaTeX's CSS (+ its woff2 fonts as base64) into the iframe head. The
// existing chat-side renderer (latex.ts) loads KaTeX from a CDN into the main
// Discord document — that does not reach this sandbox, so we bundle it instead.
import katex from "katex";
import { KATEX_CSS } from "./katex-css";

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
const EXCLUSIVE_HIDDEN_ATTR = "data-dockview-exclusive-hidden";
const LS_WIDTH = "dockview.dock.width";
const LS_OPEN = "dockview.dock.open";

const MIN_WIDTH = 360;
const DEFAULT_WIDTH = 420;
const MAX_WIDTH_FRAC = 0.6; // of window width

// ---------------------------------------------------------------------------
// TWO-MODE width behaviour (mirrors Discord's native thread panel). The dock has
// a DOCKED (push) mode and a FLOATING (overlay) mode, auto-switched by how much
// width the dock+chat share — so a wide persisted dock can never crush the chat
// on a narrow window. The decision + clamp live in ONE place: applyDockLayout().
//
//   - CHAT_MIN_WIDTH: the chat's protected minimum. The docked dock is never
//     applied wider than (content − this), so the message area keeps its min;
//     when even DOCK_MIN_WIDTH can't fit beside it, the dock goes floating.
//   - DOCK_MIN_WIDTH: the dock's own minimum while docked (the smallest push).
//   - FLOAT_CHAT_SLIVER: while floating, leave at least this much chat visible/
//     clickable behind the overlay (native floats a panel that doesn't quite
//     cover the chat). The float width is capped to (content − this).
// All tune-able: change here, nothing else.
const CHAT_MIN_WIDTH = 420;
const DOCK_MIN_WIDTH = 280;
const FLOAT_CHAT_SLIVER = 48;

// The dock width is a DOCK-LEVEL (global) property, NOT per-window: every tab is
// the same dock chrome, so they all share ONE width. It lives in a single module
// singleton (persisted to LS_WIDTH), and every window's `state.width` is a getter/
// setter proxy onto it (see makeWindow) — so switching tabs can NEVER change the
// width (the old per-window seed-from-LS drifted: a window created before a resize
// kept a stale width and made the dock jump on switch). All reads/writes funnel
// through this one value. It is SEEDED from LS in makeWindow's first call (which
// runs after persistCache/lsGet exist — reading LS here at module-init would hit
// persistCache's TDZ and throw, killing the whole plugin) and corrected by
// loadPersistedState() from DataStore at startPanel().
let dockWidth = DEFAULT_WIDTH;
function getDockWidth(): number { return dockWidth; }
function setDockWidth(w: number) { dockWidth = w; }
// `seeded` makes the LS read happen exactly once (the first makeWindow call), so a
// later makeWindow (a new tab) doesn't re-clobber a width the user has since set.
let dockWidthSeeded = false;
function seedDockWidthFromLS() {
    if (dockWidthSeeded) return;
    dockWidthSeeded = true;
    dockWidth = clampWidthRaw(parseInt(lsGet(LS_WIDTH) || "", 10) || DEFAULT_WIDTH);
}
// clampWidth() (below) reads window.innerWidth and is the public clamp; this raw
// helper is identical (it is a function declaration, so it is hoisted).
function clampWidthRaw(w: number): number {
    const max = Math.max(MIN_WIDTH, Math.floor((window.innerWidth || 1280) * MAX_WIDTH_FRAC));
    return Math.min(max, Math.max(MIN_WIDTH, w));
}

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
    // Word document: document frame + a "W" mark.
    docx: [
        [DOC_FRAME],
        ["M6.4 13h1.4l.9 3.8.95-3.8h1.3l.95 3.8.9-3.8H15l-1.55 6h-1.4l-.85-3.4-.85 3.4H8.95L6.4 13Z"]
    ],
    // Spreadsheet: document frame + a small grid mark.
    xlsx: [
        [DOC_FRAME],
        ["M6.5 12.5h11v6.5h-11v-6.5Zm1.25 1.25v1.25H11v-1.25H7.75Zm4.5 0v1.25h3.75v-1.25h-3.75Zm-4.5 2.5v1.25H11v-1.25H7.75Zm4.5 0v1.25h3.75v-1.25h-3.75Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Mermaid diagram: two linked nodes (a tiny flowchart glyph).
    mermaid: [
        ["M5 4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1v3h3.05a2.5 2.5 0 1 1 0 1.5H10v-1.5H9V8H7a2 2 0 0 1-2-2V4Zm12 13a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
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
        if (w !== activeWindow.state.width) {
            activeWindow.state.width = w;
            if (activeWindow.state.open) applyHostWidth();
        }
    }
    if (openStr === "1" && !activeWindow.state.open) {
        closeNativeChannelSidebar();
        activeWindow.state.open = true;
        ensureHost();
        applyOpenState();
        syncNativeMemberList(true); // restored open across a restart → collapse like a thread
        syncNativeProfileSidebar(true);
    }
    forceRender?.();
}

// --- panel content state ----------------------------------------------------
// "unknown" = a file whose extension we don't recognise. We DON'T guess "html"
// for it anymore (that dumped raw bytes — often binary garbage — into an iframe).
// Instead loadUnknown() fetches it and sniffs text-vs-binary: a text file is
// retyped to "code" (plaintext viewer), a binary one stays "unknown" and renders
// the unsupported-format fallback screen (download / open-in-new-window).
// "csv" = a comma/tab-separated file: rendered as a spreadsheet-style GRID by
// default, with a header toggle back to the RAW text (which reuses the code
// viewer over the same content.code). The grid is parsed lazily from content.code
// on mount, so the cache stays text-only (no parsed-rows payload to keep alive).
type ContentType = "html" | "pdf" | "code" | "markdown" | "image" | "unknown" | "csv" | "mcpapp" | "docx" | "xlsx" | "mermaid";

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

// --- the dock window (single, for now) --------------------------------------
// ONE DockWindow holds the entire per-window state that used to live in the
// scattered module singletons (`state`/`content`/`pdfView`/`imgView`/`codeView`/
// `csvView`/`editView`/`gallery` + the active descriptor/cache key). It is the
// foundation for multi-window: today there is exactly one (`activeWindow`); a
// later step turns this into a window collection with a tab strip. Everything
// genuinely cross-window stays OUTSIDE it (the LRU `contentCache`, `channelStates`,
// the host/root refs, sidebar/Flux state, `currentChannelId`). Behaviour is
// identical to the singleton form — this is a pure restructure.
interface ImgViewState { scale: number; tx: number; ty: number; natW: number; natH: number; fullscreen: boolean; }
interface GalleryState {
    channelId: string | null;
    items: GalleryEntry[];
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    loading: boolean; // a fetchMessages() is in flight (dim the stepping button)
}
interface CodeViewState {
    findOpen: boolean;
    findQuery: string;
    findMatches: number;
    findActive: number; // 1-based index of the active match (0 = none)
    findCase: boolean;
}
interface CsvViewState {
    mode: "grid" | "raw";
    delimiter: string; // "," for csv, "\t" for tsv (decided at load)
}
interface EditViewState {
    mode: "view" | "edit";
    editBuffer: string | null;
}
interface PdfViewState {
    page: number;
    total: number;
    fit: PdfFit;
    zoom: number;
    dragMode: PdfDragMode; // default = current text-select behaviour
    // search state
    findOpen: boolean;
    findQuery: string;
    findMatches: number;
    findActive: number; // 1-based index of the active match (0 = none)
    findCase: boolean; // case-sensitive toggle (false = case-insensitive, the default)
}
interface McpAppViewState { appId: string | null; }
interface DockWindow {
    // stable identity within the windows[] collection (tab key, switch target).
    id: string;
    // PINNED windows are global: they persist across channel switches and show as
    // a tab in EVERY channel. The single un-pinned window is TRANSIENT — bound to
    // the channel it was opened in (`ownerChannelId`), saved/restored per channel
    // like the old single-window `channelStates`, and replaced when a new file is
    // opened. There is at most ONE transient window per channel.
    pinned: boolean;
    // the channel a TRANSIENT window belongs to (null for pinned/global windows).
    ownerChannelId: string | null;
    // shared open/width state (kept outside React). `open` is per-window. `width`
    // is a GETTER/SETTER PROXY onto the single global `dockWidth` (see makeWindow):
    // the dock is one chrome, so every window reports/writes the same width and
    // switching tabs never changes it.
    state: { open: boolean; width: number };
    // panel content state
    content: PanelContent;
    // per-viewer view-state, shared with the toolbars
    imgView: ImgViewState;
    gallery: GalleryState;
    codeView: CodeViewState;
    csvView: CsvViewState;
    editView: EditViewState;
    pdfView: PdfViewState;
    mcpView: McpAppViewState;
    // the descriptor currently shown in the panel (so we can save it on switch)
    activeDescriptor: ChannelDescriptor | null;
    // the content-cache key this window is currently mirroring (null = none)
    activeCacheKey: string | null;
    // per-window new-file session flag (a brand-new empty editable surface that has
    // no original baseline → no merge diff, default attach name message.md).
    isNewFile: boolean;
    // per-window attach target resolved when a new-file surface was opened.
    newFileChannel: any;
}

let windowSeq = 0;
function nextWindowId(): string {
    return `w${++windowSeq}`;
}

/** Build a fresh, empty DockWindow. `pinned`/`ownerChannelId` set by the caller.
 *  Every window shares the same persisted open/width (the dock chrome is one). */
function makeWindow(opts: { pinned: boolean; ownerChannelId: string | null }): DockWindow {
    // Seed the global dock width from LS on the first window (safe here: persistCache
    // exists by the time any makeWindow runs, unlike module-init).
    seedDockWidthFromLS();
    return {
        id: nextWindowId(),
        pinned: opts.pinned,
        ownerChannelId: opts.ownerChannelId,
        // `open` is genuinely per-window (a pinned tab stays open while a transient
        // may not); `width` is a PROXY onto the single global dockWidth so every
        // window agrees and switching tabs never changes the dock width.
        state: {
            open: lsGet(LS_OPEN) === "1",
            get width() { return getDockWidth(); },
            set width(w: number) { setDockWidth(w); }
        },
        content: {
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
        },
        // scale === 1 means "fit" (contain); tx/ty pan when zoomed past fit. `fullscreen`
        // flips into a self-rendered lightbox overlay, sharing the SAME zoom/pan.
        imgView: { scale: 1, tx: 0, ty: 0, natW: 0, natH: 0, fullscreen: false },
        // ordered channel-image list for prev/next nav (oldest→newest), keyed by channel.
        gallery: {
            channelId: null,
            items: [],
            hasMoreBefore: false,
            hasMoreAfter: false,
            loading: false
        },
        codeView: {
            findOpen: false,
            findQuery: "",
            findMatches: 0,
            findActive: 0,
            findCase: false
        },
        csvView: {
            mode: "grid",
            delimiter: ","
        },
        editView: {
            mode: "view",
            editBuffer: null
        },
        pdfView: {
            page: 1,
            total: 0,
            fit: "width",
            zoom: 1,
            dragMode: "text",
            findOpen: false,
            findQuery: "",
            findMatches: 0,
            findActive: 0,
            findCase: false
        },
        mcpView: { appId: null },
        activeDescriptor: null,
        activeCacheKey: null,
        isNewFile: false,
        newFileChannel: null
    };
}

// --- the window collection (pin-driven tabs) --------------------------------
// `windows[]` is a module singleton (survives @me / channel switches), holding:
//   - PINNED windows: global, persist everywhere, each shows as a tab.
//   - at most ONE TRANSIENT window: channel-bound, replaced on each file open.
// `activeWindow` is a live binding to the currently-shown window (reassigned by
// setActiveWindow), so the hundreds of `activeWindow.*` call sites work unchanged
// — they always read/write whichever window the tab strip has focused. The
// initial single transient window reproduces today's behaviour exactly (no tab
// strip is shown until a second window exists).
const windows: DockWindow[] = [makeWindow({ pinned: false, ownerChannelId: null })];
let activeWindowId: string = windows[0].id;
let activeWindow: DockWindow = windows[0];

/** The current transient (un-pinned) window, or null if there is none. There is
 *  at most one (it's channel-bound; a pin frees the slot). */
function transientWindow(): DockWindow | null {
    return windows.find(w => !w.pinned) || null;
}

/** Point `activeWindow`/`activeWindowId` at a window (by id or object). Pure
 *  binding swap — does NOT render or touch the DOM; callers re-render. */
function setActiveWindow(w: DockWindow | string) {
    const win = typeof w === "string" ? windows.find(x => x.id === w) : w;
    if (!win) return;
    activeWindow = win;
    activeWindowId = win.id;
}

// --- tab actions (pin-driven multi-window) ----------------------------------
// The tab strip is shown only when windows.length >= 2; until then the lone
// transient behaves exactly like the historical single window.

/** If the active window's content is stuck loading (its in-flight loader was
 *  superseded by activity in another window — the loadSeq guard makes a loader
 *  write ONLY the cache entry once superseded) but its cache entry has since
 *  resolved, re-point content from the cache. This makes a window's body show its
 *  file the moment we show it again, even if its original loader never wrote back.
 *  Returns true if it reconciled. */
function reconcileActiveFromCache(): boolean {
    const key = activeWindow.activeCacheKey;
    if (key == null) return false;
    if (!activeWindow.content.loading && activeWindow.content.error == null) return false;
    const e = contentCache.get(key);
    if (!e || e.loading || e.error != null) return false;
    mountFromCache(e);
    return true;
}

/** Switch the visible tab to `id`: snapshot the leaving window's live view-state,
 *  bind the active window, restore the new window's saved scroll, re-render. */
function switchToWindow(id: string) {
    if (id === activeWindowId) return;
    const target = windows.find(w => w.id === id);
    if (!target) return;
    snapshotActiveView();
    activeWindow.imgView.fullscreen = false; // never strand the lightbox over a hidden tab
    setActiveWindow(target);
    // the target keeps the dock open (a tab you can see is an open dock).
    target.state.open = true;
    loadSeq += 1; // any in-flight loader from the old window must not write here
    // if this window's loader was superseded but its cache resolved, hydrate now.
    reconcileActiveFromCache();
    activeWindow.content.seq += 1; // force a fresh body identity for the new tab
    applyOpenState();
    forceRender?.();
    // re-apply the target window's saved scroll once its body re-commits.
    pendingScrollTop = activeWindow.activeCacheKey != null
        ? (contentCache.get(activeWindow.activeCacheKey)?.view.scrollTop ?? null)
        : null;
}

/** ⋯-menu 고정하기: pin the ACTIVE window so it becomes a persistent tab that
 *  survives channel switches. If the active window was the (channel-bound)
 *  transient, pinning it frees the transient slot for the next file open. */
function pinActiveWindow(w: DockWindow = activeWindow) {
    if (w.pinned) return;
    w.pinned = true;
    w.ownerChannelId = null; // pinned windows are global, not per-channel
    w.state.open = true;
    forceRender?.();
}

/** ⋯-menu 고정 해제: unpin the active window. It becomes the channel's transient
 *  again (bound to the current channel). If a transient already exists, removing
 *  this window instead (a channel can hold only ONE transient) — but since the
 *  user explicitly unpinned THIS window, we keep it as the transient and clear any
 *  other transient. */
function unpinActiveWindow(w: DockWindow = activeWindow) {
    if (!w.pinned) return;
    // a channel holds at most one transient — drop any existing one first.
    const existing = transientWindow();
    if (existing && existing !== w) {
        const i = windows.indexOf(existing);
        if (i >= 0) windows.splice(i, 1);
    }
    w.pinned = false;
    w.ownerChannelId = getCurrentChannelId();
    forceRender?.();
}

/** Close a tab (the ✕ on a tab, or the lone-window header X delegates here for the
 *  active window). A PINNED tab is removed entirely; a TRANSIENT tab is cleared
 *  (its content detached, the window removed) so its channel reopens empty. After
 *  removal the active window falls back to a sensible neighbour; if no windows
 *  remain the dock fully closes (member-list restore runs). */
function closeTab(id: string) {
    const idx = windows.findIndex(w => w.id === id);
    if (idx < 0) return;
    const win = windows[idx];
    // snapshot the active window's view before any binding change.
    if (win.id === activeWindowId) snapshotActiveView();
    // if it's the transient, also forget its per-channel memory so the channel
    // reopens empty (closing a transient = clearing it).
    if (!win.pinned && win.ownerChannelId) channelStates.delete(win.ownerChannelId);
    windows.splice(idx, 1);

    if (windows.length === 0) {
        // last window closed → the whole dock closes (member-list restore).
        closePanel();
        return;
    }
    if (win.id === activeWindowId) {
        // focus a neighbour (prefer the previous tab, else the first).
        const next = windows[Math.max(0, idx - 1)];
        setActiveWindow(next);
        next.state.open = true;
        loadSeq += 1;
        activeWindow.content.seq += 1;
    }
    applyOpenState();
    forceRender?.();
}

// --- new-file (empty editable surface) state --------------------------------
// A brand-new file opened from the `+` composer menu: an EMPTY editable CM in
// EDIT mode (default markdown), with NO original baseline (so it edits as a plain
// editor — no merge diff). It IS a normal `content` (type markdown, empty source)
// rather than a separate compose codebase, so every viewer affordance (find,
// copy, the edit toggle) works on it unchanged. `isNewFile` flags it so the merge
// diff is skipped and the attach filename defaults to `message.md`. The chosen
// filename comes from the attach input (attachBarName) at attach time.
// `newFileChannel` is the attach target resolved at open time (the menu's
// props.channel, or the current channel).
//
// These live PER-WINDOW (on the DockWindow) so a pinned new-file tab keeps its
// new-file identity across a tab switch / channel switch. The accessors below
// read/write the ACTIVE window's flags so every existing call site is unchanged.
function getIsNewFile(): boolean { return activeWindow.isNewFile; }
function setIsNewFile(v: boolean) { activeWindow.isNewFile = v; }
function getNewFileChannel(): any { return activeWindow.newFileChannel; }
function setNewFileChannel(v: any) { activeWindow.newFileChannel = v; }

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
    // pdf: text-select vs pan drag mode the user left this file on (text default)
    pdfDragMode?: PdfDragMode;
    // image
    imgScale?: number;
    imgTx?: number;
    imgTy?: number;
    // shared scroll (px) of the .dockview-body scroller
    scrollTop?: number;
    // csv: which view the user left the file on (grid by default)
    csvMode?: "grid" | "raw";
    // editable text family (code/markdown/csv-raw/artifact): the mode the user
    // left the file on, and the temporary edit buffer (null = unedited). Both
    // survive a cache return so a re-opened file keeps your edits + your mode.
    editMode?: "view" | "edit";
    editBuffer?: string | null;
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

/** The set of cache keys referenced by ANY live window (pinned tabs + transient).
 *  Every one of these MUST be non-evictable: each window's `content` still points
 *  at its entry's payloads (notably a live pdf.js doc), so evicting one would
 *  destroy a doc a hidden-but-live tab is still rendering. With several windows
 *  the active key alone is not enough — protect them all. */
function liveCacheKeys(): Set<string> {
    const keys = new Set<string>();
    for (const w of windows) {
        if (w.activeCacheKey != null) keys.add(w.activeCacheKey);
    }
    return keys;
}

/** Insert/refresh an entry as most-recently-used and evict past capacity. Any
 *  entry referenced by a LIVE window (pinned or transient) is never evicted — its
 *  pdf doc is in use by that window's content, even when the tab isn't visible. */
function cacheTouch(entry: CacheEntry) {
    // re-insert at the end (Map preserves insertion order = LRU order).
    contentCache.delete(entry.key);
    contentCache.set(entry.key, entry);
    // The cache must hold at least every live window's entry; if more windows are
    // live than CONTENT_CACHE_MAX, the live floor wins (never evict a live entry).
    const live = liveCacheKeys();
    const cap = Math.max(CONTENT_CACHE_MAX, live.size);
    while (contentCache.size > cap) {
        // evict the oldest entry NOT referenced by any live window.
        let victim: string | null = null;
        for (const k of contentCache.keys()) {
            if (!live.has(k)) { victim = k; break; }
        }
        if (victim == null) break; // only live entries remain — nothing evictable
        const e = contentCache.get(victim)!;
        contentCache.delete(victim);
        disposeCacheEntry(e);
    }
}

/** Drop the whole cache (plugin stop), releasing every doc. */
function clearContentCache() {
    for (const e of contentCache.values()) disposeCacheEntry(e);
    contentCache.clear();
    activeWindow.activeCacheKey = null;
}

/** The scrollable body element (px scroll position lives here). */
function bodyScroller(): HTMLElement | null {
    return document.querySelector<HTMLElement>(`#${HOST_ID} .dockview-body`);
}

/** The scroller that actually owns vertical scroll for the CURRENT view. Almost
 *  always .dockview-body — EXCEPT two cases that scroll internally:
 *   - the CSV grid fills the body and owns both axes (so its sticky header
 *     resolves correctly) → its scroll lives on .dockview-csv-scroll;
 *   - the code/CSV-raw view is a CodeMirror editor that owns its own scroller
 *     (.cm-scroller) → that's where the px scroll position lives.
 *  The scroll snapshot/restore reads through here so a file reopens at the same
 *  spot. */
function viewScroller(): HTMLElement | null {
    if (activeWindow.content.type === "csv" && activeWindow.csvView.mode === "grid") {
        return document.querySelector<HTMLElement>(`#${HOST_ID} .dockview-csv-scroll`) || bodyScroller();
    }
    // The CM editor (code / csv-raw / markdown-or-artifact in edit mode) owns its
    // own scroller; everything else (rendered iframe, pdf, image) scrolls the body.
    if (cmBodyShown()) {
        return document.querySelector<HTMLElement>(`#${HOST_ID} .dockview-cm .cm-scroller`) || bodyScroller();
    }
    return bodyScroller();
}

/** Snapshot the CURRENT live view-state into the active cache entry so that
 *  reopening this file (re-click / channel return) lands on the same spot. */
function snapshotActiveView() {
    if (activeWindow.activeCacheKey == null) return;
    const e = contentCache.get(activeWindow.activeCacheKey);
    if (!e) return;
    const sc = viewScroller();
    e.view.scrollTop = sc ? sc.scrollTop : e.view.scrollTop;
    if (e.type === "pdf") {
        e.view.pdfPage = activeWindow.pdfView.page;
        e.view.pdfZoom = activeWindow.pdfView.zoom;
        e.view.pdfFit = activeWindow.pdfView.fit;
        e.view.pdfDragMode = activeWindow.pdfView.dragMode;
    } else if (e.type === "image") {
        e.view.imgScale = activeWindow.imgView.scale;
        e.view.imgTx = activeWindow.imgView.tx;
        e.view.imgTy = activeWindow.imgView.ty;
    } else if (e.type === "csv") {
        e.view.csvMode = activeWindow.csvView.mode;
    }
    // editable text family: remember the edit mode + buffer (the buffer is also
    // written through on every keystroke by setEditBuffer; this catches the mode).
    if (e.type === "code" || e.type === "markdown" || e.type === "html" || e.type === "csv") {
        e.view.editMode = activeWindow.editView.mode;
        e.view.editBuffer = activeWindow.editView.editBuffer;
    }
}

/** Apply a cache entry's saved view-state into the module view objects so the
 *  body renderer opens at the remembered zoom/page/scroll. (Scroll itself is
 *  re-applied after the body mounts — see consumePendingScroll.) */
let pendingScrollTop: number | null = null;
function applyCachedView(e: CacheEntry) {
    if (e.type === "pdf") {
        activeWindow.pdfView.zoom = e.view.pdfZoom ?? 1;
        activeWindow.pdfView.fit = e.view.pdfFit ?? "width";
        activeWindow.pdfView.page = e.view.pdfPage ?? 1;
        activeWindow.pdfView.total = e.pdfPages ?? 0;
        activeWindow.pdfView.dragMode = e.view.pdfDragMode ?? "text";
        activeWindow.pdfView.findOpen = false;
        activeWindow.pdfView.findQuery = "";
        activeWindow.pdfView.findMatches = 0;
        activeWindow.pdfView.findActive = 0;
        activeWindow.pdfView.findCase = false;
    } else if (e.type === "image") {
        activeWindow.imgView.scale = e.view.imgScale ?? 1;
        activeWindow.imgView.tx = e.view.imgTx ?? 0;
        activeWindow.imgView.ty = e.view.imgTy ?? 0;
    } else if (e.type === "code") {
        // find never persists across files — a restored file opens with find closed.
        resetCodeView();
    } else if (e.type === "csv") {
        resetCodeView();
        // restore the grid/raw choice the user left this file on; the delimiter is
        // re-sniffed by the loader (it lives on csvView already at this point).
        activeWindow.csvView.mode = e.view.csvMode ?? "grid";
    }
    // Editable text family: restore the edit mode + temporary buffer the user left
    // this file on so a re-open keeps both. (CSV's view mode rides csvView above;
    // here we only restore its edit BUFFER, since raw editing shares the buffer.)
    if (e.type === "code" || e.type === "markdown" || e.type === "html" || e.type === "csv") {
        activeWindow.editView.editBuffer = e.view.editBuffer ?? null;
        activeWindow.editView.mode = e.type === "csv" ? "view" : (e.view.editMode ?? "view");
    } else {
        resetEditView();
    }
    pendingScrollTop = e.view.scrollTop ?? null;
}

/** After a restore, re-apply the saved scroll once the body has its content. */
function consumePendingScroll() {
    if (pendingScrollTop == null) return;
    const target = pendingScrollTop;
    pendingScrollTop = null;
    const sc = viewScroller();
    if (sc) sc.scrollTop = target;
}

/** Point `content` at a cached entry WITHOUT any fetch. Returns true on hit. The
 *  caller is responsible for the open/render bookkeeping around this. */
function mountFromCache(e: CacheEntry): boolean {
    // Tear down the OUTGOING pdf doc only if it's not itself cached (cached docs
    // stay alive in their entry). resetPdf() would destroy content.pdf.doc; here
    // we just re-point, since the live doc belongs to its own cache entry.
    activeWindow.content.name = e.name;
    activeWindow.content.type = e.type;
    activeWindow.content.url = e.url;
    activeWindow.content.error = e.error ?? null;
    activeWindow.content.loading = e.loading;
    // payloads
    activeWindow.content.html = e.html ?? null;
    activeWindow.content.frameHtml = e.frameHtml ?? null;
    activeWindow.content.code = e.code ?? null;
    activeWindow.content.codeLang = e.codeLang ?? "plaintext";
    activeWindow.content.binary = e.binary ?? false;
    // pdf: re-point the live doc to the cached one (no destroy, no re-fetch).
    activeWindow.content.pdf = {
        doc: e.pdfDoc ?? null,
        pages: e.pdfPages ?? 0,
        renderToken: activeWindow.content.pdf.renderToken + 1
    };
    applyCachedView(e);
    // CSV: the delimiter isn't persisted (cheap to re-derive) — re-sniff it from
    // the restored text so the grid parses identically on a cache return.
    if (e.type === "csv") activeWindow.csvView.delimiter = csvDelimiterFor(e.name, e.url, e.code ?? "");
    // mcpapp (= a TSX `.artifact` rendered via the embedded runtime): restore the
    // frame id so McpAppBody re-binds the iframe on a cache return (the artifact
    // self-renders offline, so this only keeps the frame registry consistent).
    if (e.type === "mcpapp") activeWindow.mcpView.appId = e.name || "artifact";
    activeWindow.activeCacheKey = e.key;
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
// `fullscreen` flips the image into a self-rendered lightbox overlay (IMG-2). It
// lives ON imgView (not React state) so the SAME zoom/pan (scale/tx/ty) carries
// over verbatim when entering/leaving fullscreen — the inline body and the
// overlay drive one shared view-state, so the picture stays exactly where the
// user left it across the transition.
function resetImgView() {
    activeWindow.imgView.scale = 1;
    activeWindow.imgView.tx = 0;
    activeWindow.imgView.ty = 0;
}
interface ImgControls {
    zoomIn: () => void;
    zoomOut: () => void;
    reset: () => void;
    getScale: () => number;
    toggleFullscreen: () => void;
}
let imgControls: ImgControls | null = null;

// --- channel image gallery (prev/next image nav) ----------------------------
// Discord has NO gallery store; images come from MessageStore. We build an
// ORDERED list (oldest→newest, exactly like Discord's native lightbox) of every
// image attachment in the channel currently being viewed, then step prev/next
// through it. The list is rebuilt from MessageStore.getMessages(channelId) on the
// first nav request for a channel (and after a load-more fetch), keyed by channel
// id so a channel switch invalidates it. Each entry's url is normalised through
// galleryFullResUrl so it matches the full-res url the panel loaded the image
// under (embed.ts loads images via the same normalisation). At a list end, if the
// MessageCollection reports more messages before/after, we fetchMessages() to
// extend it; the prev/next button DIMS (never vanishes — grammar rule 9) at a
// true end (no more to fetch) and while a load-more is in flight.
interface GalleryEntry { messageId: string; url: string; name: string; }

/** Last-path-segment filename of a url (gallery fallback when an attachment has
 *  no `filename`). Decoded; query/hash dropped. */
function galleryNameFromUrl(url: string): string {
    let path = url;
    try { path = new URL(url, location.href).pathname; } catch { /* keep raw */ }
    let base = path.split("/").pop() || "image";
    try { base = decodeURIComponent(base); } catch { /* keep raw */ }
    return base || "image";
}

/** Build the ordered image list for `channelId` from MessageStore. Returns the
 *  entries oldest→newest plus whether the collection has more at either end. */
function buildGallery(channelId: string): { items: GalleryEntry[]; hasMoreBefore: boolean; hasMoreAfter: boolean } {
    const items: GalleryEntry[] = [];
    let hasMoreBefore = false;
    let hasMoreAfter = false;
    try {
        const coll = MessageStore.getMessages(channelId);
        if (coll) {
            hasMoreBefore = !!coll.hasMoreBefore;
            hasMoreAfter = !!coll.hasMoreAfter;
            const arr: any[] = typeof coll.toArray === "function" ? coll.toArray() : (Array.isArray(coll) ? coll : []);
            for (const msg of arr) {
                const atts = msg && msg.attachments;
                if (!atts || !atts.length) continue;
                for (const a of atts) {
                    const raw = a && (a.url || a.proxy_url);
                    if (!raw) continue;
                    const isImg = (typeof a.content_type === "string" && a.content_type.startsWith("image/"))
                        || GALLERY_IMG_EXT_RE.test(String(raw));
                    if (!isImg) continue;
                    const url = galleryFullResUrl(String(raw));
                    const name = (a.filename as string) || galleryNameFromUrl(url);
                    items.push({ messageId: String(msg.id), url, name });
                }
            }
        }
    } catch {
        /* MessageStore unavailable / shape changed — empty gallery (nav dims) */
    }
    return { items, hasMoreBefore, hasMoreAfter };
}

/** Refresh `gallery` for the channel the panel is in (idempotent per call). */
function refreshGallery() {
    const channelId = getCurrentChannelId();
    if (!channelId) { activeWindow.gallery.channelId = null; activeWindow.gallery.items = []; activeWindow.gallery.hasMoreBefore = activeWindow.gallery.hasMoreAfter = false; return; }
    const built = buildGallery(channelId);
    activeWindow.gallery.channelId = channelId;
    activeWindow.gallery.items = built.items;
    activeWindow.gallery.hasMoreBefore = built.hasMoreBefore;
    activeWindow.gallery.hasMoreAfter = built.hasMoreAfter;
}

/** Index of the image CURRENTLY shown in the panel within the gallery list, or
 *  -1 if it isn't found (url mismatch / different channel). Matches on the
 *  normalised url the panel loaded. */
function galleryCurrentIndex(): number {
    if (activeWindow.content.type !== "image" || !activeWindow.content.url) return -1;
    const cur = galleryFullResUrl(activeWindow.content.url);
    for (let i = 0; i < activeWindow.gallery.items.length; i++) {
        if (activeWindow.gallery.items[i].url === cur) return i;
    }
    return -1;
}

/** Ensure the gallery is built for the current channel and the current image is
 *  located in it; rebuild if the channel changed or the image isn't found yet
 *  (e.g. first nav after opening an image). Returns the current index. */
function ensureGallery(): number {
    const channelId = getCurrentChannelId();
    if (channelId !== activeWindow.gallery.channelId || galleryCurrentIndex() < 0) refreshGallery();
    return galleryCurrentIndex();
}

/** Load a gallery neighbour into the ACTIVE window IN PLACE. Gallery prev/next
 *  must advance the SAME tab you're stepping in — NOT acquire/spawn the transient
 *  window. The generic load() routes through focusTransientForOpen(), so on a
 *  PINNED image tab it would load the next image into the transient and leave the
 *  pinned tab unchanged (a silent jump to another window). Since the gallery state
 *  is per-window and we only step the window that owns it (the active one), we call
 *  showContent() directly here: it replaces the active window's content in place,
 *  preserving the pinned tab. The panel is already open during gallery nav, so we
 *  only need a render (no openPanelChrome / transient acquisition). */
function galleryLoadInPlace(next: { name: string; url: string }) {
    setIsNewFile(false);
    const result = showContent({ name: next.name, url: next.url, type: "image" });
    if (result !== "noop") forceRender?.();
}

/** Fetch one older/newer page into MessageStore, then rebuild the gallery. `dir`
 *  -1 = older (before the oldest loaded message), +1 = newer (after the newest).
 *  After it resolves we re-read getMessages and step onto the neighbour that is
 *  now in range. Best-effort: a failure just clears the loading flag. */
function galleryLoadMore(dir: -1 | 1) {
    const channelId = activeWindow.gallery.channelId || getCurrentChannelId();
    if (!channelId || activeWindow.gallery.loading) return;
    if (dir < 0 && !activeWindow.gallery.hasMoreBefore) return;
    if (dir > 0 && !activeWindow.gallery.hasMoreAfter) return;
    const items = activeWindow.gallery.items;
    if (!items.length) return;
    const anchor = dir < 0 ? items[0].messageId : items[items.length - 1].messageId;
    activeWindow.gallery.loading = true;
    forceRender?.();
    const arg: any = { channelId, limit: 50 };
    if (dir < 0) arg.before = anchor; else arg.after = anchor;
    let p: any;
    try {
        p = MessageActions.fetchMessages(arg);
    } catch {
        activeWindow.gallery.loading = false;
        forceRender?.();
        return;
    }
    Promise.resolve(p)
        .catch(() => { /* ignore fetch error */ })
        .then(() => {
            activeWindow.gallery.loading = false;
            refreshGallery();
            // Step onto the neighbour now that the page is loaded. The current
            // image kept its place in the rebuilt list; move one in `dir`.
            const idx = galleryCurrentIndex();
            const target = idx + dir;
            if (idx >= 0 && target >= 0 && target < activeWindow.gallery.items.length) {
                const next = activeWindow.gallery.items[target];
                galleryLoadInPlace(next); // replace the SAME (active) tab, never spawn a transient
            } else {
                forceRender?.();
            }
        });
}

/** Step to the previous/next image in the channel's ordered gallery. `dir` -1 =
 *  previous (older), +1 = next (newer). If stepping past a loaded end and there
 *  are more messages to fetch, load them first (then land on the neighbour). */
function galleryStep(dir: -1 | 1) {
    const idx = ensureGallery();
    if (idx < 0) return;
    const target = idx + dir;
    if (target >= 0 && target < activeWindow.gallery.items.length) {
        const next = activeWindow.gallery.items[target];
        galleryLoadInPlace(next); // replace the SAME (active) tab in place, never spawn a transient
        return;
    }
    // Past the loaded end → try to fetch more in that direction.
    galleryLoadMore(dir);
}

/** Can we step in `dir` (button enabled)? True when a neighbour is already loaded
 *  OR the collection has more to fetch in that direction. While a load-more is in
 *  flight the button is disabled (dimmed) but kept in its slot (rule 9). */
function galleryCanStep(dir: -1 | 1): boolean {
    if (activeWindow.gallery.loading) return false;
    const idx = galleryCurrentIndex();
    if (idx < 0) return false;
    const target = idx + dir;
    if (target >= 0 && target < activeWindow.gallery.items.length) return true;
    return dir < 0 ? activeWindow.gallery.hasMoreBefore : activeWindow.gallery.hasMoreAfter;
}

// --- code viewer view-state (find), shared with the toolbar -----------------
// The find fields mirror pdfView's: the bar/keyboard drive them, the controller
// (codeCtrl) reads them to drive the CodeMirror find decorations. Matching runs
// over the CM document (SearchCursor), so a match anywhere in the file is found
// regardless of viewport. Word-wrap is no longer a view-state toggle — the CM
// editor always wraps (EditorView.lineWrapping), per the locked Discord grammar
// that code never scrolls horizontally.
function resetCodeView() {
    activeWindow.codeView.findOpen = false;
    activeWindow.codeView.findQuery = "";
    activeWindow.codeView.findMatches = 0;
    activeWindow.codeView.findActive = 0;
    activeWindow.codeView.findCase = false;
}

// --- CSV viewer view-state (grid vs raw text), shared with the toolbar -------
// A .csv/.tsv file renders as a spreadsheet GRID by default; the header's
// Table/Raw toggle flips to `mode:"raw"`, which falls through to the SAME code
// viewer used for any text file (over content.code) — find, copy, wrap all work
// there unchanged. `delimiter` is decided per file (extension, then a sniff).
// Module-scope so the header toggle and the body renderer drive one state.
function resetCsvView() {
    activeWindow.csvView.mode = "grid"; // a fresh CSV always opens as a grid (per-file default)
    activeWindow.csvView.delimiter = ",";
}

// --- editable-mode view-state (view ↔ edit), shared with the toolbar (2b) -----
// A text-family file opens in VIEW mode; a single state-colour toggle enters EDIT
// over a TEMPORARY in-memory buffer (never the original file / Discord message).
// `mode` drives code (read↔edit), markdown (rendered↔edit-source) and .artifact
// (rendered↔html-source-edit). CSV is the special case: its grid/raw toggle is
// the edit entry (raw = the editable CM), so it uses csvView.mode, not this — but
// the BUFFER plumbing below is shared by all four. Module-scope so the header
// toggle and the body renderer drive one state.
//   `editBuffer` is the live edit text (null = unedited; the CM shows the original
//   source). It is mirrored into the active cache entry's view so it survives both
//   mode toggles AND a cache return (re-open lands on the edited text). Inline
//   artifacts (no cache key) keep the buffer here only, which is fine — they live
//   exactly as long as the dock is open.
function resetEditView() {
    activeWindow.editView.mode = "view"; // a fresh file always opens in the view mode
    activeWindow.editView.editBuffer = null; // and unedited (no buffer yet)
}

/** The PRISTINE (unedited) source text for the current editable type — also the
 *  merge-diff baseline. Every editable type keeps its original source in
 *  `content.code`, SEPARATE from the rendered/view payload (`content.html`), so it
 *  is immutable across view↔edit toggles:
 *   - code / csv-raw: content.code is the file text;
 *   - markdown: content.code is the raw md source (NOT the rendered html);
 *   - .artifact: content.code is the original html source. Leaving edit overwrites
 *     content.html (the rendered view) via setArtifactHtml but NEVER content.code,
 *     so re-entering edit still diffs against the true original. */
function editSourceText(w: DockWindow = activeWindow): string {
    return w.content.code || ""; // code / csv-raw / markdown-source / artifact-html
}

/** The current EDITABLE text = the buffer if the user has edited, else the
 *  original source. This is what the editable CM is seeded from and what the
 *  renderers (markdown re-render, artifact re-render, CSV grid re-parse) derive
 *  from on a toggle back to the view mode. */
function editBufferText(w: DockWindow = activeWindow): string {
    return w.editView.editBuffer != null ? w.editView.editBuffer : editSourceText(w);
}

/** Record a CM edit into the temporary buffer + mirror it into the active cache
 *  entry so it survives mode toggles and a cache return. Never touches the
 *  original source field (content.code / content.html stay the pristine file). */
function setEditBuffer(text: string) {
    activeWindow.editView.editBuffer = text;
    if (activeWindow.activeCacheKey != null) {
        const e = contentCache.get(activeWindow.activeCacheKey);
        if (e) e.view.editBuffer = text;
    }
}

// --- PDF viewer view-state (page nav / zoom / fit / find), shared w/ toolbar --
// `fit` is the auto-scale mode: "width" makes a page fill the panel width,
// "page" makes one page fit the panel height. `zoom` multiplies the fit scale
// (1 = exactly fit). `page`/`total` track the page indicator (1-based). `find`
// drives the in-panel search overlay. Module-scope so the header TOOLBAR and the
// keyboard handler drive the same state the PdfBody renders.
type PdfFit = "width" | "page";
// Drag mode: how a mouse drag over the PDF body behaves. "text" (default) = the
// pdf.js text layer captures the drag and SELECTS text (current behaviour). "pan"
// = the drag scrolls the body on BOTH axes (grab/grabbing cursor, text selection
// suppressed) so a zoomed PDF can be moved left/right + up/down — PDF can't wrap
// like code, so a horizontally-overflowing page genuinely needs panning.
type PdfDragMode = "text" | "pan";
const PDF_MIN_ZOOM = 0.25;
const PDF_MAX_ZOOM = 5;
function resetPdfView() {
    activeWindow.pdfView.page = 1;
    activeWindow.pdfView.total = 0;
    activeWindow.pdfView.fit = "width";
    activeWindow.pdfView.zoom = 1;
    activeWindow.pdfView.dragMode = "text";
    activeWindow.pdfView.findOpen = false;
    activeWindow.pdfView.findQuery = "";
    activeWindow.pdfView.findMatches = 0;
    activeWindow.pdfView.findActive = 0;
    activeWindow.pdfView.findCase = false;
}
interface PdfControls {
    goToPage: (n: number) => void;
    prevPage: () => void;
    nextPage: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    setFit: (f: PdfFit) => void;
    fitWidth: () => void; // reset zoom to 1 (fit panel width) + ensure width mode
    toggleDragMode: () => void; // flip text-select <-> pan for mouse drags
    toggleFind: () => void;
    toggleFindCase: () => void;
    setFindQuery: (q: string) => void;
    findNext: () => void;
    findPrev: () => void;
    // Live resize feedback: during a resize drag we scale the already-rendered
    // pages with a CSS transform (cheap, GPU-composited) for instant feedback,
    // then re-raster crisply on drag end. ratio = newWidth / widthAtDragStart.
    // beginLiveScale captures the scroll anchor (the content at the viewport top)
    // BEFORE the first scale change so liveScale can hold it stationary.
    beginLiveScale: () => void;
    liveScale: (ratio: number) => void;
    endLiveScale: () => void;
}
let pdfControls: PdfControls | null = null;

// --- per-channel memory (in-memory only) ------------------------------------
// Each channel id remembers the descriptor of whatever was last loaded into the
// panel + whether the panel was open there. On CHANNEL_SELECT we save the
// outgoing channel's state and restore the incoming one (re-load by descriptor;
// no rendered-DOM cache). Width is global (the single module `dockWidth`, which
// every window's `state.width` proxies).
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
// Word documents (mammoth -> HTML -> dark sandboxed iframe, view-only).
const DOCX_EXT = new Set(["docx"]);
// Spreadsheets (SheetJS -> first sheet -> CSV text -> retyped to the csv grid).
const XLSX_EXT = new Set(["xlsx", "xls"]);
// Mermaid diagram source (mermaid.render -> SVG -> dark sandboxed iframe).
const MERMAID_EXT = new Set(["mmd", "mermaid"]);
// Extensions rendered as an <img> (fit-width) in the panel instead of opening
// Discord's native lightbox.
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "apng", "avif"]);

// Image-attachment matcher for the channel-image gallery list (prev/next nav).
// Mirrors embed.ts's IMG_EXT_RE: an attachment counts as an image when its
// content_type is image/* OR its url path carries an image extension.
const GALLERY_IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|apng|avif)(\?|#|$)/i;

/** Strip Discord's thumbnail resize params (keep the signed ex/is/hm CDN params)
 *  so the gallery url matches the full-res url embed.ts loads on a chip click.
 *  MUST stay in sync with embed.ts's fullResImageUrl — the gallery indexes by the
 *  same normalised url the panel was loaded with, so a match locates the current
 *  image in the list. */
function galleryFullResUrl(raw: string): string {
    try {
        const u = new URL(raw, location.href);
        ["width", "height", "format", "quality", "size", "passthrough", "animated"].forEach(p => u.searchParams.delete(p));
        return u.toString();
    } catch {
        return raw;
    }
}

// Dark-themed stylesheet injected into the markdown sandbox iframe.
const MD_STYLE = `<style>
:root { color-scheme: dark; }
html, body { margin: 0; padding: 0; background: #1e1f22; }
/* Scrollbars: this is a sandboxed srcdoc iframe with its own document, so it can
   neither reach our style.css nor see Discord's --scrollbar-* theme vars. Paint the
   markdown body's vertical bar and any wide code-block / table horizontal bars in
   Discord's DARK thin-thumb colour so they read as dark-theme chrome, not the white
   UA default. #5f606a is exactly what --scrollbar-thin-thumb resolves to in the
   default dark theme. We do NOT copy Discord's 2px transparent padding-box border:
   that inset shrinks the visible thumb to ~half the bar, and the owner wants the
   thumb to FILL the full bar width like the old default scroller did. So: an 8px
   track, a rounded thumb painted edge-to-edge (no border, no padding-box clip),
   transparent track. Same fade-on-hover as Discord's .fade scrollers. Keep this in
   sync with the .dockview-body/.dockview-cm .cm-scroller rules in style.css. */
html::-webkit-scrollbar, body::-webkit-scrollbar,
pre::-webkit-scrollbar, table::-webkit-scrollbar { width: 8px; height: 8px; }
html::-webkit-scrollbar-track, body::-webkit-scrollbar-track,
pre::-webkit-scrollbar-track, table::-webkit-scrollbar-track { background-color: transparent; }
html::-webkit-scrollbar-thumb, body::-webkit-scrollbar-thumb,
pre::-webkit-scrollbar-thumb, table::-webkit-scrollbar-thumb {
  background-color: #5f606a;
  border-radius: 4px; min-height: 40px;
}
html::-webkit-scrollbar-corner, body::-webkit-scrollbar-corner,
pre::-webkit-scrollbar-corner, table::-webkit-scrollbar-corner { background-color: transparent; }
pre::-webkit-scrollbar-thumb, pre::-webkit-scrollbar-track,
table::-webkit-scrollbar-thumb, table::-webkit-scrollbar-track { visibility: hidden; }
pre:hover::-webkit-scrollbar-thumb, pre:hover::-webkit-scrollbar-track,
table:hover::-webkit-scrollbar-thumb, table:hover::-webkit-scrollbar-track { visibility: visible; }
/* MD-1: constrain the reading body to a comfortable measure (~70ch) and centre
   it as a column, so long-form markdown doesn't stretch edge-to-edge on a wide
   panel. At narrow widths the 70ch cap exceeds the panel so the column simply
   fills it (minus the side padding) — i.e. the constraint only bites once the
   panel is wide enough to harm readability. The cap is on the .md container;
   tables and code blocks inside still scroll horizontally within it when their
   own content is wider. */
.md {
  box-sizing: border-box;
  max-width: 70ch;
  margin: 0 auto;
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
/* .docx affordance: a quiet "Converted from .docx" pill above the converted body
   so a user knows this is a rendering, not the literal file. Muted, not loud. */
.dv-docx-note { color: #949ba4; font-size: 12px; margin: 0 0 14px; padding-bottom: 10px; border-bottom: 1px solid #3f4147; }
/* mermaid: the rendered SVG sits centred on the dark page and may be wider/taller
   than the panel, so the body scrolls to it. The SVG keeps its own intrinsic size
   (no forced width) so a large diagram stays legible and pannable via scroll. */
.dv-mermaid { display: flex; justify-content: center; padding: 8px 0; }
.dv-mermaid svg { max-width: 100%; height: auto; }
.dv-mermaid-error { color: #f85149; white-space: pre-wrap; word-break: break-word; background: #2b2d31; padding: 12px 14px; border-radius: 6px; border: 1px solid #1e1f22; }
</style>`;

// Dark-theme overlay for KaTeX math, injected after KATEX_CSS only when a doc
// has math. KaTeX colours math via `currentColor`, so it inherits .md's light
// text on the dark background with no extra work. We only: (1) let very wide
// DISPLAY math scroll horizontally instead of overflowing the 70ch column, and
// (2) style the raw-text fallback for a TeX parse error so it reads as an inline
// error rather than silently vanishing.
const MD_MATH_STYLE = `<style>
.md .katex { font-size: 1.05em; }
.md .katex-display { margin: 14px 0; overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
.md .katex-error { color: #f85149; }
.md .md-math-fallback { color: #f85149; background: #2b2d31; }
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
    // .docx -> mammoth converts to HTML, rendered through the markdown iframe shell.
    if (ext && DOCX_EXT.has(ext)) return "docx";
    // .xlsx/.xls -> SheetJS reads it; the loader retypes to "csv" and feeds the grid.
    if (ext && XLSX_EXT.has(ext)) return "xlsx";
    // .mmd/.mermaid -> mermaid renders the diagram to SVG in a dark sandboxed iframe.
    if (ext && MERMAID_EXT.has(ext)) return "mermaid";
    // CSV / TSV -> the spreadsheet grid (with a header toggle back to raw text).
    if (ext === "csv" || ext === "tsv" || ext === "tab") return "csv";
    // ONLY genuine HTML-intent extensions take the iframe path. Everything else
    // unrecognised is "unknown" (sniffed text/binary at load) — NOT "html", so a
    // .xyz / binary file is never dumped raw into a sandbox iframe.
    // .artifact is TSX authoring source; delivery is self-contained .html now, so
    // show a stray .artifact as code — never feed bare TSX to the html iframe.
    if (ext === "artifact") return "code";
    if (ext === "html" || ext === "htm") return "html";
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

/** Escape a string for use inside a double-quoted HTML ATTRIBUTE value (adds the
 *  quote escapes escapeHtml omits) — used for CSV cell title= attributes built
 *  via innerHTML. */
function escapeAttr(s: string): string {
    return escapeHtml(s).replace(/"/g, "&quot;");
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
    activeWindow.content.html = html;
    const nonce = pageNonce();
    activeWindow.content.frameHtml = nonce ? injectNonce(html, nonce) : html;
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

/** Open `html` in a real, IN-APP Vesktop window. The empty-window + document.write
 *  path rides Chromium's always-allowed about:blank window.open rule in the Vesktop
 *  fork's setWindowOpenHandler, so it opens an in-app BrowserWindow RELIABLY,
 *  independent of the user's "Open Links in app" setting. (window.open(httpUrl)
 *  only opens in-app when that setting is on, so it is NOT reliable — we always go
 *  through the empty window + write the document ourselves.) Best-effort: a null
 *  return (popup blocked) is a silent no-op. */
function openVesktopWindow(html: string, name: string) {
    const w = window.open("", name, "width=900,height=700,menubar=no,toolbar=no");
    if (!w) return;
    try {
        w.document.open();
        w.document.write(html);
        w.document.close();
        w.document.title = name;
    } catch {
        /* the window opened but writing failed — leave it (it's still in-app) */
    }
}

// Minimal dark page chrome shared by the per-type "open in browser" shells so the
// popped-out window reads like the dock (dark bg, no margins, fills the viewport).
const VESKTOP_WINDOW_CSS =
    "html,body{margin:0;padding:0;height:100%;background:#1e1f22;color:#dbdee1;"
    + "font-family:'gg sans','Noto Sans',Helvetica,Arial,sans-serif;}";

/** The HTML document to show when opening the CURRENT file in a Vesktop window,
 *  picked per content type. URL-backed types embed by their WORKING url (the same
 *  url the panel loaded + copy-link copies — correction-batch item (3)); text-ish
 *  types write their content directly. Returns null when there's nothing to show. */
function vesktopWindowHtml(w: DockWindow = activeWindow): string | null {
    const type = w.content.type;
    const url = w.content.url ? absUrl(w.content.url) : null;

    // .artifact / inline HTML — the artifact document itself (today's popout). When
    // edited, show the edited buffer; else the original html. docx (mammoth->HTML)
    // and mermaid (->SVG) are view-only and store their FULL rendered dark doc in
    // content.html, so they pop out exactly that document.
    if (type === "html" || type === "docx" || type === "mermaid") {
        const html = (type === "html" && w.editView.editBuffer != null) ? editBufferText(w) : w.content.html;
        return html || null;
    }
    // Markdown — the SAME rendered dark document the viewer iframe shows (reuse the
    // render pipeline). Edited buffer when edited, else the raw source.
    if (type === "markdown") {
        const md = (w.editView.editBuffer != null) ? editBufferText(w) : (w.content.code || "");
        return renderMarkdownDoc(md);
    }
    // Code / CSV-raw / unknown-as-text — the raw text in a <pre> (basic dark page).
    if (type === "code" || type === "csv" || type === "unknown") {
        const text = (w.content.code != null)
            ? ((w.editView.editBuffer != null) ? editBufferText(w) : w.content.code)
            : "";
        const pre = `<pre style="margin:0;padding:16px;white-space:pre-wrap;word-break:break-word;`
            + `font-family:Menlo,Consolas,'Courier New',monospace;font-size:13px;line-height:1.5;`
            + `color:#dbdee1;">${escapeHtml(text)}</pre>`;
        return `<!doctype html><html><head><meta charset="utf-8"><style>${VESKTOP_WINDOW_CSS}</style></head><body>${pre}</body></html>`;
    }
    // PDF — embed the file by url (the working url). <embed> renders the PDF via the
    // built-in viewer; <iframe> is the fallback the browser uses if <embed> fails.
    if (type === "pdf" && url) {
        const body = `<embed src="${escapeHtml(url)}" type="application/pdf" `
            + `style="position:fixed;inset:0;width:100%;height:100%;border:none;">`;
        return `<!doctype html><html><head><meta charset="utf-8"><style>${VESKTOP_WINDOW_CSS}</style></head><body>${body}</body></html>`;
    }
    // Image — the file centered on a dark backdrop (the working url).
    if (type === "image" && url) {
        const body = `<div style="position:fixed;inset:0;display:flex;align-items:center;`
            + `justify-content:center;background:#1e1f22;">`
            + `<img src="${escapeHtml(url)}" alt="" style="max-width:100%;max-height:100%;object-fit:contain;"></div>`;
        return `<!doctype html><html><head><meta charset="utf-8"><style>${VESKTOP_WINDOW_CSS}</style></head><body>${body}</body></html>`;
    }
    return null;
}

/** Open an arbitrary file URL in a real in-app Vesktop window. Used by the state
 *  cards (error / unsupported), where there is NO in-memory content to write but
 *  there is a working url. We still go through the empty-window + write path (so it
 *  stays in-app regardless of the "Open Links in app" setting) and embed the url in
 *  a full-bleed <iframe>; the browser falls back to a download for non-renderable
 *  types, exactly like opening the link would. */
function openUrlInVesktopWindow(url: string, name: string) {
    const abs = absUrl(url);
    const body = `<iframe src="${escapeHtml(abs)}" `
        + `style="position:fixed;inset:0;width:100%;height:100%;border:none;background:#1e1f22;"></iframe>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${VESKTOP_WINDOW_CSS}</style></head><body>${body}</body></html>`;
    openVesktopWindow(html, name);
}

/** Open the CURRENTLY-shown file in a real in-app Vesktop window (the default
 *  "Open in browser" per 선인 — an in-app window, NOT the external browser). One
 *  reliable path for every viewer: build the per-type shell, then open the empty
 *  window and write it. Falls back to embedding the url (state-card path) when
 *  there's a url but no renderable in-memory content (e.g. a still-loading file). */
export function openInVesktopWindow(w: DockWindow = activeWindow) {
    const html = vesktopWindowHtml(w);
    const name = (w.content.name as string | null) || "file";
    if (html) { openVesktopWindow(html, name); return; }
    if (w.content.url) openUrlInVesktopWindow(w.content.url, name);
}

/** Pop the current (or given) artifact out into a standalone in-app Vesktop
 *  window. Kept for the artifact-modal popout button + the debug surface; it now
 *  shares the one reliable empty-window+write path. */
export function popoutArtifact(html?: string | null, name?: string | null) {
    const h = html ?? activeWindow.content.html;
    const n = name ?? activeWindow.content.name ?? "artifact";
    if (!h) return;
    openVesktopWindow(h, n);
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
    a.download = name || activeWindow.content.name || "";
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
    activeWindow.content.html = null;
    activeWindow.content.frameHtml = null;
    resetEditView(); // a fresh artifact/markdown opens rendered + unedited
}
/** Reset only the pdf-specific fields (and bump the render token to abort).
 *  The live doc is OWNED by its cache entry now, so we do NOT destroy it here —
 *  eviction (disposeCacheEntry) is the single place a doc is destroyed. We just
 *  drop our pointer + bump the token so the in-flight render aborts. */
function resetPdf() {
    activeWindow.content.pdf = { doc: null, pages: 0, renderToken: activeWindow.content.pdf.renderToken + 1 };
    resetPdfView();
}
/** Reset only the code/text-specific fields. */
function resetCode() {
    activeWindow.content.code = null;
    activeWindow.content.codeLang = "plaintext";
    resetCodeView(); // a fresh code load opens with find closed
    resetEditView(); // and in read mode, unedited
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
        // Keep the PRISTINE html source in content.code (the immutable merge-diff
        // baseline + edit source), separate from the rendered content.html that
        // leaving edit overwrites — mirrors how markdown keeps its raw source.
        activeWindow.content.code = opts.html;
        activeWindow.content.codeLang = "html";
        activeWindow.content.loading = false;
    } else if (opts.url) {
        resetHtml();
        activeWindow.content.loading = true;
        const reqUrl = opts.url;
        dvFetch(reqUrl, opts.noCache)
            .then(r => {
                if (!r.ok) throw new Error(r.status + " " + r.statusText);
                return r.text();
            })
            .then(text => {
                // Stash the PRISTINE html source in code/codeLang (immutable merge
                // baseline + edit source), separate from the rendered html payload.
                if (entry) { entry.html = text; const nonce = pageNonce(); entry.frameHtml = nonce ? injectNonce(text, nonce) : text; entry.code = text; entry.codeLang = "html"; entry.loading = false; entry.error = null; }
                if (token !== loadSeq) return;
                setArtifactHtml(text);
                activeWindow.content.code = text;
                activeWindow.content.codeLang = "html";
                activeWindow.content.loading = false;
                activeWindow.content.error = null;
                forceRender?.();
            })
            .catch(e => {
                if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
                if (token !== loadSeq) return;
                activeWindow.content.loading = false;
                activeWindow.content.error = String(e?.message || e);
                forceRender?.();
            });
    } else {
        resetHtml();
        activeWindow.content.loading = false;
        activeWindow.content.error = "No artifact source";
    }
}

/** MCP-app loader. Renders AI-pushed HTML in the sandboxed (allow-scripts ONLY)
 *  iframe like an inline artifact, but stamps the host nonce so its inline scripts
 *  run under CSP and records the app id so the postMessage bridge can route to it.
 *  `token`/`entry` mirror the neighbouring loaders' signature (inline html isn't
 *  cached, so `entry` is always null here). */
function loadMcpApp(opts: { name: string; html?: string | null; id?: string | null }, token: number, entry: CacheEntry | null) {
    resetPdf();
    resetCode();
    const html = opts.html || "";
    const nonce = pageNonce();
    activeWindow.content.html = html;
    activeWindow.content.frameHtml = nonce ? injectNonce(html, nonce) : html;
    activeWindow.content.loading = false;
    activeWindow.mcpView.appId = opts.id ?? opts.name;
}

/** PDF loader: fetch -> ArrayBuffer -> pdf.js (main-thread worker). On success
 *  the doc is stored in `entry` (the cache owns it); a stale resolve (token !=
 *  loadSeq) destroys the freshly-built doc to avoid a leak. */
function loadPdf(opts: { name: string; url?: string | null; noCache?: boolean }, token: number, entry: CacheEntry | null) {
    resetHtml();
    resetPdf();
    resetCode();
    if (!opts.url) {
        activeWindow.content.loading = false;
        activeWindow.content.error = "No PDF source";
        return;
    }
    activeWindow.content.loading = true;
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
            activeWindow.content.pdf.doc = doc;
            activeWindow.content.pdf.pages = doc.numPages;
            activeWindow.pdfView.total = doc.numPages;
            // keep the cached/restored page if any (applyCachedView set it); else 1.
            activeWindow.content.pdf.renderToken += 1; // signal: a fresh doc is ready to render
            activeWindow.content.loading = false;
            activeWindow.content.error = null;
            forceRender?.();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (token !== loadSeq) return;
            activeWindow.content.loading = false;
            activeWindow.content.error = String(e?.message || e);
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

// ---------------------------------------------------------------------------
// CSV / TSV parsing (RFC-4180-ish) + delimiter detection.
// ---------------------------------------------------------------------------

/** Pick the field delimiter for a CSV/TSV file. The extension is the strong
 *  signal (.tsv/.tab -> tab, .csv -> comma); when it's ambiguous (e.g. a sniffed
 *  text/csv with no helpful name) we sniff the FIRST line and pick whichever of
 *  tab/comma/semicolon occurs most (a tie favours comma). We only inspect the
 *  first line so this is O(line), not O(file). */
function csvDelimiterFor(name: string | null, url: string | null, text: string): string {
    const ext = extOf(url) || extOf(name);
    if (ext === "tsv" || ext === "tab") return "\t";
    if (ext === "csv") return ",";
    // Ambiguous: sniff the header line (up to the first newline) outside quotes.
    const nl = text.indexOf("\n");
    const head = (nl >= 0 ? text.slice(0, nl) : text).slice(0, 4096);
    let inQ = false, tab = 0, comma = 0, semi = 0;
    for (let i = 0; i < head.length; i++) {
        const c = head[i];
        if (c === '"') inQ = !inQ;
        else if (!inQ) {
            if (c === "\t") tab++;
            else if (c === ",") comma++;
            else if (c === ";") semi++;
        }
    }
    if (tab > comma && tab >= semi) return "\t";
    if (semi > comma && semi > tab) return ";";
    return ",";
}

/** Parse CSV/TSV text into a row/cell matrix per RFC 4180, with the given single-
 *  char delimiter. Honours: quoted fields ("..."), the delimiter and newlines
 *  INSIDE quotes (kept literal, never split), the "" escape for a literal quote,
 *  and both \n and \r\n line endings. Ragged rows are returned as-is (the grid
 *  pads short rows / clips against the header column count at render time, so the
 *  parser never invents or drops cells). A trailing newline does NOT yield a
 *  spurious empty final row. Returns rows of string cells. */
function parseDelimited(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let started = false; // has the current row produced any char/field yet?
    const n = text.length;
    const d = delimiter;

    const endField = () => { row.push(field); field = ""; started = true; };
    const endRow = () => { endField(); rows.push(row); row = []; started = false; };

    for (let i = 0; i < n; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } // "" -> literal "
                else inQuotes = false; // closing quote
            } else {
                field += c; // delimiter / newline inside quotes stays literal
            }
            continue;
        }
        if (c === '"') { inQuotes = true; started = true; continue; }
        if (c === d) { endField(); continue; }
        if (c === "\n") { endRow(); continue; }
        if (c === "\r") {
            if (text[i + 1] === "\n") i++; // swallow the LF of a CRLF
            endRow();
            continue;
        }
        field += c;
        started = true;
    }
    // Flush a final field/row only if there's pending content (so a trailing
    // newline doesn't add a phantom empty row, but a last line without a newline
    // is still captured).
    if (started || field.length || row.length) endRow();
    return rows;
}

/** CODE / TEXT loader: fetch text and stash it + its resolved hljs language. */
function loadCode(opts: { name: string; url?: string | null; noCache?: boolean }, token: number, entry: CacheEntry | null) {
    resetHtml();
    resetPdf();
    resetCode();
    if (!opts.url) {
        activeWindow.content.loading = false;
        activeWindow.content.error = "No source";
        return;
    }
    const lang = codeLangFor(extOf(opts.url) || extOf(opts.name));
    activeWindow.content.codeLang = lang;
    if (entry) entry.codeLang = lang;
    activeWindow.content.loading = true;
    const reqUrl = opts.url;
    dvFetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.text();
        })
        .then(text => {
            if (entry) { entry.code = text; entry.loading = false; entry.error = null; }
            if (token !== loadSeq) return;
            activeWindow.content.code = text;
            activeWindow.content.loading = false;
            activeWindow.content.error = null;
            forceRender?.();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (token !== loadSeq) return;
            activeWindow.content.loading = false;
            activeWindow.content.error = String(e?.message || e);
            forceRender?.();
        });
}

/** CSV / TSV loader: fetch text and stash it as content.code (so the RAW view is
 *  the very same code viewer) plus decide the delimiter. The grid itself is parsed
 *  lazily from content.code on mount (CsvBody) so the cache stays text-only — no
 *  parsed-matrix payload to keep alive or invalidate. Mirrors loadCode otherwise. */
function loadCsv(opts: { name: string; url?: string | null; noCache?: boolean }, token: number, entry: CacheEntry | null) {
    resetHtml();
    resetPdf();
    resetCode();
    resetCsvView(); // a fresh CSV always opens as a grid
    if (!opts.url) {
        activeWindow.content.loading = false;
        activeWindow.content.error = "No source";
        return;
    }
    activeWindow.content.codeLang = "plaintext"; // the raw view is plaintext (no hljs lang)
    if (entry) entry.codeLang = "plaintext";
    activeWindow.content.loading = true;
    const reqUrl = opts.url;
    dvFetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.text();
        })
        .then(text => {
            if (entry) { entry.code = text; entry.loading = false; entry.error = null; }
            if (token !== loadSeq) return;
            activeWindow.content.code = text;
            activeWindow.csvView.delimiter = csvDelimiterFor(opts.name, reqUrl, text);
            activeWindow.content.loading = false;
            activeWindow.content.error = null;
            forceRender?.();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (token !== loadSeq) return;
            activeWindow.content.loading = false;
            activeWindow.content.error = String(e?.message || e);
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
        activeWindow.content.loading = false;
        activeWindow.content.error = "No source";
        return;
    }
    activeWindow.content.loading = true;
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
                activeWindow.content.type = "code";
                activeWindow.content.code = text;
                activeWindow.content.codeLang = "plaintext";
                activeWindow.content.binary = false;
                activeWindow.content.loading = false;
                activeWindow.content.error = null;
                forceRender?.();
            } else {
                if (entry) { entry.binary = true; entry.loading = false; entry.error = null; }
                if (token !== loadSeq) return;
                activeWindow.content.binary = true;
                activeWindow.content.loading = false;
                activeWindow.content.error = null;
                forceRender?.();
            }
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (token !== loadSeq) return;
            activeWindow.content.loading = false;
            activeWindow.content.error = String(e?.message || e);
            forceRender?.();
        });
}

// ---------------------------------------------------------------------------
// Markdown math (KaTeX) — render `$...$` inline and `$$...$$` display math.
// ---------------------------------------------------------------------------
// We register the math detector as marked EXTENSIONS (a block tokenizer for
// `$$...$$` and an inline tokenizer for `$...$`) rather than pre-scanning the
// raw source with a regex. That is deliberate: marked has already carved out
// fenced code blocks and inline code spans by the time these tokenizers run, so
// a `$` inside ```code``` or `` `code` `` is NEVER offered to them — code-block
// and inline-code protection comes for free, no fragile masking. `\$` escapes
// are handled by the `start`/`tokenizer` rejecting a dollar that the lexer has
// already consumed as an escape, plus our own escaped-delimiter check.
//
// Each math token is rendered to self-contained HTML by KaTeX at parse time
// (renderer below). `throwOnError:false` makes a bad expression degrade to the
// raw source text styled red instead of throwing — a single broken `$\frac{$`
// can't break the whole document.
//
// `_mdHasMath` is set by the renderer whenever it emits real math, so the doc
// wrapper knows whether to inject the (heavy) KaTeX CSS+font payload.
let _mdHasMath = false;

function renderMath(tex: string, displayMode: boolean): string {
    try {
        return katex.renderToString(tex, {
            displayMode,
            throwOnError: false,
            output: "html",
            // Render a parse error as the raw source (red) instead of throwing,
            // so one bad expression never takes down the rest of the doc.
            errorColor: "#f85149",
            strict: "ignore",
            trust: false
        });
    } catch {
        // Belt-and-braces: even with throwOnError:false KaTeX can throw on a
        // few pathological inputs. Fall back to the literal delimited source.
        const d = displayMode ? "$$" : "$";
        return `<code class="md-math-fallback">${escapeHtml(d + tex + d)}</code>`;
    }
}

// Register once at module load. marked, katex and escapeHtml are plain bundled
// imports (NOT the lazy @webpack proxies), so this top-level call is safe.
marked.use({
    extensions: [
        {
            // Display math: $$ ... $$  (may span multiple lines). Block-level so
            // it sits on its own line like a paragraph.
            name: "mathBlock",
            level: "block",
            start(src: string) {
                const i = src.indexOf("$$");
                return i < 0 ? undefined : i;
            },
            tokenizer(src: string) {
                // Require the opener at position 0 and a closing $$. Content is
                // non-empty (reject "$$$$"). `[\s\S]` so it can span newlines.
                const m = /^\$\$([\s\S]+?)\$\$/.exec(src);
                if (!m) return undefined;
                return { type: "mathBlock", raw: m[0], text: m[1] };
            },
            renderer(token: any) {
                _mdHasMath = true;
                return renderMath(token.text, true) + "\n";
            }
        },
        {
            // Inline math: $ ... $  on a single line. Guarded against prose that
            // merely contains dollar signs (prices, shell vars) the same way the
            // chat renderer is: no whitespace hugging the delimiters, and a span
            // that is nothing but a number/currency amount is left as text.
            name: "mathInline",
            level: "inline",
            start(src: string) {
                // Point the inline lexer at the next single `$` that is not part
                // of a `$$` (display handled at block level) so it gives us a
                // chance to tokenize there.
                const m = /(?<!\$)\$(?!\$)/.exec(src);
                return m ? m.index : undefined;
            },
            tokenizer(src: string) {
                if (src[0] !== "$" || src[1] === "$") return undefined;
                // Closing single `$` that is not itself escaped or doubled.
                const m = /^\$((?:\\.|[^$\\])+?)\$(?!\$)/.exec(src);
                if (!m) return undefined;
                const inner = m[1];
                // (1) no whitespace immediately inside the delimiters: "$ x$".
                if (/^\s/.test(inner) || /\s$/.test(inner)) return undefined;
                // (2) a digit right after the closing $ means the next "$" was a
                //     price ("$5 and $10") — reject this span.
                const after = src.charAt(m[0].length);
                if (/\d/.test(after)) return undefined;
                // (3) pure number / currency-ish amount with no letters or TeX
                //     command: "$3.50", "$1,000" — leave as text.
                if (!/[a-zA-Z\\]/.test(inner) && /^[\d.,\s+\-*/()]+$/.test(inner)) return undefined;
                return { type: "mathInline", raw: m[0], text: inner };
            },
            renderer(token: any) {
                _mdHasMath = true;
                return renderMath(token.text, false);
            }
        }
    ]
});

/** Render markdown source to body HTML, tracking whether it emitted any math.
 *  `_mdHasMath` is reset per call and read straight after, so the doc wrapper
 *  can decide whether to pay for the KaTeX CSS/font payload. */
function markdownToHtml(md: string): { html: string; hasMath: boolean } {
    _mdHasMath = false;
    let html: string;
    try {
        html = marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
    } catch (e) {
        return { html: "<pre>" + escapeHtml(String(e)) + "</pre>", hasMath: false };
    }
    return { html, hasMath: _mdHasMath };
}

/** The full markdown -> dark sandboxed-doc pipeline (marked + code highlight +
 *  KaTeX-aware wrapper). Shared by the loader (first render from the fetched
 *  source) and the edit toggle (re-render from the edited buffer) so a markdown
 *  edit shows up rendered identically. */
function renderMarkdownDoc(md: string): string {
    const { html, hasMath } = markdownToHtml(md);
    const bodyHtml = highlightMarkdownCode(html);
    return wrapMarkdownDoc(bodyHtml, hasMath);
}

// mermaid is initialized once, lazily, on the first diagram render. It must NOT
// auto-scan the page (startOnLoad:false) — we drive every render explicitly. The
// dark theme matches the dock; securityLevel "strict" strips any embedded HTML/JS
// in node labels so a hostile diagram can't inject script when we drop the SVG in.
let _mermaidReady = false;
function ensureMermaid() {
    if (_mermaidReady) return;
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    _mermaidReady = true;
}

/** Render mermaid source to a full dark sandboxed-iframe document. mermaid.render
 *  is async and DOM-dependent, so this returns a Promise<string>. On a parse/render
 *  error we degrade to the raw source in a red <pre> (one bad diagram never throws
 *  out of the loader). The finished SVG is centered in a scrollable dark body. */
async function renderMermaidDoc(src: string): Promise<string> {
    ensureMermaid();
    const id = "dvMermaid" + Math.random().toString(36).slice(2);
    let body: string;
    try {
        const { svg } = await mermaid.render(id, src);
        body = `<div class="dv-mermaid">${svg}</div>`;
    } catch (e) {
        body = `<pre class="dv-mermaid-error">${escapeHtml(String((e as any)?.message || e))}\n\n${escapeHtml(src)}</pre>`;
    }
    // Reuse the markdown doc shell (dark theme, link routing) so the diagram body
    // sits on the same dark page; the mermaid-specific layout rules live in MD_STYLE.
    return wrapMarkdownDoc(body, false);
}

/** MARKDOWN loader: fetch -> marked -> dark doc -> nonce sandbox iframe path. */
function loadMarkdown(opts: { name: string; url?: string | null; noCache?: boolean }, token: number, entry: CacheEntry | null) {
    resetPdf();
    resetCode();
    if (!opts.url) {
        resetHtml();
        activeWindow.content.loading = false;
        activeWindow.content.error = "No source";
        return;
    }
    resetHtml();
    activeWindow.content.loading = true;
    const reqUrl = opts.url;
    dvFetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.text();
        })
        .then(md => {
            const fullHtml = renderMarkdownDoc(md);
            // Keep the RAW markdown source around (content.code, lang "markdown") so
            // the edit mode can open a CM over the source — the rendered html is the
            // VIEW; edits re-render from this source. (resetCode nulled it above.)
            if (entry) { entry.html = fullHtml; const nonce = pageNonce(); entry.frameHtml = nonce ? injectNonce(fullHtml, nonce) : fullHtml; entry.code = md; entry.codeLang = "markdown"; entry.loading = false; entry.error = null; }
            if (token !== loadSeq) return;
            setArtifactHtml(fullHtml);
            activeWindow.content.code = md;
            activeWindow.content.codeLang = "markdown";
            activeWindow.content.loading = false;
            activeWindow.content.error = null;
            forceRender?.();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (token !== loadSeq) return;
            activeWindow.content.loading = false;
            activeWindow.content.error = String(e?.message || e);
            forceRender?.();
        });
}

/** DOCX loader: fetch the .docx as an ArrayBuffer (it's binary OOXML, NOT text),
 *  convert it to HTML with mammoth, then push the HTML through the SAME dark
 *  sandboxed-iframe document the markdown viewer uses (wrapMarkdownDoc + the nonce
 *  iframe via setArtifactHtml). View-only — there is no editable source for a
 *  converted .docx, so it never enters edit mode. A tiny "Converted from .docx"
 *  banner sits at the top of the doc as a light affordance. */
function loadDocx(opts: { name: string; url?: string | null; noCache?: boolean }, token: number, entry: CacheEntry | null) {
    resetPdf();
    resetCode();
    resetHtml();
    if (!opts.url) {
        activeWindow.content.loading = false;
        activeWindow.content.error = "No source";
        return;
    }
    activeWindow.content.loading = true;
    const reqUrl = opts.url;
    dvFetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.arrayBuffer();
        })
        .then(buf => mammoth.convertToHtml({ arrayBuffer: buf }))
        .then(result => {
            // mammoth returns the body HTML in result.value; wrap it in the dark
            // markdown doc shell (no math) so it themes + sandboxes identically.
            const banner = `<div class="dv-docx-note">${escapeHtml("Converted from .docx")}</div>`;
            const fullHtml = wrapMarkdownDoc(banner + (result?.value || ""), false);
            if (entry) {
                entry.html = fullHtml;
                const nonce = pageNonce();
                entry.frameHtml = nonce ? injectNonce(fullHtml, nonce) : fullHtml;
                entry.loading = false;
                entry.error = null;
            }
            if (token !== loadSeq) return;
            setArtifactHtml(fullHtml);
            activeWindow.content.loading = false;
            activeWindow.content.error = null;
            forceRender?.();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (token !== loadSeq) return;
            activeWindow.content.loading = false;
            activeWindow.content.error = String(e?.message || e);
            forceRender?.();
        });
}

/** XLSX loader: fetch the workbook as an ArrayBuffer (binary), read it with
 *  SheetJS, serialise the first sheet to CSV text, and RETYPE the file to "csv" so
 *  the existing spreadsheet GRID (CsvBody) renders it — exactly the way loadUnknown
 *  retypes a sniffed-text file to "code". The cache entry is retyped too, so a
 *  re-open restores it as a csv grid (its key is still "xlsx|url" from the original
 *  detectType, which is fine — only the RENDER type changes). */
function loadXlsx(opts: { name: string; url?: string | null; noCache?: boolean }, token: number, entry: CacheEntry | null) {
    resetHtml();
    resetPdf();
    resetCode();
    resetCsvView(); // a fresh sheet always opens as a grid
    if (!opts.url) {
        activeWindow.content.loading = false;
        activeWindow.content.error = "No source";
        return;
    }
    activeWindow.content.loading = true;
    const reqUrl = opts.url;
    dvFetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.arrayBuffer();
        })
        .then(buf => {
            const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
            const firstName = wb.SheetNames[0];
            const sheet = firstName ? wb.Sheets[firstName] : null;
            // sheet_to_csv emits RFC-4180 CSV (comma delimiter, quoted as needed),
            // which parseDelimited reads back into the grid unchanged.
            const text = sheet ? XLSX.utils.sheet_to_csv(sheet) : "";
            if (entry) {
                entry.type = "csv";
                entry.code = text;
                entry.codeLang = "plaintext";
                entry.loading = false;
                entry.error = null;
            }
            if (token !== loadSeq) return;
            activeWindow.content.type = "csv";
            activeWindow.content.code = text;
            activeWindow.content.codeLang = "plaintext";
            activeWindow.csvView.delimiter = ",";
            activeWindow.content.loading = false;
            activeWindow.content.error = null;
            forceRender?.();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (token !== loadSeq) return;
            activeWindow.content.loading = false;
            activeWindow.content.error = String(e?.message || e);
            forceRender?.();
        });
}

/** MERMAID loader: fetch the diagram source as text, render it to an SVG with
 *  mermaid (async, dark theme), then drop the SVG into the SAME dark sandboxed
 *  iframe the markdown/docx viewers use. mermaid needs the live DOM to lay the
 *  diagram out, so we render on the MAIN side and ship only the finished SVG into
 *  the (script-free) sandbox — no mermaid runtime runs inside the iframe. */
function loadMermaid(opts: { name: string; url?: string | null; noCache?: boolean }, token: number, entry: CacheEntry | null) {
    resetPdf();
    resetCode();
    resetHtml();
    if (!opts.url) {
        activeWindow.content.loading = false;
        activeWindow.content.error = "No source";
        return;
    }
    activeWindow.content.loading = true;
    const reqUrl = opts.url;
    dvFetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.text();
        })
        .then(src => renderMermaidDoc(src))
        .then(fullHtml => {
            if (entry) {
                entry.html = fullHtml;
                const nonce = pageNonce();
                entry.frameHtml = nonce ? injectNonce(fullHtml, nonce) : fullHtml;
                entry.loading = false;
                entry.error = null;
            }
            if (token !== loadSeq) return;
            setArtifactHtml(fullHtml);
            activeWindow.content.loading = false;
            activeWindow.content.error = null;
            forceRender?.();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (token !== loadSeq) return;
            activeWindow.content.loading = false;
            activeWindow.content.error = String(e?.message || e);
            forceRender?.();
        });
}

/** IMAGE loader: nothing to fetch — the <img> renders content.url directly. */
function loadImage(opts: { name: string; url?: string | null }, _token: number, entry: CacheEntry | null) {
    resetHtml();
    resetPdf();
    resetCode();
    if (!opts.url) {
        activeWindow.content.loading = false;
        activeWindow.content.error = "No image source";
        return;
    }
    // The <img> tag streams the url itself; no manual fetch/decode needed. A
    // FRESH image opens at fit (scale 1); a cache RESTORE keeps the saved view
    // (applyCachedView already populated imgView), so only reset on a fresh load.
    if (entry) entry.loading = false;
    resetImgView();
    activeWindow.content.loading = false;
    activeWindow.content.error = null;
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
 *  the sandbox itself; the injected script routes clicks to the host browser.
 *
 *  When the doc contains math we additionally inject the inlined KaTeX stylesheet
 *  (CSS + base64 woff2 fonts) plus a small dark-theme overlay. The sandbox can't
 *  load external fonts, so without the inlined payload math glyphs would render
 *  as tofu boxes — hence we only pay for it when `hasMath` is true. */
function wrapMarkdownDoc(bodyHtml: string, hasMath: boolean): string {
    const mathStyle = hasMath ? `<style>${KATEX_CSS}</style>${MD_MATH_STYLE}` : "";
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">${MD_STYLE}${mathStyle}</head><body><article class="md">${bodyHtml}</article>${MD_LINK_SCRIPT}</body></html>`;
}

/** Show a file in the panel body. Returns "noop" (already shown), "cache"
 *  (restored from cache, no fetch) or "fetch" (a fresh fetch was kicked off).
 *  The shared engine behind both load() (chip click) and restoreDescriptor()
 *  (channel return). It picks the renderer, hits/populates the cache, and bumps
 *  the load token. It does NOT touch open-state / channel bookkeeping — the
 *  callers do that around it. */
function showContent(opts: { name: string; html?: string | null; url?: string | null; type: ContentType; noCache?: boolean; id?: string | null }): "noop" | "cache" | "fetch" {
    const name = opts.name || "file";
    const type = opts.type;
    const url = opts.url ?? null;
    const key = opts.html != null ? null : cacheKeyFor(url, type);

    // --- same file already shown? -> no-op (keep DOM, scroll, zoom as-is) -----
    // A retry (noCache) skips the no-op shortcut so it actually re-fetches.
    if (!opts.noCache && key != null && key === activeWindow.activeCacheKey && activeWindow.content.name != null && activeWindow.content.error == null) {
        activeWindow.content.name = name;
        activeWindow.activeDescriptor = { name, url: url as string, type };
        return "noop";
    }

    // Leaving the current file: snapshot its live view-state into its entry.
    snapshotActiveView();
    // The fullscreen lightbox is bound to whatever image was shown; switching to
    // a DIFFERENT file (we're past the no-op guard) must close it so we never
    // strand the overlay over the wrong / a non-image body.
    activeWindow.imgView.fullscreen = false;

    // --- cache hit on a DIFFERENT file -> instant restore (no fetch) ----------
    // A retry (noCache) skips the cache and always re-fetches.
    const hit = !opts.noCache && key != null ? contentCache.get(key) : null;
    if (hit && hit.error == null && !hit.loading) {
        loadSeq += 1; // supersede any in-flight loader
        activeWindow.content.seq += 1; // new body identity (different file)
        hit.name = name; // honour the (possibly fresh) display name
        mountFromCache(hit);
        // The descriptor must re-PRODUCE this entry's cache key on a later restore,
        // so it carries the key's ROUTING type — not the entry's RENDER type. They
        // differ for a TSX `.artifact`: it's keyed/fetched as "html" (loadHtml re-
        // detects + re-wraps the source) but RENDERS as "mcpapp". Using hit.type
        // here would key a restore as "mcpapp|url" (miss → loadMcpApp with no html).
        activeWindow.activeDescriptor = { name, url: hit.url, type: detectType({ url: hit.url, name }) };
        return "cache";
    }

    // --- miss (or inline html / errored entry) -> fetch + populate cache ------
    const token = ++loadSeq;
    activeWindow.content.name = name;
    activeWindow.content.url = url;
    activeWindow.content.error = null;
    activeWindow.content.binary = false;
    activeWindow.content.seq += 1;
    activeWindow.content.type = type;

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
        activeWindow.activeCacheKey = key;
        cacheTouch(entry);
    } else {
        activeWindow.activeCacheKey = null;
    }
    // a brand-new load opens at the default view (no cached view to apply).
    pendingScrollTop = null;

    if (type === "pdf") loadPdf(opts, token, entry);
    else if (type === "image") loadImage(opts, token, entry);
    else if (type === "code") loadCode(opts, token, entry);
    else if (type === "csv") loadCsv(opts, token, entry);
    else if (type === "markdown") loadMarkdown(opts, token, entry);
    else if (type === "docx") loadDocx(opts, token, entry);
    else if (type === "xlsx") loadXlsx(opts, token, entry);
    else if (type === "mermaid") loadMermaid(opts, token, entry);
    else if (type === "unknown") loadUnknown(opts, token, entry);
    else if (type === "mcpapp") loadMcpApp(opts, token, entry);
    else loadHtml(opts, token, entry);

    // Inline-html artifacts (no url) can't be re-loaded by descriptor, so they
    // are NOT remembered per-channel (descriptor needs a url).
    activeWindow.activeDescriptor = url ? { name, url, type } : null;
    return "fetch";
}

/** CONTENT-TYPE ROUTER. Load anything into the dock panel BODY and open it.
 *  Backed by the content cache: re-clicking the file already shown is a no-op
 *  (no fetch, no re-render, no flicker); clicking a different file we've seen
 *  restores it instantly from cache (no fetch); only a genuinely new file
 *  fetches. The view-state of the file we're leaving is snapshotted first. */
export function load(opts: { name: string; html?: string | null; url?: string | null; type?: ContentType; noCache?: boolean; id?: string | null }) {
    // Opening a file always lands in the TRANSIENT window of the current channel
    // (created if none) and never overwrites a pinned tab — pin-driven tabs.
    focusTransientForOpen();
    // Viewing a real file ends any new-file session (the empty editable surface),
    // so the loaded file gets a fresh original baseline + the merge diff.
    setIsNewFile(false);
    const result = showContent({ name: opts.name, html: opts.html, url: opts.url, type: detectType(opts), noCache: opts.noCache, id: opts.id });

    // Open FIRST, then persist — so the saved per-channel state records open:true.
    openPanelChrome();
    // A no-op didn't change the body; everything else needs a render.
    if (result !== "noop") forceRender?.();
}

/** Render an MCP app: a sandboxed HTML widget driven over the bridge as an MCP
 *  Apps host. Routes through load() (which focuses the transient window, opens the
 *  chrome and re-renders) with the mcpapp type; `id` (= the ui:// resource uri) is
 *  threaded through so loadMcpApp keys the postMessage registry by it. The launching
 *  tool's arguments + CallToolResult are stashed on a fresh session record and are
 *  flushed to the frame as tool-input/tool-result once it finishes the handshake. */
export function renderMcpApp({ id, html, toolArguments, toolResult }: { id: string; html: string; toolArguments?: any; toolResult?: any; }) {
    // Fresh session for this app id: discard any prior frame/handshake state.
    mcpSessions.set(id, { win: null, initialized: false, toolArguments, toolResult });
    load({ name: id, html, type: "mcpapp", id });
}

/** Make the ACTIVE window the current channel's TRANSIENT window, ready to take a
 *  freshly-opened file (so a chip click / New file replaces the transient content
 *  and NEVER clobbers a pinned tab). If a transient window already exists it is
 *  re-bound to the current channel and focused; otherwise a new one is appended.
 *  Before swapping away from a pinned active window we snapshot its live view-state
 *  so its tab keeps its scroll/zoom/edit-buffer. */
function focusTransientForOpen() {
    const channelId = getCurrentChannelId();
    let t = transientWindow();
    if (!t) {
        // No transient slot (every window is pinned) → create one for this channel.
        snapshotActiveView();
        t = makeWindow({ pinned: false, ownerChannelId: channelId });
        windows.push(t);
    } else {
        // Re-bind the lone transient to the channel we're opening in (it follows
        // the current channel, exactly as the old single window did).
        t.ownerChannelId = channelId;
    }
    if (activeWindow !== t) {
        snapshotActiveView();
        setActiveWindow(t);
    }
}

/** The shared "open the panel into the right slot" side-effects, run by both
 *  load() (chip click) and onNewFile() (the `+` menu's New file). Opens FIRST then
 *  persists, so the per-channel save records open:true; collapses the native
 *  thread/channel sidebar + member list / profile sidebar so the dock holds the
 *  exclusive right slot exactly like a real thread. Does NOT forceRender — the
 *  caller decides whether the body changed. */
function openPanelChrome() {
    closeNativeChannelSidebar();
    activeWindow.state.open = true;
    lsSet(LS_OPEN, "1");
    saveCurrentChannelState();
    ensureHost();
    applyOpenState();
    syncNativeMemberList(true); // collapse the member list like a thread
    syncNativeProfileSidebar(true);
}

/** Resolve the channel a staged file should attach to: the channel a new-file
 *  session was opened from (if any), else the channel currently being viewed. */
function resolveTargetChannel(): any {
    return getNewFileChannel()
        || getCurrentChannel()
        || ChannelStore.getChannel(SelectedChannelStore.getChannelId());
}

/** The `+`-menu "New file": open the dock with an EMPTY editable surface — the
 *  same CodeMirror editor every text viewer uses (2b), in EDIT mode, default
 *  markdown. It is a normal `content` (type markdown, empty source) so find / copy
 *  / the edit toggle all apply unchanged; `isNewFile` flags it so it edits as a
 *  plain editor (NO merge diff — there is no original baseline) and the attach
 *  filename defaults to `message.md`. `channel` is the menu's props.channel if
 *  present (else resolved to the current channel at attach time). */
export function onNewFile(channel: any | null) {
    // A new file is a TRANSIENT open: it lands in the current channel's transient
    // window (created if none) and never clobbers a pinned tab.
    focusTransientForOpen();
    // Leaving whatever was docked: snapshot its view-state so a later re-open of
    // that file is unaffected (mirrors showContent's switch-away bookkeeping).
    snapshotActiveView();
    activeWindow.imgView.fullscreen = false;
    loadSeq += 1; // supersede any in-flight loader

    setIsNewFile(true);
    setNewFileChannel(channel ?? resolveTargetChannel());

    // A fresh empty markdown content with no url (so it's never cached) in edit
    // mode. The CM seeds from the (empty) buffer; editSourceText() returns "".
    resetPdf();
    resetHtml();
    resetCode();
    activeWindow.content.name = STRINGS.attach.defaultNewName; // header title = the default name
    activeWindow.content.type = "markdown";
    activeWindow.content.url = null;
    activeWindow.content.html = null;
    activeWindow.content.frameHtml = null;
    activeWindow.content.code = "";
    activeWindow.content.codeLang = "markdown";
    activeWindow.content.loading = false;
    activeWindow.content.error = null;
    activeWindow.content.binary = false;
    activeWindow.content.seq += 1;
    activeWindow.activeCacheKey = null;
    activeWindow.activeDescriptor = null;
    pendingScrollTop = null;
    // open directly in edit mode (the decision: open default = view, but a NEW
    // file = edit) with an empty buffer.
    activeWindow.editView.mode = "edit";
    activeWindow.editView.editBuffer = "";

    openPanelChrome();
    forceRender?.();
}

/** The pristine original text of the CURRENTLY-shown editable file, used as the
 *  merge-diff baseline. A NEW file has none (it never had an original) → null, so
 *  the editor mounts as a plain CM with no diff. Otherwise it's editSourceText()
 *  (artifact html / code / csv-raw / markdown source). */
function editOriginalText(): string | null {
    if (getIsNewFile()) return null;
    return editSourceText();
}

/** ⋯-menu "Attach to message": stage the file CURRENTLY shown in the panel as a
 *  pending upload on the active channel (the native attachment chip → review-
 *  before-send). When the editable buffer has edits, the EDITED buffer is staged
 *  (선인: "편집한거까지 해서 첨부") — the original Discord message is never touched.
 *  `nameOverride` (from the attach filename input) renames the staged file; blank
 *  → the file's own name. The bytes come from what's ALREADY loaded — never an
 *  external fetch (the renderer's CSP blocks arbitrary URLs, a re-fetch is waste):
 *    - editable text family WITH edits (code / csv / markdown / artifact): the
 *      edited buffer, in memory.
 *    - text family, no edits: `content.code` (the original text).
 *    - artifact (inline html with no url), no edits: `content.html`.
 *    - everything else with a url (pdf / image / markdown / artifact-from-url):
 *      fetch the url and attach the blob. This is the SAME Discord-CDN fetch the
 *      loaders already do successfully; it is the file's own source.
 *  Best-effort throughout: any failure is a silent no-op so nothing is disturbed. */
export function attachActiveFile(nameOverride?: string | null, w: DockWindow = activeWindow) {
    // A non-active tab's ⋯ attaches THAT window's file. Resolve the target channel
    // from the window's own new-file target (if any) before falling back to the
    // current channel, so a pinned tab attaches to where you are now.
    const channel = w.newFileChannel || getCurrentChannel() || ChannelStore.getChannel(SelectedChannelStore.getChannelId());
    if (!channel) return;
    const baseName = (w.content.name as string | null) || "file";
    const name = (nameOverride && nameOverride.trim()) ? nameOverride.trim() : baseName;

    const stage = (file: File) => {
        try { UploadHandler.promptToUpload([file], channel, DraftType.ChannelMessage); } catch { /* ignore */ }
        // a new-file session ends once attached (the editor was for that file).
        if (w.isNewFile) { w.isNewFile = false; w.newFileChannel = null; }
    };

    const hasEdits = w.editView.editBuffer != null;

    // 1) Editable text family — attach the EDITED buffer (or the original text if
    //    unedited). Covers code / csv / unknown-as-text (content.code) AND a NEW
    //    file (empty content.code, buffer is the written text).
    if (w.content.code != null && (w.content.type === "code" || w.content.type === "csv" || w.content.type === "unknown")) {
        const text = hasEdits ? editBufferText(w) : w.content.code;
        stage(new File([text], name, { type: "text/plain" }));
        return;
    }
    // 2) Markdown — the raw md source lives in content.code; attach the edited
    //    buffer when edited, else the original source. (A new markdown file also
    //    lands here: content.code = "" + the buffer holds the written markdown.)
    if (w.content.type === "markdown" && w.content.code != null) {
        const text = hasEdits ? editBufferText(w) : w.content.code;
        stage(new File([text], name, { type: "text/markdown" }));
        return;
    }
    // 3) Inline artifact (no url) — the html source is in memory; attach the
    //    edited buffer when edited, else the original html.
    if (w.content.type === "html" && w.content.html != null && !w.content.url) {
        const text = hasEdits ? editBufferText(w) : w.content.html;
        const base = /\.html?$/i.test(name) ? name : name + ".html";
        stage(new File([text], base, { type: "text/html" }));
        return;
    }
    // 4) Has a url (pdf / image / markdown-from-url / artifact-from-url): if the
    //    text family was edited (markdown/artifact have a buffer), attach the
    //    buffer; otherwise attach the source blob from the file's OWN url.
    if (hasEdits && (w.content.type === "markdown" || w.content.type === "html")) {
        const mime = w.content.type === "markdown" ? "text/markdown" : "text/html";
        stage(new File([editBufferText(w)], name, { type: mime }));
        return;
    }
    if (w.content.url) {
        const reqUrl = w.content.url;
        dvFetch(reqUrl)
            .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
            .then(blob => { stage(new File([blob], name, { type: blob.type || "application/octet-stream" })); })
            .catch(() => { /* fetch blocked / failed — silent no-op */ });
    }
}

/** Re-fetch the file currently shown, bypassing both the in-memory content cache
 *  and the HTTP cache. Invoked by the error card's "Try again" button — the active
 *  descriptor (name/url/type) is re-loaded fresh so a transient/expired-link
 *  failure can recover without the user re-clicking the original chip. */
export function retryActiveLoad() {
    const d = activeWindow.activeDescriptor;
    if (!d || !d.url) return;
    load({ name: d.name || "file", url: d.url, type: d.type, noCache: true });
}

/** Clear the loaded content, returning the body to the placeholder. The file is
 *  kept in the cache (so reopening it is still instant); we just detach it. */
export function clearArtifact() {
    snapshotActiveView();
    activeWindow.imgView.fullscreen = false; // the body is going empty — drop the lightbox
    activeWindow.content.name = null;
    activeWindow.content.type = "html";
    resetHtml();
    resetPdf();
    resetCode();
    activeWindow.content.url = null;
    activeWindow.content.loading = false;
    activeWindow.content.error = null;
    activeWindow.activeCacheKey = null;
    activeWindow.activeDescriptor = null;
    saveCurrentChannelState();
    forceRender?.();
}

// ---------------------------------------------------------------------------
// Per-channel memory: save the current channel's panel state; restore another's
// by re-loading its descriptor. Channel switches come from Flux CHANNEL_SELECT
// (see index.tsx) which calls onChannelSelect(newId).
// ---------------------------------------------------------------------------

/** True when the dock has ANY window to show (≥1 exists): a pinned tab, or a
 *  transient with content. This is the new "dock open" predicate for member-list
 *  exclusivity — the dock holds the exclusive right slot whenever it shows a
 *  window. Pinned windows persist across channels, so they keep the dock open;
 *  the lone transient case reduces to today's single-window open flag. */
function dockHasWindows(): boolean {
    if (windows.some(w => w.pinned)) return true;
    const t = transientWindow();
    return !!t && t.state.open;
}

/** Persist the TRANSIENT window's state for the current channel. Pinned windows
 *  are global (NOT per-channel), so they are never written here — only the lone
 *  channel-bound transient slot is remembered per channel. */
function saveCurrentChannelState() {
    if (currentChannelId == null) return;
    const t = transientWindow();
    if (t && t.ownerChannelId === currentChannelId && t.state.open && t.activeDescriptor) {
        channelStates.set(currentChannelId, { open: true, descriptor: t.activeDescriptor });
    } else if (t && t.ownerChannelId === currentChannelId) {
        // transient bound to this channel but empty/closed → remember closed.
        channelStates.set(currentChannelId, { open: t.state.open, descriptor: t.activeDescriptor });
    }
    // (No transient for this channel → leave any prior memory untouched.)
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
 * React to a Discord channel switch. PINNED windows persist (stay in windows[],
 * shown as tabs in every channel). The TRANSIENT window is channel-bound: save it
 * for the leaving channel and drop it from windows[], then restore the entering
 * channel's transient (recreated from its remembered descriptor). The visible set
 * becomes pinned ∪ (this channel's transient). The active window defaults to the
 * channel's transient if present, else the last-active pinned. Width stays global.
 */
export function onChannelSelect(newId: string | null) {
    if (newId === currentChannelId) return;
    // 1. snapshot the active window's live view + save the leaving channel's
    //    transient descriptor.
    snapshotActiveView();
    saveCurrentChannelState();

    // 2. drop the channel-bound transient window — it's recreated per channel.
    //    (Its content cache entry survives, so a return re-shows it instantly.)
    const leaving = transientWindow();
    if (leaving) {
        const i = windows.indexOf(leaving);
        if (i >= 0) windows.splice(i, 1);
    }

    // 3. switch channel.
    currentChannelId = newId;
    if (newId == null) {
        // Going to @me / no real channel: keep the pinned windows in windows[]
        // (they rehydrate when we return to a real channel), but there is no host
        // to show them. Pick a sensible active window if any remain.
        if (!windows.some(w => w.id === activeWindowId)) {
            const fallback = windows[windows.length - 1];
            if (fallback) setActiveWindow(fallback);
        }
        forceRender?.();
        return;
    }

    // 4. restore the entering channel's transient (if it had an open file).
    const mem = channelStates.get(newId);
    if (mem && mem.open && mem.descriptor) {
        const t = makeWindow({ pinned: false, ownerChannelId: newId });
        windows.push(t);
        setActiveWindow(t);
        closeNativeChannelSidebar();
        t.state.open = true;
        lsSet(LS_OPEN, "1");
        restoreDescriptor(mem.descriptor);
    } else if (windows.some(w => w.pinned)) {
        // No transient here, but pinned tabs persist → show the last-active pinned.
        const pinned = windows.filter(w => w.pinned);
        if (!pinned.some(w => w.id === activeWindowId)) setActiveWindow(pinned[pinned.length - 1]);
        closeNativeChannelSidebar();
        activeWindow.state.open = true;
        lsSet(LS_OPEN, "1");
        // a pinned window whose loader was superseded earlier hydrates from cache.
        if (reconcileActiveFromCache()) activeWindow.content.seq += 1;
    } else {
        // Nothing pinned, nothing remembered here → the dock is closed. Recreate
        // an empty closed transient so the single-window invariants hold.
        const t = makeWindow({ pinned: false, ownerChannelId: newId });
        t.state.open = mem ? mem.open : false;
        windows.push(t);
        setActiveWindow(t);
        lsSet(LS_OPEN, t.state.open ? "1" : "0");
    }

    // 5. apply the resulting dock-open state.
    if (dockHasWindows()) {
        ensureHost();
        applyOpenState();
        syncNativeMemberList(true);
        syncNativeProfileSidebar(true);
    } else {
        applyOpenState();
        syncNativeMemberList(false);
        syncNativeProfileSidebar(false);
    }
    forceRender?.();
}

function clampWidth(w: number): number {
    return clampWidthRaw(w);
}

/** Clamp a width chosen by the LEFT-edge resize DRAG. Native clamps the drag so
 *  the chat keeps its minimum (you can't drag a docked panel so wide the chat
 *  collapses) — floating is reserved for a too-narrow WINDOW, not for dragging.
 *  So: on top of the base clampWidth, cap the dragged width to leave the chat
 *  ≥ CHAT_MIN_WIDTH while there's room to dock at all. When the window is already
 *  too narrow to dock (floating mode), there is no resize handle, so this path
 *  isn't reached then; the guard just keeps the value sane if it ever is. */
function clampDockDrag(w: number): number {
    let v = clampWidth(w);
    const inner = findPageInner();
    const avail = availableContentWidth(inner);
    if (avail > 0) {
        const maxDocked = avail - CHAT_MIN_WIDTH;
        if (maxDocked >= DOCK_MIN_WIDTH) v = Math.min(v, maxDocked);
    }
    return v;
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

// The exclusive right slot (DM user-profile sidebar / native thread sidebar) is
// hidden by marking the actual competing nodes while the panel is open. This
// replaces persistent `:has()` CSS selectors, which were visually correct but
// expensive enough to make Discord composer typing miss frames even with the
// panel closed. The server member list is still collapsed through Discord's own
// native toggle path below.

// ---------------------------------------------------------------------------
// Body renderers (content-type router targets)
// ---------------------------------------------------------------------------

/** The HTML/artifact (and markdown) body: the nonce-stamped interactive iframe,
 *  now wrapped so an iframe that never renders surfaces the shared ERROR state
 *  card with a retry affordance instead of a silent blank frame (ART-1).
 *
 *  A sandboxed srcDoc iframe fires `load` once its document parses; a successful
 *  artifact/markdown always fires it within a few frames. We arm a watchdog on
 *  mount: if `load` (or a DOM `error`) hasn't fired by IFRAME_LOAD_TIMEOUT we
 *  treat the artifact as failed-to-render and show the error card. Retry re-loads
 *  the same descriptor fresh (same handler the fetch-error card uses), which
 *  remounts this body (new content.seq) and re-arms the watchdog. The frame is
 *  kept mounted-but-hidden while we wait so a slow-but-fine artifact still shows
 *  the instant it loads (we just clear the timer). */
const IFRAME_LOAD_TIMEOUT = 8000;

// Live registry of mounted MCP-app iframe windows, keyed by app id (= the ui://
// resource uri). The host routes JSON-RPC by matching a frame→host message's
// event.source against these contentWindows. A plain Map literal is a safe
// module-top value (no lazy proxy / TDZ involved).
const mcpFrames = new Map<string, Window>();

// Per-app MCP-Apps session state, keyed by app id. Tracks the handshake (so we
// only push tool-input/result AFTER ui/notifications/initialized) and stashes the
// launching tool's args + result delivered by the bridge's `render` directive so
// they can be flushed once the frame is initialized. Plain Map literal: safe at
// module top (no lazy proxy / side effects).
interface McpSession {
    win: Window | null;
    initialized: boolean;
    toolArguments: any;
    toolResult: any;
}
const mcpSessions = new Map<string, McpSession>();

function HtmlBody() {
    const { useRef, useState, useEffect } = React;
    // "loading" until the iframe fires load; "ok" once it does; "failed" if the
    // watchdog trips or the element errors.
    const [phase, setPhase] = useState("loading" as "loading" | "ok" | "failed");
    const timer = useRef(0 as any);

    useEffect(() => {
        timer.current = setTimeout(() => setPhase(p => (p === "ok" ? p : "failed")), IFRAME_LOAD_TIMEOUT);
        return () => clearTimeout(timer.current);
    }, []);

    if (phase === "failed") {
        // Reuse the shared error card (humanized title + retry/open/download).
        return renderErrorBody("Artifact failed to render");
    }

    const onLoad = () => {
        clearTimeout(timer.current);
        // An artifact whose <iframe> emits the synthetic about:blank load before
        // its srcDoc is swapped in would flip "ok" too early; but with srcDoc the
        // first (and only) load IS the document, so this is the real render.
        setPhase("ok");
    };
    const onError = () => {
        clearTimeout(timer.current);
        setPhase("failed");
    };

    const iframe = React.createElement("iframe", {
        key: "frame",
        className: "dockview-frame",
        srcDoc: activeWindow.content.frameHtml,
        // allow-scripts ONLY (no allow-same-origin): a srcDoc frame with
        // allow-same-origin inherits THIS document's origin, so a script in an
        // untrusted-authored artifact could reach the host DOM and escape the
        // sandbox. Markdown/HTML here is inert and the link bridge is postMessage
        // (origin-agnostic), so a null origin loses nothing. Mirrors McpAppBody.
        sandbox: "allow-scripts",
        onLoad,
        onError,
        // Keep the frame mounted (so it actually loads) but hidden behind the
        // shared loading card until its first load fires.
        style: phase === "loading" ? { visibility: "hidden" } : undefined
    });

    // While waiting for the first load, overlay the SHARED loading card on top of
    // the (hidden) frame so the iframe path uses the same 4-state visuals as
    // every other viewer. A fast artifact clears this within a frame or two.
    if (phase === "loading") {
        return React.createElement(
            "div",
            { className: "dockview-frame-wrap" },
            iframe,
            React.createElement(
                "div",
                { className: "dockview-frame-loading-overlay" },
                React.createElement(LoadingBody, null)
            )
        );
    }
    return iframe;
}

/** Body factory for the html/markdown iframe path (keeps the dispatcher tidy). */
function renderHtmlBody() {
    return React.createElement(HtmlBody, { key: activeWindow.content.seq });
}

/** The MCP-app body: the widget HTML in a HARD-sandboxed iframe (sandbox is
 *  "allow-scripts" ONLY — NO allow-same-origin, so the frame is a null origin and
 *  can't reach the host). On mount we register the frame's contentWindow in the
 *  module `mcpFrames` registry keyed by the current appId so the host can post
 *  JSON-RPC into it and attribute its JSON-RPC posts back (frame→host) by matching
 *  event.source; the cleanup drops the frame + its session. */
function McpAppBody() {
    const { useRef, useEffect } = React;
    const ref = useRef(null as HTMLIFrameElement | null);

    useEffect(() => {
        const appId = activeWindow.mcpView.appId;
        const win = ref.current?.contentWindow;
        if (appId && win) bindMcpFrame(appId, win);
        return () => { if (appId) unbindMcpFrame(appId); };
    }, []);

    const onLoad = () => {
        // re-register on (re)load: the contentWindow may be replaced when srcDoc
        // parses, so keep the registry pointing at the live window.
        const appId = activeWindow.mcpView.appId;
        const win = ref.current?.contentWindow;
        if (appId && win) bindMcpFrame(appId, win);
    };

    return React.createElement("iframe", {
        key: "frame",
        className: "dockview-frame",
        srcDoc: activeWindow.content.frameHtml,
        sandbox: "allow-scripts",
        ref,
        onLoad
    });
}

/** Body factory for the MCP-app iframe path (keeps the dispatcher tidy). */
function renderMcpAppBody() {
    return React.createElement(McpAppBody, { key: activeWindow.content.seq });
}

// ---------------------------------------------------------------------------
// MCP Apps (SEP-1865) HOST surface. The dock is the host; the bridge ws peer is
// the MCP server. iframe ↔ host is raw JSON-RPC 2.0 over postMessage (the message
// IS the JSON-RPC object, no wrapper). We never gate on event.origin (the
// sandbox has no allow-same-origin, so the origin string is "null"); the sender
// is identified by event.source === a registered frame contentWindow.
// ---------------------------------------------------------------------------
const MCP_PROTOCOL_VERSION = "2026-01-26";
const MCP_HOST_INFO = { name: "discord-dockview", version: "1.0.0" };

/** Correlate a ws tools/call proxy with the iframe request that triggered it, so
 *  the bridge's call.res can be replied to the right frame + JSON-RPC id. Lazy
 *  module value; the counter is a plain number (no module-top side effects). */
let mcpCallSeq = 0;
const mcpPendingCalls = new Map<number, { win: Window; rpcId: any }>();

/** Register a live MCP-app frame window + ensure its session record exists. */
function bindMcpFrame(appId: string, win: Window) {
    mcpFrames.set(appId, win);
    const s = mcpSessions.get(appId);
    if (s) s.win = win;
    else mcpSessions.set(appId, { win, initialized: false, toolArguments: undefined, toolResult: undefined });
}

/** Drop a frame + its session (panel switch / unmount). Any pending ws calls
 *  targeting its window are abandoned. */
function unbindMcpFrame(appId: string) {
    const win = mcpFrames.get(appId);
    mcpFrames.delete(appId);
    mcpSessions.delete(appId);
    if (win) {
        for (const [id, p] of mcpPendingCalls) {
            if (p.win === win) mcpPendingCalls.delete(id);
        }
    }
}

/** Reverse-lookup the appId that owns a frame contentWindow (event.source). */
function mcpAppIdForSource(src: any): string | null {
    for (const [id, win] of mcpFrames) {
        if (win === src) return id;
    }
    return null;
}

/** Post a JSON-RPC 2.0 message into a frame (targetOrigin "*"). */
function mcpPostToFrame(win: Window, msg: any) {
    try { win.postMessage(msg, "*"); } catch { /* frame gone */ }
}
function mcpReplyResult(win: Window, id: any, result: any) {
    mcpPostToFrame(win, { jsonrpc: "2.0", id, result });
}
function mcpReplyError(win: Window, id: any, code: number, message: string) {
    mcpPostToFrame(win, { jsonrpc: "2.0", id, error: { code, message } });
}

/** After a frame's ui/notifications/initialized, push the launching tool's args
 *  (ui/notifications/tool-input) and its CallToolResult (ui/notifications/
 *  tool-result). Called once the handshake completes; tool params delivered before
 *  init are stashed on the session and flushed here. */
function mcpFlushTool(s: McpSession) {
    if (!s.win || !s.initialized) return;
    if (s.toolArguments !== undefined) {
        mcpPostToFrame(s.win, {
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: s.toolArguments }
        });
    }
    if (s.toolResult !== undefined) {
        // params IS the CallToolResult.
        mcpPostToFrame(s.win, {
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: s.toolResult
        });
    }
}

/** Route a JSON-RPC 2.0 message that arrived from an MCP-app frame. Requests
 *  (have an id) get a result/error reply; notifications (no id) are handled and
 *  not replied to. Unknown methods get -32601. */
function handleMcpFrameMessage(appId: string, win: Window, d: any) {
    const method: string = d.method;
    const isRequest = d.id != null;
    const params = d.params || {};

    // Notifications (no reply).
    if (!isRequest) {
        if (method === "ui/notifications/initialized") {
            const s = mcpSessions.get(appId);
            if (s) { s.initialized = true; mcpFlushTool(s); }
        } else if (method === "ui/notifications/size-changed") {
            // intentionally ignored (no relayout yet)
        }
        return;
    }

    // Requests (must reply with result/error).
    if (method === "ui/initialize") {
        mcpReplyResult(win, d.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            hostInfo: MCP_HOST_INFO,
            hostCapabilities: { serverTools: {}, openLinks: {} },
            hostContext: { theme: "dark", displayMode: "inline" }
        });
        return;
    }
    if (method === "tools/call") {
        // Proxy to the bridge (MCP server) and reply to this frame when call.res
        // returns. With the bridge gone we report a tool error result.
        if (!mcpSocket || mcpSocket.readyState !== WebSocket.OPEN) {
            mcpReplyResult(win, d.id, { content: [{ type: "text", text: "MCP bridge not connected" }], isError: true });
            return;
        }
        const callId = ++mcpCallSeq;
        mcpPendingCalls.set(callId, { win, rpcId: d.id });
        try {
            mcpSocket.send(JSON.stringify({ type: "call", id: callId, name: params.name, arguments: params.arguments || {} }));
        } catch {
            mcpPendingCalls.delete(callId);
            mcpReplyResult(win, d.id, { content: [{ type: "text", text: "MCP bridge send failed" }], isError: true });
        }
        return;
    }
    if (method === "ui/request-display-mode") {
        // No real relayout yet: echo the requested mode back.
        mcpReplyResult(win, d.id, { mode: params.mode });
        return;
    }
    if (method === "ui/open-link") {
        if (typeof params.url === "string") openExternalLink(params.url);
        mcpReplyResult(win, d.id, {});
        return;
    }
    mcpReplyError(win, d.id, -32601, "method not found");
}

/** pdf.js's own pixel-quantization helpers (ported verbatim from the viewer's
 *  PDFPageView). The official viewer never lets the canvas backing store and the
 *  CSS page box drift out of an EXACT ratio: it picks a small rational
 *  approximation [num/den] of the output scale (= devicePixelRatio), then sizes
 *  the canvas to a multiple of `num` and the page box to a multiple of `den`, so
 *  canvasW / boxW === num/den === dpr to the pixel. Skipping this (sizing the
 *  canvas with a bare floor() and the box with a 1px round) leaves the bitmap
 *  scaled by, e.g., 1.2491 while the text layer's percentage positions assume an
 *  exact dpr — a sub-pixel horizontal drift that accumulates across the page
 *  width and shows up as ragged selection/glyph edges. Reproducing the recipe
 *  pins the text layer to the raster. */
function approximateFraction(x: number): [number, number] {
    if (Math.floor(x) === x) return [x, 1];
    const xinv = 1 / x;
    const limit = 8;
    if (xinv > limit) return [1, limit];
    if (Math.floor(xinv) === xinv) return [1, xinv];
    const x_ = x > 1 ? xinv : x;
    let a = 0, b = 1, c = 1, d = 1;
    for (;;) {
        const p = a + c, q = b + d;
        if (q > limit) break;
        if (x_ <= p / q) { c = p; d = q; } else { a = p; b = q; }
    }
    let result: [number, number];
    if (x_ - a / b < c / d - x_) result = x_ === x ? [a, b] : [b, a];
    else result = x_ === x ? [c, d] : [d, c];
    return result;
}
function floorToDivide(x: number, div: number): number {
    return x - (x % div);
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
    // Scroll anchor for a live resize: the page at the viewport top + the
    // fractional offset INTO that page (0 = its top is at the viewport top, 0.5 =
    // we're halfway down it). A width drag rescales every page box, which moves
    // the whole column under a fixed scrollTop and slides the visible content
    // away; holding this anchor stationary keeps the user looking at the same
    // content throughout the drag (see beginLiveScale / liveScale).
    const liveAnchorRef = useRef(null as { idx: number; frac: number } | null);
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
        // The output scale's rational approximation [num/den]: the canvas is sized
        // to a multiple of `num`, the CSS page box to a multiple of `den`, so the
        // bitmap stretches over the box by exactly dpr (see approximateFraction).
        const [dprNum, dprDen] = approximateFraction(dpr);
        // Pin the box rounding step to `den` so `round(down, --scale-factor * Npx,
        // var(--scale-round-x))` lands the page/text box on the same grid the
        // canvas quantizes to.
        const applyScaleRound = () => {
            host.style.setProperty("--scale-round-x", `${dprDen}px`);
            host.style.setProperty("--scale-round-y", `${dprDen}px`);
        };
        // Size a page canvas's backing store to a whole multiple of `num`. The CSS
        // page box is rounded (in `round(down, ..., var(--scale-round-x))`) to a
        // whole multiple of `den`, so canvasW / boxW === num/den === dpr exactly and
        // the stretched bitmap lands 1:1 on the text-layer grid. pdf.js PDFPageView
        // recipe — the missing piece that pins the text layer to the raster.
        const sizeCanvas = (canvas: HTMLCanvasElement, vpW: number, vpH: number): void => {
            canvas.width = floorToDivide(Math.round(vpW * dpr), dprNum);
            canvas.height = floorToDivide(Math.round(vpH * dpr), dprNum);
        };
        const availWidth = (): number => {
            const sc = scroller();
            return Math.max(1, (sc?.clientWidth || host.clientWidth || activeWindow.state.width) - PDF_SIDE_INSET);
        };

        // Yield a fresh MACROTASK (not rAF). Under main-thread saturation the
        // browser coalesces back-to-back rAF callbacks into the SAME frame, so a
        // plain `await rAF` between two heavy renders does NOT actually split them
        // — measured a settle re-raster as two ~1.1s long tasks despite the rAF
        // yield. A MessageChannel post is a genuine macrotask boundary the browser
        // can't fold into the current task, so each render unit lands in its OWN
        // task and a frame can paint + input can run in between. (setTimeout(0) is
        // clamped to ~4ms after nesting; MessageChannel posts immediately.) Used
        // both between queued pages AND inside rasterPage (canvas vs text layer).
        const mc = new MessageChannel();
        let yieldResolvers: Array<() => void> = [];
        mc.port1.onmessage = () => { const rs = yieldResolvers; yieldResolvers = []; rs.forEach(r => r()); };
        const yieldTask = () => new Promise<void>(r => { yieldResolvers.push(r); mc.port2.postMessage(0); });

        // Build a page's pdf.js text layer into `target`, DETACHED from the live
        // column, then move the finished spans across in one cheap append.
        //
        // This is the ISOLATION fix. pdf.js's TextLayer.render() measures every
        // glyph run (ctx.measureText) and interleaves those reads with the span
        // DOM it appends to `container`. When `container` is a live .textLayer
        // sitting INSIDE our 100+ page column — whose box widths/heights are CSS
        // `round(down, var(--scale-factor) * Npx, ...)` expressions — each
        // measure forces a synchronous style+layout recalc of the WHOLE round()
        // column. Profiling a heavy 120-page doc pinned 92% of main-thread time
        // (~2.2s) in measureText, and a single page's in-column text build cost
        // ~1.5s of UNINTERRUPTIBLE main thread — freezing the Discord host
        // (cursor/typing) one page at a time. Building into a container that is
        // NOT in the document (no --scale-factor / round() ancestor to recalc)
        // makes the very same build ~1ms; we then move the children into the
        // real textDiv (instant; positions resolve from the percentage + CSS-var
        // span model exactly as before — same spans, same --scale-x, same
        // alignment, find/selection unchanged). 1531ms -> ~1ms, measured.
        const buildTextLayer = async (target: HTMLElement, page: any, viewport: any): Promise<boolean> => {
            const textContent = await page.getTextContent();
            const off = document.createElement("div");
            off.className = "textLayer";
            // mirror the scale chain so pdf.js sizes spans identically; the div is
            // never inserted, so this var only seeds pdf.js's own math.
            off.style.setProperty("--total-scale-factor", "var(--scale-factor)");
            const tl = new (pdfjsLib as any).TextLayer({ textContentSource: textContent, container: off, viewport });
            await tl.render();
            target.replaceChildren(...off.childNodes);
            return true;
        };

        // Raster ONE page's canvas (+ build its text layer) at the current
        // document scale, if it isn't already current. Idempotent + reentrancy-
        // guarded so the IntersectionObserver and jumps can call it freely.
        const rasterPage = async (idx: number) => {
            // NEVER raster during a live resize drag. The drag only re-points
            // --scale-factor (liveScale), which reflows the column and so trips the
            // IntersectionObserver for every page that slides under the viewport;
            // rastering here would (a) fight the cheap CSS-scale preview and (b)
            // pile up dozens of CPU-bound pdf.js renders into one multi-second
            // main-thread freeze mid-drag (measured ~5.8s long tasks on a heavy
            // 41-page doc). The crisp re-raster is deferred to drag-end settle.
            if (resizeDragging) return;
            const docToken = activeWindow.content.pdf.renderToken;
            const p = pagesRef.current[idx];
            if (!p) return;
            const docScale = renderScaleRef.current;
            // already crisp at this scale (and text built) — nothing to do.
            if (p.rasterScale === docScale && p.textScale === docScale) return;
            if (p.rendering) return;
            p.rendering = true;
            try {
                const doc = activeWindow.content.pdf.doc;
                if (!doc) return;
                if (!p.page) {
                    try { p.page = await doc.getPage(p.n); } catch { return; }
                    if (docToken !== activeWindow.content.pdf.renderToken) return;
                }
                const viewport = p.page.getViewport({ scale: docScale });
                // canvas raster (crisp at docScale × dpr). Quantize the backing
                // store to a multiple of `num` so canvasW / boxW === dpr exactly
                // (the box is rounded to a multiple of `den` in CSS) — otherwise a
                // bare floor() drifts the bitmap off the text-layer grid.
                if (p.rasterScale !== docScale) {
                    sizeCanvas(p.canvas, viewport.width, viewport.height);
                    const ctx = p.canvas.getContext("2d");
                    if (!ctx) return;
                    try {
                        await p.page.render({
                            canvasContext: ctx,
                            viewport,
                            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
                        }).promise;
                    } catch { return; } // render cancelled
                    if (docToken !== activeWindow.content.pdf.renderToken) return;
                    p.rasterScale = docScale;
                    // Let the just-painted crisp canvas COMMIT (and the thread
                    // breathe) before the text layer — which for a text-dense page
                    // is the heavier half. Without this break the canvas render and
                    // the hundreds-of-spans text build run as one ~280ms task per
                    // page; split, the page visibly sharpens a frame sooner and
                    // input stays responsive between the two halves.
                    await yieldTask();
                    if (docToken !== activeWindow.content.pdf.renderToken) return;
                    if (resizeDragging) return; // a new drag started mid-raster
                }
                // text layer (selectable). rebuilt on scale change so span boxes
                // match the new geometry. best-effort — never throws upward.
                if (p.textScale !== docScale) {
                    try {
                        // Build DETACHED then attach (see buildTextLayer) — an
                        // in-column build of a dense page is a ~1.5s host-freezing
                        // task; detached it is ~1ms.
                        await buildTextLayer(p.textDiv, p.page, viewport);
                        if (docToken !== activeWindow.content.pdf.renderToken) return;
                        p.textScale = docScale;
                        // a live find must light up matches on a freshly-built page
                        if (activeWindow.pdfView.findOpen && activeWindow.pdfView.findQuery) reapplyFindOnPage(idx);
                    } catch { /* text layer optional */ }
                }
            } finally {
                p.rendering = false;
            }
        };

        // --- frame-yielding raster queue ------------------------------------
        // Rasters are CPU-bound (pdf.js paints the page on the main thread). Firing
        // many `rasterPage` calls at once serializes them into one long blocking
        // run — e.g. on a resize-settle the IntersectionObserver (150% rootMargin)
        // wants to raster every short page that now fits the band, which measured
        // ~13s of frozen main thread for a heavy 41-page doc. Instead we funnel all
        // raster requests through a queue that renders ONE page, then yields a frame
        // before the next, so the work spreads across frames and never blocks
        // scrolling/typing. The currently-viewed pages are enqueued at the FRONT so
        // they sharpen first; distant pages trickle in behind them. The pump pauses
        // entirely while a resize drag is active (rasterPage also guards this).
        const rasterQueue: number[] = [];
        let rasterPumping = false;
        const pumpRaster = async () => {
            if (rasterPumping) return;
            rasterPumping = true;
            const myToken = activeWindow.content.pdf.renderToken;
            try {
                while (rasterQueue.length) {
                    if (resizeDragging) break; // resume after the drag (endLiveScale re-pumps)
                    if (myToken !== activeWindow.content.pdf.renderToken) { rasterQueue.length = 0; break; } // doc swapped
                    const idx = rasterQueue.shift()!;
                    await rasterPage(idx);
                    // yield a macrotask so one heavy page can't monopolize the thread
                    // and the next page's render starts a brand-new task (paintable
                    // gap in between) — see yieldTask above for why not rAF.
                    await yieldTask();
                }
            } finally {
                rasterPumping = false;
            }
        };
        // Enqueue a page for raster (front = priority for visible pages). Skips
        // pages already crisp at the current scale and duplicates already queued.
        const enqueueRaster = (idx: number, front = false) => {
            if (idx < 0 || idx >= pagesRef.current.length) return;
            const p = pagesRef.current[idx];
            if (!p) return;
            const docScale = renderScaleRef.current;
            if (p.rasterScale === docScale && p.textScale === docScale) return; // already crisp
            const at = rasterQueue.indexOf(idx);
            if (at !== -1) { if (!front) return; rasterQueue.splice(at, 1); } // re-prioritize
            if (front) rasterQueue.unshift(idx); else rasterQueue.push(idx);
            void pumpRaster();
        };

        // Raster the page band around `centerPage` (1-based): the page + a few
        // neighbours each way, so scrolling never shows a blank page. Goes through
        // the frame-yielding queue (front-loaded = these are the priority pages).
        // Enqueue OUTWARD-then-center so the dominant on-screen page ends up at the
        // HEAD of the queue (each front enqueue unshifts, so the last one wins) —
        // after a resize-settle that page sharpens first, neighbours trickle in
        // behind it one macrotask at a time instead of one big blocking burst.
        const RASTER_NEIGHBOURS = 2;
        const rasterAround = (centerPage: number) => {
            const c = centerPage - 1;
            const lo = Math.max(0, c - RASTER_NEIGHBOURS);
            const hi = Math.min(pagesRef.current.length - 1, c + RASTER_NEIGHBOURS);
            // furthest neighbours first, center last => center at queue head.
            for (let d = Math.max(c - lo, hi - c); d >= 1; d--) {
                if (c - d >= lo) enqueueRaster(c - d, true);
                if (c + d <= hi) enqueueRaster(c + d, true);
            }
            enqueueRaster(c, true);
        };

        // Which page indices actually overlap the viewport right now (1+ pages).
        const visiblePageIdxs = (): number[] => {
            const sc = scroller();
            const pages = pagesRef.current;
            if (!sc || !pages.length) return [];
            const top = sc.scrollTop, bot = top + sc.clientHeight;
            const out: number[] = [];
            for (let i = 0; i < pages.length; i++) {
                const wt = pages[i].wrap.offsetTop;
                const wb = wt + pages[i].wrap.offsetHeight;
                if (wb > top && wt < bot) out.push(i);
            }
            return out;
        };
        // Settle/zoom re-raster: sharpen ONLY the pages on screen FIRST (front,
        // 1–2 pages = 1–2 tasks, so the view re-sharpens fast), then enqueue the
        // ±RASTER_NEIGHBOURS scroll-ahead band at the BACK so it trickles in after
        // the visible pages without competing with them. Each text-dense page costs
        // pdf.js ~0.9s to re-raster, so cutting the immediate set from the 5-page
        // band down to the visible pages is what turns a multi-second choppy
        // re-sharpen into a near-immediate one. Falls back to the band if nothing
        // measures visible (e.g. zero-height scroller mid-transition).
        const rasterViewportFirst = () => {
            const vis = visiblePageIdxs();
            if (!vis.length) { rasterAround(activeWindow.pdfView.page || 1); return; }
            for (let k = vis.length - 1; k >= 0; k--) enqueueRaster(vis[k], true); // first visible at head
            const lo = Math.max(0, vis[0] - RASTER_NEIGHBOURS);
            const hi = Math.min(pagesRef.current.length - 1, vis[vis.length - 1] + RASTER_NEIGHBOURS);
            for (let i = lo; i <= hi; i++) if (!vis.includes(i)) enqueueRaster(i, false); // neighbours trickle behind
        };

        // Build the page COLUMN: all wrap boxes sized to the uniform doc scale,
        // each holding an (initially blank) canvas + empty text layer. NO raster
        // here — that's lazy. This is the cheap pass that makes the first page
        // appear almost immediately regardless of page count.
        const buildLayout = async () => {
            const doc = activeWindow.content.pdf.doc;
            if (!doc) return;
            const myPass = ++passRef.current;
            const docToken = activeWindow.content.pdf.renderToken;

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
                if (myPass !== passRef.current || docToken !== activeWindow.content.pdf.renderToken) return;
                let pg: any;
                try { pg = await doc.getPage(n); } catch { return; }
                const vp = pg.getViewport({ scale: 1 });
                if (vp.width > refW) { refW = vp.width; refH = vp.height; }
            }
            if (!refW) return;
            const fitScale = activeWindow.pdfView.fit === "page"
                ? Math.min(availW / refW, availH / refH)
                : availW / refW;
            const docScale = fitScale * activeWindow.pdfView.zoom;
            renderScaleRef.current = docScale;
            applyScaleRound();
            host.style.setProperty("--scale-factor", String(docScale));

            matchesRef.current = [];
            ioRef.current?.disconnect();

            const built: typeof pagesRef.current = [];
            const frag = document.createDocumentFragment();
            for (let n = 1; n <= doc.numPages; n++) {
                if (myPass !== passRef.current || docToken !== activeWindow.content.pdf.renderToken) return;
                let page: any;
                try { page = await doc.getPage(n); } catch { return; }
                const base = page.getViewport({ scale: 1 });

                const wrap = document.createElement("div");
                wrap.className = "dockview-pdf-page-wrap";
                wrap.style.width = `round(down, var(--scale-factor) * ${base.width}px, var(--scale-round-x, 1px))`;
                wrap.style.height = `round(down, var(--scale-factor) * ${base.height}px, var(--scale-round-y, 1px))`;
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
            if (myPass !== passRef.current || docToken !== activeWindow.content.pdf.renderToken) return;
            host.replaceChildren(frag);
            pagesRef.current = built;

            // Observe every page; raster those near the viewport. A generous
            // rootMargin pre-rasters one screenful ahead/behind so scrolling
            // stays smooth. The scroller is the root.
            const io = new IntersectionObserver((entries) => {
                // While a resize drag is live the column reflows constantly, firing
                // this for page after page; queuing them would do nothing (rasterPage
                // bails on resizeDragging) and just churns. The drag-end settle
                // re-rasters the visible band, and normal scrolling re-fires this.
                if (resizeDragging) return;
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
            } else if (activeWindow.pdfView.page > 1) {
                const p = built[Math.min(built.length, activeWindow.pdfView.page) - 1];
                if (sc && p) sc.scrollTop = Math.max(0, p.wrap.offsetTop - 8);
            }
            updateCurrentPage();
            rasterAround(activeWindow.pdfView.page || 1);
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
            const docToken = activeWindow.content.pdf.renderToken;
            const sc = scroller();
            const availW = availWidth();
            const availH = Math.max(1, (sc?.clientHeight || 600) - PDF_SIDE_INSET);
            // widest page from cached base geometry (no pdf.js round-trip).
            let refW = 0, refH = 0;
            for (const p of pages) if (p.baseW > refW) { refW = p.baseW; refH = p.baseH; }
            if (!refW) return false;
            const fitScale = activeWindow.pdfView.fit === "page" ? Math.min(availW / refW, availH / refH) : availW / refW;
            const docScale = fitScale * activeWindow.pdfView.zoom;
            const prevScale = renderScaleRef.current || docScale;
            const ratio = docScale / prevScale;
            // anchor: keep the user looking at the same content across the rescale.
            // Prefer the live-drag anchor (page + fraction-into-page captured at
            // drag start and held through the whole drag) so a width settle lands
            // exactly where the live preview ended; otherwise fall back to the
            // current page + its in-page pixel offset (zoom / window resize).
            const live = liveAnchorRef.current;
            const anchorIdx = live
                ? Math.min(pages.length - 1, Math.max(0, live.idx))
                : Math.max(0, (activeWindow.pdfView.page || 1) - 1);
            const anchor = pages[anchorIdx];
            const beforeTop = anchor ? anchor.wrap.offsetTop : 0;
            const scrollBefore = sc ? sc.scrollTop : 0;
            const delta = scrollBefore - beforeTop; // px into the anchor page

            renderScaleRef.current = docScale;
            applyScaleRound();
            host.style.setProperty("--scale-factor", String(docScale));
            lastWidthRef.current = host.clientWidth;
            // invalidate rasters (boxes already resized via the variable).
            for (const p of pages) { p.rasterScale = 0; p.textScale = 0; }

            // re-anchor scroll to the same content (the box offsetTop moved as the
            // boxes resized). With a live anchor, derive the in-page offset from the
            // captured FRACTION × the page's NEW height (robust to the constant 8px
            // gaps not scaling); otherwise scale the recorded pixel delta by the
            // zoom ratio.
            if (sc && anchor) {
                const inPage = live
                    ? live.frac * anchor.wrap.offsetHeight
                    : Math.round(delta * ratio);
                sc.scrollTop = Math.max(0, anchor.wrap.offsetTop + inPage);
            }
            // re-raster: visible pages first (fast re-sharpen), neighbours trickle.
            rasterViewportFirst();
            // if a find is active, re-light it (text layers were invalidated).
            if (activeWindow.pdfView.findOpen && activeWindow.pdfView.findQuery) runFind(activeWindow.pdfView.findQuery, false);
            if (docToken !== activeWindow.content.pdf.renderToken) return true;
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
            if (best !== activeWindow.pdfView.page) {
                activeWindow.pdfView.page = best;
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
            const activeIdx = activeWindow.pdfView.findActive - 1;
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
            const docToken = activeWindow.content.pdf.renderToken;
            const p = pagesRef.current[idx];
            if (!p || p.textScale === renderScaleRef.current) return;
            const doc = activeWindow.content.pdf.doc;
            if (!doc) return;
            if (!p.page) {
                try { p.page = await doc.getPage(p.n); } catch { return; }
                if (docToken !== activeWindow.content.pdf.renderToken) return;
            }
            try {
                const viewport = p.page.getViewport({ scale: renderScaleRef.current });
                // detached build (see buildTextLayer) — keeps a whole-document
                // find from freezing the host one page at a time.
                await buildTextLayer(p.textDiv, p.page, viewport);
                if (docToken !== activeWindow.content.pdf.renderToken) return;
                p.textScale = renderScaleRef.current;
            } catch { /* optional */ }
        };
        // Build a page's FLAT text string from its rendered text-layer DOM, plus a
        // per-character map back to the (textNode, offset) it came from. pdf.js lays
        // a page out as a sequence of spans (one glyph run each, holding a single
        // text node) interleaved with <br> elements at end-of-line items. The
        // browser serialises that exact DOM when the user copies a selection — span
        // text concatenated, each <br> a newline — so reproducing it here makes find
        // search the SAME string the user reads/copies. Crucially this lets a query
        // straddle a span boundary (pdf.js splits one visual word into separate runs
        // on kerning / style changes): "bound"+"ary" are two spans but one string
        // "boundary", so it now matches where the old per-span scan missed it. Each
        // <br> contributes a "\n" with a null node (a separator a newline-free query
        // never lands on), keeping cross-line text from fusing into a false match.
        const buildPageText = (textDiv: HTMLElement): { text: string; nodes: (Text | null)[]; offs: number[]; } => {
            let text = "";
            const nodes: (Text | null)[] = [];
            const offs: number[] = [];
            const walk = (el: Node) => {
                for (const child of Array.from(el.childNodes)) {
                    if (child.nodeName === "BR") {
                        text += "\n";
                        nodes.push(null);
                        offs.push(0);
                    } else if (child.nodeType === Node.TEXT_NODE) {
                        const t = child as Text;
                        const s = t.data;
                        for (let i = 0; i < s.length; i++) {
                            text += s[i];
                            nodes.push(t);
                            offs.push(i);
                        }
                    } else if (child.nodeType === Node.ELEMENT_NODE) {
                        // spans (incl. nested markedContent spans) — recurse so the
                        // string follows reading order across the whole layer.
                        walk(child);
                    }
                }
            };
            walk(textDiv);
            return { text, nodes, offs };
        };
        // Find every occurrence of `q` on ONE page and return its Ranges in reading
        // order. Matches against the whole-page string (see buildPageText) so hits
        // are found even when they span span boundaries; the start/end character
        // offsets are mapped back to their text nodes to build a Range that can
        // cover two (or more) spans. The CSS Custom Highlight API paints such a
        // multi-node Range without touching the span DOM. Non-overlapping, like
        // browser find; Aa honoured via case-folding both sides.
        const collectPageMatches = (idx: number, q: string): Range[] => {
            const p = pagesRef.current[idx];
            if (!p) return [];
            const { text, nodes, offs } = buildPageText(p.textDiv);
            if (!text) return [];
            const cmp = activeWindow.pdfView.findCase ? q : q.toLowerCase();
            const hay = activeWindow.pdfView.findCase ? text : text.toLowerCase();
            const out: Range[] = [];
            let from = 0;
            for (;;) {
                const at = hay.indexOf(cmp, from);
                if (at < 0) break;
                from = at + cmp.length; // advance first so a bad map still progresses
                const startNode = nodes[at];
                const endNode = nodes[at + cmp.length - 1];
                // skip a hit that begins/ends on a <br> separator (only possible when
                // the query itself contains a newline landing on the boundary).
                if (!startNode || !endNode) continue;
                const range = document.createRange();
                range.setStart(startNode, offs[at]);
                range.setEnd(endNode, offs[at + cmp.length - 1] + 1);
                out.push(range);
            }
            return out;
        };
        // Re-locate matches for a SINGLE page whose text layer was just (re)built —
        // both for late-rastered pages during a live find and after a zoom/resize
        // rebuild invalidated the old Ranges. Replaces that page's slice in the
        // ordered match list, preserving the active occurrence's identity when
        // possible so next/prev don't jump around under the user.
        const reapplyFindOnPage = (idx: number) => {
            const q = activeWindow.pdfView.findQuery.trim();
            if (!q || !hlSupported) return;
            const page = idx + 1;
            // remember which match was active (so we can re-aim at the same page)
            const activeWasOnPage = matchesRef.current[activeWindow.pdfView.findActive - 1]?.page === page;
            const fresh = collectPageMatches(idx, q).map(range => ({ page, range }));
            // rebuild the ordered list: drop this page's old entries, splice fresh
            // ones in at the page-ordered position. Matches are kept in page order;
            // within a page collectPageMatches already returns reading order.
            const before = matchesRef.current.filter(m => m.page < page);
            const after = matchesRef.current.filter(m => m.page > page);
            matchesRef.current = [...before, ...fresh, ...after];
            activeWindow.pdfView.findMatches = matchesRef.current.length;
            // keep a sane active index: if it was on this page, re-point at this
            // page's first fresh hit; otherwise leave it (clamped) where it was.
            if (activeWindow.pdfView.findMatches === 0) activeWindow.pdfView.findActive = 0;
            else if (activeWasOnPage && fresh.length) activeWindow.pdfView.findActive = before.length + 1;
            else if (activeWindow.pdfView.findActive === 0) activeWindow.pdfView.findActive = 1;
            else if (activeWindow.pdfView.findActive > activeWindow.pdfView.findMatches) activeWindow.pdfView.findActive = activeWindow.pdfView.findMatches;
            repaintHighlights();
            forceRender?.();
        };
        const runFind = async (query: string, jump: boolean) => {
            clearHighlights();
            activeWindow.pdfView.findMatches = 0;
            activeWindow.pdfView.findActive = 0;
            const q = query.trim();
            if (!q) { forceRender?.(); return; }
            if (!hlSupported) { forceRender?.(); return; }
            const myToken = activeWindow.content.pdf.renderToken;
            const pages = pagesRef.current;
            // Build text layers for every page (raster-free) so find sees the
            // WHOLE document, not just the pages that happen to be rastered. Each
            // build is a ~main-thread block; yield a macrotask between pages so a
            // big doc (or a re-find after a resize invalidated every text layer)
            // re-lights PROGRESSIVELY instead of freezing the UI in one run.
            for (let i = 0; i < pages.length; i++) {
                if (i > 0) await yieldTask();
                await ensureTextLayer(i);
                if (myToken !== activeWindow.content.pdf.renderToken || activeWindow.pdfView.findQuery.trim() !== q) return;
            }
            const all: typeof matchesRef.current = [];
            for (let i = 0; i < pages.length; i++) {
                for (const range of collectPageMatches(i, q)) all.push({ page: i + 1, range });
            }
            matchesRef.current = all;
            activeWindow.pdfView.findMatches = all.length;
            if (all.length > 0) {
                activeWindow.pdfView.findActive = 1;
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
            activeWindow.pdfView.findActive = idx + 1;
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
            activeWindow.pdfView.page = idx + 1;
            forceRender?.();
        };

        // --- drag-to-pan -----------------------------------------------------
        // In "pan" mode a mouse drag over the PDF body scrolls the body scroller
        // on BOTH axes (so a zoomed page can be moved left/right + up/down), and
        // text selection is suppressed. In "text" mode (default) the drag is left
        // to the pdf.js text layer, which selects text exactly as before. The mode
        // is purely a class on the container (cursor + textLayer pointer-events/
        // user-select, see .dockview-pdf-pan in style.css) plus this mousedown
        // handler — it touches NOTHING about raster / text-layer build / find /
        // resize anchoring. It only manipulates scrollLeft/scrollTop, the same
        // numbers the scroll listener already reads.
        const syncPanClass = () => {
            host.classList.toggle("dockview-pdf-pan", activeWindow.pdfView.dragMode === "pan");
            if (activeWindow.pdfView.dragMode !== "pan") host.classList.remove("dockview-pdf-panning");
        };
        // active drag bookkeeping (null = not panning). Captured at mousedown.
        let panState: { x: number; y: number; left: number; top: number } | null = null;
        const onPanMove = (e: MouseEvent) => {
            if (!panState) return;
            const sc = scroller();
            if (!sc) return;
            // drag delta -> opposite scroll delta (grab the page and move it).
            sc.scrollLeft = panState.left - (e.clientX - panState.x);
            sc.scrollTop = panState.top - (e.clientY - panState.y);
            e.preventDefault();
        };
        const endPan = () => {
            if (!panState) return;
            panState = null;
            host.classList.remove("dockview-pdf-panning");
            window.removeEventListener("mousemove", onPanMove, true);
            window.removeEventListener("mouseup", endPan, true);
        };
        const onPanDown = (e: MouseEvent) => {
            // only the primary button, and only in pan mode.
            if (activeWindow.pdfView.dragMode !== "pan" || e.button !== 0) return;
            const sc = scroller();
            if (!sc) return;
            panState = { x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop };
            host.classList.add("dockview-pdf-panning"); // grabbing cursor
            // suppress the would-be text selection / focus drag.
            e.preventDefault();
            window.addEventListener("mousemove", onPanMove, true);
            window.addEventListener("mouseup", endPan, true);
        };
        host.addEventListener("mousedown", onPanDown);
        syncPanClass();

        // Expose controls to the toolbar + keyboard while this PDF is mounted.
        const ctrls: PdfControls = {
            goToPage: (n: number) => scrollToPage(n),
            prevPage: () => scrollToPage(activeWindow.pdfView.page - 1),
            nextPage: () => scrollToPage(activeWindow.pdfView.page + 1),
            zoomIn: () => { activeWindow.pdfView.zoom = Math.min(PDF_MAX_ZOOM, activeWindow.pdfView.zoom * 1.25); scheduleRerender(); forceRender?.(); },
            zoomOut: () => { activeWindow.pdfView.zoom = Math.max(PDF_MIN_ZOOM, activeWindow.pdfView.zoom / 1.25); scheduleRerender(); forceRender?.(); },
            setFit: (f: PdfFit) => { if (activeWindow.pdfView.fit !== f) { activeWindow.pdfView.fit = f; activeWindow.pdfView.zoom = 1; scheduleRerender(); forceRender?.(); } },
            fitWidth: () => { if (activeWindow.pdfView.fit !== "width" || activeWindow.pdfView.zoom !== 1) { activeWindow.pdfView.fit = "width"; activeWindow.pdfView.zoom = 1; scheduleRerender(); forceRender?.(); } },
            toggleDragMode: () => { activeWindow.pdfView.dragMode = activeWindow.pdfView.dragMode === "pan" ? "text" : "pan"; endPan(); syncPanClass(); forceRender?.(); },
            toggleFind: () => { activeWindow.pdfView.findOpen = !activeWindow.pdfView.findOpen; if (!activeWindow.pdfView.findOpen) { clearHighlights(); activeWindow.pdfView.findMatches = 0; activeWindow.pdfView.findActive = 0; activeWindow.pdfView.findQuery = ""; } forceRender?.(); },
            toggleFindCase: () => { activeWindow.pdfView.findCase = !activeWindow.pdfView.findCase; runFind(activeWindow.pdfView.findQuery, false); forceRender?.(); },
            setFindQuery: (qq: string) => { activeWindow.pdfView.findQuery = qq; runFind(qq, true); },
            findNext: () => { if (!activeWindow.pdfView.findMatches) return; focusMatch(activeWindow.pdfView.findActive % activeWindow.pdfView.findMatches); },
            findPrev: () => { if (!activeWindow.pdfView.findMatches) return; focusMatch((activeWindow.pdfView.findActive - 2 + activeWindow.pdfView.findMatches) % activeWindow.pdfView.findMatches); },
            // Capture the scroll anchor at the START of a width drag, BEFORE any
            // scale change. The page boxes are sized off --scale-factor; the 8px
            // inter-page gaps are NOT (they're a constant flex gap), so a whole-
            // document scroll fraction would drift as the scaled-content vs fixed-
            // gap ratio changes. A PER-PAGE anchor (which page sits at the viewport
            // top + how far into it) survives that exactly: the page box scales,
            // the offset-into-page scales with it, and we re-derive scrollTop from
            // the page's NEW offsetTop each frame (gaps above are re-summed by the
            // layout). So we record the page at the viewport top + the fraction we
            // are into it.
            beginLiveScale: () => {
                liveAnchorRef.current = null;
                const sc = scroller();
                const pages = pagesRef.current;
                if (!sc || !pages.length) return;
                const top = sc.scrollTop;
                // find the page whose box spans the viewport top (or the last page
                // above it — e.g. when the top sits in an inter-page gap).
                let idx = 0;
                for (let i = 0; i < pages.length; i++) {
                    const t = pages[i].wrap.offsetTop;
                    if (t <= top) idx = i; else break;
                }
                const wrap = pages[idx].wrap;
                const h = wrap.offsetHeight || 1;
                // fraction into the page (can exceed 1 if top is in the gap below
                // the page; clamp so we never anchor past the page box).
                const frac = Math.min(1, Math.max(0, (top - wrap.offsetTop) / h));
                liveAnchorRef.current = { idx, frac };
            },
            // Live resize (the pdf.js "CSS zoom first, redraw after" pattern):
            // re-point the container's --scale-factor to renderScale × ratio. The
            // page boxes (sized in that variable) reflow as a connected column and
            // every canvas bitmap stretches with its box — instant, GPU-composited,
            // gaps stay 8px, pages never detach. In "width" fit the render scale is
            // proportional to width so this faithfully previews the new raster; in
            // "page" fit the height also bounds the scale, so a width ratio would
            // over-scale — we hold scale there (drag-end re-raster corrects).
            //
            // After the boxes take their new size we re-anchor scrollTop to the
            // captured page+fraction so the content the user is looking at stays
            // put — without this, scrollTop stays a fixed pixel while the column
            // grows/shrinks above it and the visible page violently shifts. One
            // forced reflow per frame (read the anchor page's new offsetTop/height,
            // write scrollTop once) — cheap, no per-item loop.
            liveScale: (ratio: number) => {
                if (!Number.isFinite(ratio) || ratio <= 0) return;
                const host = containerRef.current;
                if (!host) return;
                const r = activeWindow.pdfView.fit === "page" ? 1 : ratio;
                host.style.setProperty("--scale-factor", String(renderScaleRef.current * r));
                // hold the anchored content stationary in the viewport.
                const anchor = liveAnchorRef.current;
                const sc = scroller();
                const pages = pagesRef.current;
                if (sc && anchor && pages[anchor.idx]) {
                    const wrap = pages[anchor.idx].wrap;
                    // reading offsetTop/offsetHeight here flushes the pending
                    // --scale-factor layout, so we get the NEW (rescaled) box.
                    sc.scrollTop = Math.max(0, wrap.offsetTop + anchor.frac * wrap.offsetHeight);
                }
            },
            endLiveScale: () => {
                // Drag settled: re-raster crisply at the final width. renderAll ->
                // rescale resets --scale-factor to the new true docScale and
                // invalidates every page's bitmap, then re-rasters through the
                // frame-yielding queue VISIBLE-FIRST — so the pages on screen
                // sharpen within a frame or two while distant pages trickle in
                // behind them (no 13s all-pages freeze, no snap-back gap). Caller
                // has already cleared resizeDragging, so the queue pump runs.
                // rescale() re-derives scrollTop from liveAnchorRef (the same
                // page+fraction we held throughout the drag) so the crisp re-raster
                // lands on exactly the content the preview was showing — no snap.
                if (activeWindow.content.pdf.doc) renderAll();
                liveAnchorRef.current = null;
            }
        };
        pdfControls = ctrls;

        // zoom re-render is debounced (DPR-crisp re-raster of every page)
        let zoomDebounce: any = null;
        const scheduleRerender = () => {
            clearTimeout(zoomDebounce);
            zoomDebounce = setTimeout(() => { if (activeWindow.content.pdf.doc) renderAll(); }, 120);
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
                if (!activeWindow.content.pdf.doc) return;
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
            host.removeEventListener("mousedown", onPanDown);
            endPan(); // drop any window-level pan listeners + grabbing class
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
    }, [activeWindow.content.pdf.renderToken, activeWindow.content.seq]);

    return React.createElement("div", {
        key: activeWindow.content.seq,
        ref: containerRef,
        className: "dockview-pdf-container",
        // Focusable so a click into the PDF body gives the panel keyboard focus;
        // page-nav / zoom keys are gated on that focus (never on hover).
        tabIndex: 0
    });
}

// The FIND box is a small FLOATING browser-style Ctrl+F panel (grammar rule 7):
// a compact dark box anchored TOP-RIGHT over the content — input + match counter
// + Aa + prev/next + ✕. It floats over the body (does NOT consume a header row,
// the way the old in-header find dropdown did); the row-2 find ICON toggles it.
// Discord may intercept the global Ctrl+F, so this is our own UI. It is a
// GENERIC, reusable component: the PDF viewer and EVERY CodeMirror surface (code,
// CSV-raw, markdown/artifact edit) drive the SAME box. All behaviour (query,
// counter, case, next/prev, close) is supplied through a `FindBarModel`, so the
// box itself knows nothing about pdf.js vs CM — only how to lay itself out. Same
// fields/keys/handlers as before; only the chrome (floating top-right) changed.
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
    // Lay the floating box out as a browser Ctrl+F panel: a text input that holds
    // the query + the live "cur/total" counter pinned at its right edge, then a
    // trailing control cluster (Aa case toggle · prev · next) and a divided-off ✕
    // close. Grouping the counter INSIDE the input (a `.dockview-find-field`
    // wrapper) is the browser/VS Code look — the number sits in the field, not as a
    // separate column.
    return React.createElement(
        "div",
        { className: "dockview-find" },
        React.createElement(
            "div",
            { className: "dockview-find-field" },
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
            React.createElement("span", { className: "dockview-find-count" }, counter)
        ),
        React.createElement(
            "div",
            { className: "dockview-find-actions" },
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
            // a hairline divides the match-nav cluster from the close, like a browser
            React.createElement("span", { key: "find-sep", className: "dockview-find-sep" }),
            toolBtn("find-close", STRINGS.find.close,
                "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z",
                () => model.close())
        )
    );
}

/** The PDF find bar = the generic FindBar wired to the PDF view-state. */
function PdfFindBar() {
    return React.createElement(FindBar, {
        model: {
            query: activeWindow.pdfView.findQuery,
            matches: activeWindow.pdfView.findMatches,
            active: activeWindow.pdfView.findActive,
            caseSensitive: activeWindow.pdfView.findCase,
            placeholder: STRINGS.find.placeholder,
            setQuery: (q: string) => pdfControls?.setFindQuery(q),
            next: () => pdfControls?.findNext(),
            prev: () => pdfControls?.findPrev(),
            toggleCase: () => pdfControls?.toggleFindCase(),
            close: () => pdfControls?.toggleFind()
        }
    });
}

/** Shared zoom/pan interaction for an image surface. Both the inline ImageBody
 *  and the fullscreen lightbox call this with their own wrap/img refs; the actual
 *  view-state (scale/tx/ty/natW/natH) is module-scoped on `imgView`, so whichever
 *  surface is mounted drives the SAME numbers — which is exactly why the picture
 *  keeps its zoom/pan when switching between inline and fullscreen. `rerender`
 *  repaints the host so the toolbar's % readout follows. Returns the props the
 *  surface spreads onto its wrap element plus the <img> onLoad. */
function useImageInteraction(
    wrapRef: { current: HTMLDivElement | null },
    imgRef: { current: HTMLImageElement | null },
    rerender: () => void,
    // Only the INLINE body owns the shared `imgControls` slot (the header toolbar
    // + keyboard drive it). The lightbox must NOT register: the inline body never
    // unmounts when the lightbox opens, so if the lightbox also wrote `imgControls`
    // its unmount-cleanup would null the slot the still-mounted inline body needs —
    // leaving the toolbar/keyboard dead after the first fullscreen round-trip.
    registerControls = true
) {
    const { useRef, useEffect } = React;

    // Clamp pan so the (scaled) image can't be dragged entirely out of view.
    const clampPan = () => {
        const wrap = wrapRef.current;
        if (!wrap || !activeWindow.imgView.natW || !activeWindow.imgView.natH) return;
        const cw = wrap.clientWidth;
        const ch = wrap.clientHeight;
        if (!cw || !ch) return;
        // fitted (scale 1) display size with object-fit: contain.
        const fitScale = Math.min(cw / activeWindow.imgView.natW, ch / activeWindow.imgView.natH, 1);
        const dispW = activeWindow.imgView.natW * fitScale * activeWindow.imgView.scale;
        const dispH = activeWindow.imgView.natH * fitScale * activeWindow.imgView.scale;
        const maxX = Math.max(0, (dispW - cw) / 2);
        const maxY = Math.max(0, (dispH - ch) / 2);
        activeWindow.imgView.tx = Math.max(-maxX, Math.min(maxX, activeWindow.imgView.tx));
        activeWindow.imgView.ty = Math.max(-maxY, Math.min(maxY, activeWindow.imgView.ty));
    };

    const applyScale = (next: number, originX?: number, originY?: number) => {
        const wrap = wrapRef.current;
        const prev = activeWindow.imgView.scale;
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
            activeWindow.imgView.tx = ox - (ox - activeWindow.imgView.tx) * ratio;
            activeWindow.imgView.ty = oy - (oy - activeWindow.imgView.ty) * ratio;
        }
        activeWindow.imgView.scale = next;
        if (next === 1) {
            activeWindow.imgView.tx = 0;
            activeWindow.imgView.ty = 0;
        }
        clampPan();
        rerender();
    };

    // Re-clamp + repaint after the surface resizes (e.g. entering fullscreen
    // changes the wrap size, so the pan limits change). Cheap and idempotent.
    const reflow = () => { clampPan(); rerender(); };

    // Expose controls to the toolbar + keyboard while the INLINE body is mounted.
    // Fullscreen toggle lives here so the header button, keyboard ('f') and the
    // overlay's own close all flip the same module flag and force a host repaint.
    // The lightbox passes registerControls=false (see note on the param).
    useEffect(() => {
        if (!registerControls) return;
        const ctrls: ImgControls = {
            zoomIn: () => applyScale(activeWindow.imgView.scale * 1.3),
            zoomOut: () => applyScale(activeWindow.imgView.scale / 1.3),
            reset: () => { resetImgView(); rerender(); },
            getScale: () => activeWindow.imgView.scale,
            toggleFullscreen: () => { activeWindow.imgView.fullscreen = !activeWindow.imgView.fullscreen; forceRender?.(); }
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
            applyScale(activeWindow.imgView.scale * factor, e.clientX - rect.left, e.clientY - rect.top);
        };
        wrap.addEventListener("wheel", onWheel, { passive: false });
        return () => wrap.removeEventListener("wheel", onWheel);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Drag to pan (only meaningful when zoomed past fit).
    const drag = useRef({ on: false, x: 0, y: 0, tx: 0, ty: 0 });
    const onPointerDown = (e: any) => {
        if (activeWindow.imgView.scale <= 1) return;
        if (e.button != null && e.button !== 0) return;
        drag.current = { on: true, x: e.clientX, y: e.clientY, tx: activeWindow.imgView.tx, ty: activeWindow.imgView.ty };
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    };
    const onPointerMove = (e: any) => {
        if (!drag.current.on) return;
        activeWindow.imgView.tx = drag.current.tx + (e.clientX - drag.current.x);
        activeWindow.imgView.ty = drag.current.ty + (e.clientY - drag.current.y);
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
        if (activeWindow.imgView.scale === 1) {
            // go to 100% real pixels: scale relative to the current fit scale.
            if (wrap && activeWindow.imgView.natW && activeWindow.imgView.natH) {
                const cw = wrap.clientWidth;
                const ch = wrap.clientHeight;
                const fitScale = Math.min(cw / activeWindow.imgView.natW, ch / activeWindow.imgView.natH, 1);
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
            activeWindow.imgView.natW = img.naturalWidth;
            activeWindow.imgView.natH = img.naturalHeight;
        }
        clampPan();
        rerender();
    };

    return {
        applyScale,
        reflow,
        wrapProps: {
            onPointerDown,
            onPointerMove,
            onPointerUp: endDrag,
            onPointerLeave: endDrag,
            onDoubleClick
        },
        onImgLoad
    };
}

/** The INLINE IMAGE body: a centered, fit(contain) <img> with zoom + pan,
 *  modelled on Discord's lightbox / a browser image viewer.
 *   - scale 1 = fit (CSS object-fit:contain keeps the whole image visible).
 *   - wheel = zoom toward the cursor; double-click = toggle fit <-> 100% (real
 *     pixels); drag = pan when zoomed past fit. The header toolbar +/-/reset/
 *     fullscreen and the keyboard (+/-/0, f) drive the same state via
 *     `imgControls`. When `imgView.fullscreen` is set the lightbox renders too. */
function ImageBody() {
    const { useRef, useState } = React;
    const wrapRef = useRef(null as HTMLDivElement | null);
    const imgRef = useRef(null as HTMLImageElement | null);
    const [, bump] = useState(0);
    // Re-render the WHOLE panel (not just this body) so the header toolbar's
    // zoom % readout stays in sync. forceRender bumps DockPanel's state; React
    // reconciles ImageBody by type (key=content.seq unchanged) so our refs +
    // view-state survive. Fall back to local bump if the panel isn't mounted.
    const rerender = () => (forceRender ? forceRender() : bump((n: number) => n + 1));

    const { wrapProps, onImgLoad } = useImageInteraction(wrapRef, imgRef, rerender);

    const zoomed = activeWindow.imgView.scale > 1;
    return React.createElement(
        React.Fragment,
        null,
        React.createElement(
            "div",
            {
                key: activeWindow.content.seq,
                ref: wrapRef,
                className: "dockview-img-wrap" + (zoomed ? " dockview-img-zoomed" : ""),
                tabIndex: 0,
                ...wrapProps
            },
            React.createElement("img", {
                ref: imgRef,
                className: "dockview-img",
                src: activeWindow.content.url || "",
                alt: activeWindow.content.name || "image",
                draggable: false,
                onLoad: onImgLoad,
                style: {
                    transform: `translate(${activeWindow.imgView.tx}px, ${activeWindow.imgView.ty}px) scale(${activeWindow.imgView.scale})`
                }
            })
        ),
        activeWindow.imgView.fullscreen ? React.createElement(ImageLightbox, null) : null
    );
}

/** The FULLSCREEN image lightbox (IMG-2): a self-rendered overlay covering the
 *  whole renderer (not just the dock panel), with a dimmed backdrop and the SAME
 *  zoom/pan engine as the inline body (shared via imgView). We self-render rather
 *  than reuse Discord's ImageModal because that component is NOT cleanly
 *  resolvable from the isolated plugin context (findByProps("ImageModal") does
 *  not return the component here) — a custom overlay has zero Discord-internal
 *  dependencies and can't break on a client update.
 *   - Esc, the ✕ button, or clicking the dim backdrop closes it.
 *   - zoom/pan/double-click all work exactly as inline (shared interaction).
 *   - on enter/exit the view-state (scale/tx/ty) is untouched, so the picture
 *     stays exactly where it was. A portal would be ideal but the plugin avoids
 *     extra Discord deps; rendering inside the panel still paints full-viewport
 *     via position:fixed. */
function ImageLightbox() {
    const { useRef, useEffect, useState } = React;
    const wrapRef = useRef(null as HTMLDivElement | null);
    const imgRef = useRef(null as HTMLImageElement | null);
    const [, bump] = useState(0);
    const rerender = () => (forceRender ? forceRender() : bump((n: number) => n + 1));

    // registerControls=false: the inline body owns `imgControls`; the lightbox
    // must not touch that slot (see the param note in useImageInteraction).
    const { reflow, wrapProps, onImgLoad } = useImageInteraction(wrapRef, imgRef, rerender, false);

    const close = () => { activeWindow.imgView.fullscreen = false; (forceRender ? forceRender() : bump((n: number) => n + 1)); };

    // Esc closes the lightbox; ←/→ step prev/next through the channel gallery
    // (Discord-lightbox parity). Bound at capture on window so it fires even
    // though the panel's own keydown handler only runs when the panel holds focus
    // — here we always want these to act while the overlay is up. stopPropagation
    // keeps Esc from also hitting Discord's Esc handlers (close-modal, etc.).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
            } else if (e.key === "ArrowLeft") {
                if (galleryCanStep(-1)) { e.preventDefault(); e.stopPropagation(); galleryStep(-1); }
            } else if (e.key === "ArrowRight") {
                if (galleryCanStep(1)) { e.preventDefault(); e.stopPropagation(); galleryStep(1); }
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The overlay wrap is a fresh, full-viewport surface; once it mounts the pan
    // limits differ from the inline body's, so re-clamp + repaint.
    useEffect(() => { reflow(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

    const zoomed = activeWindow.imgView.scale > 1;
    return React.createElement(
        "div",
        {
            className: "dockview-lightbox",
            // clicking the backdrop (but not the image itself) closes.
            onMouseDown: (e: any) => { if (e.target === e.currentTarget) close(); }
        },
        React.createElement(
            "button",
            {
                type: "button",
                className: "dockview-lightbox-close",
                "aria-label": STRINGS.image.exitFullscreen,
                title: STRINGS.image.exitFullscreen,
                onClick: close
            },
            React.createElement(
                "svg",
                { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                React.createElement("path", {
                    fill: "currentColor",
                    d: "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z"
                })
            )
        ),
        // prev/next channel-image steppers, on the left/right edges (Discord
        // lightbox grammar). Disabled (dimmed) at a true end / while loading.
        lightboxNavBtn("prev", STRINGS.image.prevImage, IMG_PREV_PATH, () => galleryStep(-1), !galleryCanStep(-1)),
        lightboxNavBtn("next", STRINGS.image.nextImage, IMG_NEXT_PATH, () => galleryStep(1), !galleryCanStep(1)),
        React.createElement(
            "div",
            {
                ref: wrapRef,
                className: "dockview-lightbox-stage" + (zoomed ? " dockview-img-zoomed" : ""),
                tabIndex: 0,
                ...wrapProps
            },
            React.createElement("img", {
                ref: imgRef,
                className: "dockview-lightbox-img",
                src: activeWindow.content.url || "",
                alt: activeWindow.content.name || "image",
                draggable: false,
                onLoad: onImgLoad,
                style: {
                    transform: `translate(${activeWindow.imgView.tx}px, ${activeWindow.imgView.ty}px) scale(${activeWindow.imgView.scale})`
                }
            })
        )
    );
}

/** A round edge-anchored prev/next button for the fullscreen lightbox (matches
 *  the close button's affordance). `side` "prev"|"next" positions it left/right;
 *  `disabled` dims it (kept in place per grammar rule 9). */
function lightboxNavBtn(side: "prev" | "next", label: string, path: string, onClick: () => void, disabled: boolean) {
    return React.createElement(
        "button",
        {
            key: "lb-" + side,
            type: "button",
            className: "dockview-lightbox-nav dockview-lightbox-nav-" + side + (disabled ? " dockview-lightbox-nav-disabled" : ""),
            "aria-label": label,
            "aria-disabled": disabled || undefined,
            disabled,
            title: label,
            onClick: disabled ? undefined : onClick,
            // don't let a nav click reach the backdrop (which would close).
            onMouseDown: (e: any) => e.stopPropagation()
        },
        React.createElement(
            "svg",
            { width: 28, height: 28, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: path })
        )
    );
}

// ---------------------------------------------------------------------------
// CODE / TEXT viewer — CodeMirror 6, read-only, always wrapping.
// ---------------------------------------------------------------------------
// The hand-rolled progressive-hljs line-DOM viewer was replaced by CodeMirror 6
// (the unified text engine: read-only here, editable + merge-diff in later
// steps). Two hard rules from the feasibility spike drive this code:
//   1. CM is loaded behind a LAZY dynamic import() (loadCM). A static top-level
//      `@codemirror/*` import THROWS at plugin module-eval and silently kills the
//      whole DockView plugin (window.__dockView never appears — same failure
//      class as calling React.createElement at module top-level). The dynamic
//      import defers CM's module evaluation to the first text-file open.
//   2. Syntax highlighting is GATED on file size. CM's editing/scroll/selection/
//      find are all cheap and host-safe even at 50k lines; the SOLE source of the
//      mount/scroll long-tasks the spike measured was the Lezer parser. So under
//      HIGHLIGHT_MAX_LINES we attach a CM language + syntaxHighlighting; at/above
//      it we drop the parser entirely (plain text in CM) to match the old
//      viewer's 0-long-task profile on huge files.
// CM owns its OWN scroller (.cm-scroller); for code/CSV-raw the scroll snapshot/
// restore (viewScroller) reads through to that element. lineWrapping is always on
// (locked Discord grammar: code never h-scrolls).

// Highlight gating threshold. Files with FEWER than this many lines get the Lezer
// parser-based highlighter; files at/above it render as plain text in CM (no
// parser → no parse long-tasks), matching the old CodeBody's 0-long-task 50k
// profile. 5000 chosen from the spike: the parser stays comfortably short-task
// well below this, while real source files needing colour are almost always
// under it. (Tunable; logged in the redesign doc.)
const HIGHLIGHT_MAX_LINES = 5000;

// The lazily-loaded CM module surface (resolved once, then cached). Holds the
// pieces we assemble an EditorView/EditorState from plus the language resolver.
interface CMModules {
    EditorState: any;
    EditorView: any;
    lineNumbers: any;
    Compartment: any;
    syntaxHighlighting: any;
    HighlightStyle: any;
    tags: any;
    Decoration: any;
    SearchCursor: any;
    RangeSetBuilder: any;
    StateField: any;
    StateEffect: any;
    // hljs-lang-id -> a freshly built CM LanguageSupport (or null for plaintext).
    languageFor: (hljsLang: string) => any | null;
    // our Discord-tuned theme + highlight style (built once from the modules).
    theme: any;
    highlightStyle: any;
    // find decoration plumbing (built once from the modules).
    setFindEffect: any;
    findField: any;
    // @codemirror/merge: inline colored diff vs a pristine original (2c-1).
    unifiedMergeView: any;
    // our diff colour theme (added/changed = green, deleted = red), built once.
    mergeTheme: any;
}

let cmModulesPromise: Promise<CMModules> | null = null;

/** Resolve every CM module behind a single dynamic import() and assemble the
 *  reusable surface (theme, highlight style, language resolver, find field).
 *  Cached: only the FIRST text-file open pays the import; the modules are then
 *  evaluated and the Discord theme/highlight-style/find-field are built once. */
function loadCM(): Promise<CMModules> {
    if (cmModulesPromise) return cmModulesPromise;
    cmModulesPromise = (async () => {
        // Dynamic imports — MUST NOT be hoisted to top-level (see rule 1 above).
        const stateMod = await import("@codemirror/state");
        const viewMod = await import("@codemirror/view");
        const langMod = await import("@codemirror/language");
        const searchMod = await import("@codemirror/search");
        const lezerHl = await import("@lezer/highlight");
        const mergeMod = await import("@codemirror/merge");

        const { EditorState, Compartment, StateField, StateEffect, RangeSetBuilder } = stateMod as any;
        const { EditorView, Decoration, lineNumbers } = viewMod as any;
        const { syntaxHighlighting, HighlightStyle } = langMod as any;
        const { SearchCursor } = searchMod as any;
        const { tags } = lezerHl as any;
        const { unifiedMergeView } = mergeMod as any;

        // --- Discord-tuned theme. Background/foreground match the in-panel code
        // surface (--background-base-lower / #dbdee1) so the editor reads at the
        // same tone as a real thread. Selection + active line use Discord vars
        // where they exist, with literal fallbacks for themes that lack them. The
        // gutter (line numbers) matches the old ::before gutter colours.
        const theme = EditorView.theme({
            "&": {
                color: "#dbdee1",
                backgroundColor: "var(--background-base-lower, #1a1a1e)",
                height: "100%",
                fontSize: "13px"
            },
            ".cm-scroller": {
                fontFamily: 'Consolas, "Andale Mono WT", "Andale Mono", "Lucida Console", monospace',
                lineHeight: "1.5",
                overflow: "auto"
            },
            ".cm-content": { caretColor: "#dbdee1" },
            "&.cm-focused": { outline: "none" },
            ".cm-gutters": {
                backgroundColor: "var(--background-base-lower, #1a1a1e)",
                color: "var(--text-muted, #6b7280)",
                border: "none",
                borderRight: "1px solid var(--background-modifier-accent, #2b2d31)"
            },
            ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
            ".cm-activeLineGutter": { backgroundColor: "transparent" },
            ".cm-activeLine": { backgroundColor: "transparent" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
                backgroundColor: "var(--text-selection, rgba(56,109,211,0.4))"
            },
            // find decorations (decoration-driven, not the @codemirror/search panel)
            ".cm-dockview-find": { backgroundColor: "rgba(255, 213, 0, 0.32)" },
            ".cm-dockview-find-active": { backgroundColor: "rgba(255, 145, 0, 0.6)" }
        }, { dark: true });

        // --- Highlight style tuned to the existing hljs dark theme (the same
        // github-dark-dimmed-ish palette used by the markdown iframe + the old
        // CodeBody) so colours stay consistent across both renderers.
        const highlightStyle = HighlightStyle.define([
            { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "#768390", fontStyle: "italic" },
            { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: "#f47067" },
            { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "#96d0ff" },
            { tag: [tags.number, tags.bool, tags.atom, tags.literal], color: "#6cb6ff" },
            { tag: [tags.variableName, tags.propertyName], color: "#dbdee1" },
            { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#dcbdfb" },
            { tag: [tags.className, tags.typeName, tags.namespace], color: "#f69d50" },
            { tag: [tags.definition(tags.variableName)], color: "#dbdee1" },
            { tag: [tags.tagName], color: "#f47067" },
            { tag: [tags.attributeName], color: "#6cb6ff" },
            { tag: [tags.attributeValue], color: "#96d0ff" },
            { tag: [tags.heading], color: "#dcbdfb", fontWeight: "700" },
            { tag: [tags.link, tags.url], color: "#6cb6ff", textDecoration: "underline" },
            { tag: [tags.emphasis], fontStyle: "italic" },
            { tag: [tags.strong], fontWeight: "700" },
            { tag: [tags.meta, tags.processingInstruction], color: "#6cb6ff" },
            { tag: [tags.deleted], color: "#ff938a" },
            { tag: [tags.inserted], color: "#96d0ff" },
            { tag: [tags.invalid], color: "#ff938a" }
        ]);

        // --- find decoration field. A StateField holds a DecorationSet rebuilt
        // from a list of {from,to,active} match ranges (dispatched via an effect),
        // so the same codeView find model (all matches dim / active match strong)
        // works over CM without the @codemirror/search FLOATING panel (that's a
        // later step). Marks target document offsets, so they survive scroll.
        const setFindEffect = StateEffect.define();
        const allMark = Decoration.mark({ class: "cm-dockview-find" });
        const activeMark = Decoration.mark({ class: "cm-dockview-find-active" });
        const findField = StateField.define({
            create: () => Decoration.none,
            update(deco: any, tr: any) {
                deco = deco.map(tr.changes);
                for (const e of tr.effects) {
                    if (e.is(setFindEffect)) {
                        const ranges: { from: number; to: number; active: boolean }[] = e.value;
                        const b = new RangeSetBuilder();
                        for (const r of ranges) {
                            if (r.from >= r.to) continue;
                            b.add(r.from, r.to, r.active ? activeMark : allMark);
                        }
                        deco = b.finish();
                    }
                }
                return deco;
            },
            provide: (f: any) => EditorView.decorations.from(f)
        });

        // --- language resolver. Maps the hljs language id we already derive per
        // file (content.codeLang) to a CM LanguageSupport, loaded from the lang
        // packs bundled into the renderer. A miss returns null → plain text in CM
        // (still themed/wrapped/findable, just no syntax colour). Each call builds
        // a fresh LanguageSupport (cheap) so two open files never share parser
        // state. Lang packs are imported lazily alongside CM (same dynamic chunk).
        const [
            jsMod, jsonMod, pyMod, cssMod, htmlMod, xmlMod, mdMod,
            rustMod, cppMod, javaMod, yamlMod, sqlMod, phpMod, goMod
        ] = await Promise.all([
            import("@codemirror/lang-javascript"),
            import("@codemirror/lang-json"),
            import("@codemirror/lang-python"),
            import("@codemirror/lang-css"),
            import("@codemirror/lang-html"),
            import("@codemirror/lang-xml"),
            import("@codemirror/lang-markdown"),
            import("@codemirror/lang-rust"),
            import("@codemirror/lang-cpp"),
            import("@codemirror/lang-java"),
            import("@codemirror/lang-yaml"),
            import("@codemirror/lang-sql"),
            import("@codemirror/lang-php"),
            import("@codemirror/lang-go")
        ]);

        const languageFor = (hljsLang: string): any | null => {
            switch (hljsLang) {
                case "javascript": return (jsMod as any).javascript();
                case "typescript": return (jsMod as any).javascript({ typescript: true });
                // jsx/tsx share the js pack with the jsx flag; our CODE_LANG maps
                // both .jsx and .tsx onto javascript/typescript already.
                case "json": return (jsonMod as any).json();
                case "python": return (pyMod as any).python();
                case "css": case "scss": case "less": return (cssMod as any).css();
                case "xml": case "svg": case "plist": return (xmlMod as any).xml();
                case "yaml": return (yamlMod as any).yaml();
                case "rust": return (rustMod as any).rust();
                case "c": case "cpp": return (cppMod as any).cpp();
                case "java": return (javaMod as any).java();
                case "sql": return (sqlMod as any).sql();
                case "php": return (phpMod as any).php();
                case "go": return (goMod as any).go();
                case "markdown": return (mdMod as any).markdown();
                // html only when explicitly typed html (our viewer routes .md/.svg
                // elsewhere); covers inline css/js. Reuse the html pack id.
                case "html": return (htmlMod as any).html();
                default: return null; // plaintext / unmapped → no language
            }
        };

        // --- merge diff theme. unifiedMergeView ships a dark baseTheme, but we
        // tune the colours to 선인's brief ("추가된 내용 색 다르게") and Discord's
        // palette: added/changed text on a GREEN wash, deleted text on a RED wash,
        // each with a matching change-gutter stripe. The accept/reject chunk
        // buttons are HIDDEN via mergeControls:false at the call site (they read as
        // heavy on a narrow panel); the colored add/change/delete display is the
        // point. We restyle `cm-changedText` / `cm-deletedChunk` (the editor is the
        // "b" side of a unified view, class `cm-merge-b`).
        const mergeTheme = EditorView.theme({
            // changed/added lines: a faint green line wash + stronger green on the
            // exact changed text run.
            ".cm-changedLine": { backgroundColor: "rgba(63, 185, 80, 0.12)" },
            ".cm-changedText": {
                backgroundColor: "rgba(63, 185, 80, 0.32)",
                borderRadius: "2px"
            },
            // inline-changed line (allowInlineDiffs path) — same green wash.
            ".cm-inlineChangedLine": { backgroundColor: "rgba(63, 185, 80, 0.12)" },
            // deleted chunk block (shown above the new text): a red wash, with the
            // exact deleted run a stronger red, struck through.
            ".cm-deletedChunk": { backgroundColor: "rgba(248, 81, 73, 0.12)" },
            ".cm-deletedChunk .cm-deletedText, .cm-deletedText": {
                backgroundColor: "rgba(248, 81, 73, 0.32)",
                color: "#ffb4ad",
                textDecoration: "line-through"
            },
            ".cm-insertedLine": { textDecoration: "none" },
            // change-gutter stripes (the thin marker next to a changed/deleted line).
            ".cm-changedLineGutter": { backgroundColor: "#3fb950" },
            ".cm-deletedLineGutter": { backgroundColor: "#f85149" }
        }, { dark: true });

        return {
            EditorState, EditorView, lineNumbers, Compartment, syntaxHighlighting, HighlightStyle,
            tags, Decoration, SearchCursor, RangeSetBuilder,
            StateField, StateEffect, languageFor, theme, highlightStyle,
            setFindEffect, findField, unifiedMergeView, mergeTheme
        } as CMModules;
    })();
    return cmModulesPromise;
}

/** The live code controller, now backed by a CodeMirror EditorView. Keeps the
 *  SAME public surface the find bar / keyboard handler already call (seq /
 *  matches / rebuildFind / focusMatch / teardown) so those call sites are
 *  unchanged — only the body is CM now. */
interface CodeController {
    seq: number;
    matches: { from: number; to: number }[]; // document offsets per match
    rebuildFind: (query: string) => void;
    focusMatch: (idx: number) => void;
    setEditable: (on: boolean) => void; // flip read↔edit via the compartment (2b)
    insert: (text: string) => void; // type text at the doc end (drives the buffer)
    teardown: () => void;
}
let codeCtrl: CodeController | null = null;

/** Whether the CURRENT body is a CodeMirror editor (so find / Ctrl+F apply). True
 *  for plain code, a CSV in raw mode, and markdown / .artifact in edit mode. */
function cmBodyShown(): boolean {
    if (activeWindow.content.code == null && activeWindow.content.type !== "html") return false;
    if (activeWindow.content.type === "code") return true;
    if (activeWindow.content.type === "csv") return activeWindow.csvView.mode === "raw";
    if (activeWindow.content.type === "markdown" || activeWindow.content.type === "html") return activeWindow.editView.mode === "edit";
    return false;
}

/** Whether the CM body for the CURRENT content should be EDITABLE on mount.
 *  - code: editable only in edit mode (Read↔Edit is one CM, flipped live).
 *  - csv-raw: always editable (Raw IS the edit surface — Grid↔Raw is a body swap).
 *  - markdown/artifact edit: the CM is only mounted in edit mode, so editable.
 *  In every case the doc is seeded from editBufferText() (the buffer if edited,
 *  else the pristine source) so a re-mount in either mode shows your edits. */
function cmEditableForContent(): boolean {
    if (activeWindow.content.type === "csv") return activeWindow.csvView.mode === "raw"; // raw = edit surface
    if (activeWindow.content.type === "code") return activeWindow.editView.mode === "edit";
    // markdown / artifact: the CM body only exists in edit mode.
    return activeWindow.editView.mode === "edit";
}

/** Build a CM EditorView for the current text file and wire it to the shared find
 *  model. Read↔edit is a runtime COMPARTMENT reconfigure (setEditable) — the view
 *  is NOT torn down/rebuilt on a toggle. The doc is seeded from the temporary edit
 *  buffer (editBufferText), and an update listener writes edits back to it so the
 *  ORIGINAL source (content.code / content.html) is never mutated. */
function buildCmController(host: HTMLElement, mods: CMModules): CodeController {
    // Seed from the buffer (= edits if any, else the pristine source). For markdown
    // the source is the raw md (stored in content.code by the loader), for .artifact
    // it's the html source — editBufferText() resolves the right one per type.
    const code = editBufferText();
    // The highlight gate uses the file's natural language. Markdown source edits
    // get the markdown grammar; .artifact html source gets the html grammar.
    const lang = activeWindow.content.type === "html" ? "html" : activeWindow.content.codeLang;
    const startEditable = cmEditableForContent();
    // Line count for the highlight gate (same trailing-newline convention as the
    // old viewer: a single trailing newline is not its own line).
    const bodyText = code.endsWith("\n") ? code.slice(0, -1) : code;
    const lineCount = bodyText.length ? (bodyText.split("\n").length) : 1;

    const langSupport = lineCount < HIGHLIGHT_MAX_LINES ? mods.languageFor(lang) : null;

    // A compartment for editable/readOnly so the Read↔Edit toggle reconfigures it
    // in place rather than rebuilding the EditorView (preserves scroll, find state,
    // and the Korean IME composition surface).
    //
    // READ mode = EditorState.readOnly (blocks edits) while the VIEW stays editable
    // (`editable.of(true)`), NOT `EditorView.editable.of(false)`. editable:false sets
    // contentEditable=false on .cm-content, which suppresses mouse drag-selection and
    // CM's selection drawing — so read mode lost text selection/copy (a regression
    // vs the old CodeBody). readOnly is the CM-idiomatic read surface: selection,
    // a visible highlight and copy all work; only document mutation is blocked. A
    // caret may show in read mode (acceptable — it's read-only), prioritising
    // working selection + copy.
    // The pristine original = the merge-diff baseline. NULL for a new file (no
    // original ever existed) → it edits as a plain CM with no diff (2c-1). For an
    // existing file it's the file's loaded source (code/csv/markdown source, or the
    // artifact html). Captured once; the original never changes.
    const original = editOriginalText();

    const editCompartment = new mods.Compartment();
    // The editable/readOnly state PLUS (when editable + there's an original) the
    // inline colored diff vs that original (2c-1). Bundling the merge view into the
    // SAME compartment means the read↔edit toggle adds/removes the diff in step:
    // read mode = no diff (just the read-only source); edit mode = the live diff.
    // A new file (original==null) never gets the diff. unifiedMergeView highlights
    // ranges where the editor doc differs from `original`; when they're equal (no
    // edits yet) it shows nothing — a clean editor.
    // unifiedMergeView's change-gutter (the colored per-line stripe) adds a SECOND
    // gutter inside .cm-gutters, ~3px wide. It only exists in EDIT mode (and only
    // when there's an original to diff against), so without compensation the total
    // .cm-gutters width — and therefore the divider line between the line-number
    // gutter and the code body — would JUMP RIGHT by that ~3px when toggling
    // read→edit (선인: "그 흰 줄이 움직여"). To keep the divider PERFECTLY still
    // (the same "no shift on interaction" principle as the tabs), we RESERVE the
    // change-gutter's footprint as right-padding on .cm-gutters whenever the real
    // change-gutter is ABSENT (read mode, or a new file's edit mode with no
    // original). The reserve == CM merge's change-gutter box (width 3px); padding
    // sits inside the border-right, so the divider x is identical in both modes.
    const CHANGE_GUTTER_RESERVE = "3px";
    const reserveGutterTheme = mods.EditorView.theme({
        ".cm-gutters": { paddingRight: CHANGE_GUTTER_RESERVE }
    });
    const editableExt = (on: boolean) => {
        const base = [
            mods.EditorView.editable.of(true),
            mods.EditorState.readOnly.of(!on)
        ];
        if (on && original != null) {
            base.push(mods.unifiedMergeView({
                original,
                // hide the per-chunk accept/reject buttons — heavy on a narrow side
                // panel; the colored add/change/delete display is what 선인 asked
                // for (note for 선인: accept/reject is intentionally suppressed).
                mergeControls: false,
                // keep the change-gutter stripe (a thin colored marker per changed
                // line) — it's a quiet locator, not noise.
                gutter: true,
                highlightChanges: true,
                // a fragment-only original can mis-highlight deleted lines under the
                // editor language; off is safer + lighter.
                syntaxHighlightDeletions: false
            }));
        } else {
            // No real change-gutter here → reserve its width so the gutter/body
            // divider stays at the SAME x as edit mode (no shift on toggle).
            base.push(reserveGutterTheme);
        }
        return base;
    };

    // Push edits into the temporary buffer (never the original). Only real document
    // changes count, so a pure selection/scroll dispatch doesn't churn the buffer.
    const editListener = mods.EditorView.updateListener.of((u: any) => {
        if (u.docChanged) setEditBuffer(u.state.doc.toString());
    });

    const extensions: any[] = [
        mods.lineNumbers(), // GitHub/VS-Code-style line-number gutter
        editCompartment.of(editableExt(startEditable)), // read↔edit (+ diff) (reconfigurable)
        editListener, // edits -> temporary buffer
        mods.EditorView.lineWrapping, // always wrap — never horizontal scroll
        mods.theme,
        mods.mergeTheme, // diff colours (added/changed green, deleted red)
        mods.findField
    ];
    if (langSupport) {
        // gated ON: parser-based syntax highlighting (Lezer). The parser is the
        // SOLE long-task source on huge files, so it's only added under the gate.
        extensions.push(langSupport, mods.syntaxHighlighting(mods.highlightStyle));
    }

    const state = mods.EditorState.create({ doc: code, extensions });
    const view = new mods.EditorView({ state, parent: host });

    const ctrl: CodeController = {
        seq: activeWindow.content.seq,
        matches: [],
        rebuildFind: () => { /* set below */ },
        focusMatch: () => { /* set below */ },
        setEditable: (on: boolean) => {
            view.dispatch({ effects: editCompartment.reconfigure(editableExt(on)) });
            if (on) view.focus();
        },
        // Insert text at the document end via a real CM transaction (used by the
        // CDP harness to drive an edit through the same path a keystroke takes —
        // the update listener then mirrors it into the temporary buffer).
        insert: (text: string) => {
            const at = view.state.doc.length;
            view.dispatch({ changes: { from: at, insert: text } });
        },
        teardown: () => { /* set below */ }
    };

    const pushDeco = () => {
        const activeIdx = activeWindow.codeView.findActive - 1;
        const ranges = ctrl.matches.map((m, i) => ({ from: m.from, to: m.to, active: i === activeIdx }));
        view.dispatch({ effects: mods.setFindEffect.of(ranges) });
    };

    ctrl.rebuildFind = (query: string) => {
        ctrl.matches = [];
        activeWindow.codeView.findMatches = 0;
        activeWindow.codeView.findActive = 0;
        if (!query) { pushDeco(); forceRender?.(); return; }
        // SearchCursor over the whole doc. caseInsensitive normalises both sides.
        const cur = activeWindow.codeView.findCase
            ? new mods.SearchCursor(view.state.doc, query)
            : new mods.SearchCursor(view.state.doc, query, 0, view.state.doc.length,
                (s: string) => s.toLowerCase());
        while (!cur.next().done) {
            ctrl.matches.push({ from: cur.value.from, to: cur.value.to });
        }
        activeWindow.codeView.findMatches = ctrl.matches.length;
        activeWindow.codeView.findActive = ctrl.matches.length ? 1 : 0;
        pushDeco();
        if (ctrl.matches.length) ctrl.focusMatch(0);
        else forceRender?.();
    };

    ctrl.focusMatch = (idx: number) => {
        const m = ctrl.matches[idx];
        if (!m) return;
        activeWindow.codeView.findActive = idx + 1;
        pushDeco();
        // scroll the active match into the centre of the viewport.
        view.dispatch({
            effects: mods.EditorView.scrollIntoView(m.from, { y: "center" })
        });
        forceRender?.();
    };

    ctrl.teardown = () => {
        try { view.destroy(); } catch { /* ignore */ }
    };

    codeCtrl = ctrl;
    return ctrl;
}

/** The CODE/TEXT body: a read-only CodeMirror editor. CM is lazy-loaded on the
 *  first text-file open (see loadCM); React mounts an empty host and the effect
 *  builds the EditorView once the modules resolve, keyed on content.seq so a new
 *  file remounts fresh. While CM loads (a beat on the very first open) the body
 *  shows nothing — the modules resolve in a few ms after the import is warm. */
function CodeBody() {
    const { useRef, useEffect } = React;
    const hostRef = useRef(null as HTMLElement | null);
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        let ctrl: CodeController | null = null;
        let cancelled = false;
        loadCM().then(mods => {
            if (cancelled || !host.isConnected) return;
            ctrl = buildCmController(host, mods);
            // restore find if it was open for this file (e.g. cache return), else
            // restore the saved scroll once the editor exists.
            if (activeWindow.codeView.findOpen && activeWindow.codeView.findQuery) ctrl.rebuildFind(activeWindow.codeView.findQuery);
            else consumePendingScroll();
        });
        return () => {
            cancelled = true;
            ctrl?.teardown();
            if (ctrl && codeCtrl === ctrl) codeCtrl = null;
        };
    }, [activeWindow.content.seq]);
    return React.createElement("div", {
        key: activeWindow.content.seq,
        ref: hostRef,
        className: "dockview-cm",
        // focusable so a click into the code body gives the panel keyboard focus —
        // Ctrl+F / find keys are gated on that focus (never on hover). CM's own
        // content is focusable too; this wraps it for the gate.
        tabIndex: 0
    });
}

/** The CODE find bar = the generic FindBar wired to the code view-state. */
function CodeFindBar() {
    return React.createElement(FindBar, {
        model: {
            query: activeWindow.codeView.findQuery,
            matches: activeWindow.codeView.findMatches,
            active: activeWindow.codeView.findActive,
            caseSensitive: activeWindow.codeView.findCase,
            placeholder: STRINGS.find.placeholder,
            setQuery: (q: string) => { activeWindow.codeView.findQuery = q; codeCtrl?.rebuildFind(q); },
            next: () => {
                if (!activeWindow.codeView.findMatches) return;
                codeCtrl?.focusMatch(activeWindow.codeView.findActive % activeWindow.codeView.findMatches);
            },
            prev: () => {
                if (!activeWindow.codeView.findMatches) return;
                codeCtrl?.focusMatch((activeWindow.codeView.findActive - 2 + activeWindow.codeView.findMatches) % activeWindow.codeView.findMatches);
            },
            toggleCase: () => { activeWindow.codeView.findCase = !activeWindow.codeView.findCase; codeCtrl?.rebuildFind(activeWindow.codeView.findQuery); forceRender?.(); },
            close: () => toggleCodeFind()
        }
    });
}

/** Focus the floating find box's text input (if it's mounted). Used by the
 *  Ctrl+F handler for the edge where the box is already open with no matches —
 *  a fresh open self-focuses via the FindBar's mount effect. */
function focusFindBox() {
    const el = document.querySelector<HTMLInputElement>(`#${HOST_ID} .dockview-find-input`);
    el?.focus();
}

/** Toggle the code find bar. Closing clears the query + highlights. */
function toggleCodeFind() {
    activeWindow.codeView.findOpen = !activeWindow.codeView.findOpen;
    if (!activeWindow.codeView.findOpen) {
        activeWindow.codeView.findQuery = "";
        activeWindow.codeView.findMatches = 0;
        activeWindow.codeView.findActive = 0;
        if (codeCtrl) { codeCtrl.matches = []; codeCtrl.rebuildFind(""); }
    }
    forceRender?.();
}

// ---------------------------------------------------------------------------
// CSV / TSV grid body.
// ---------------------------------------------------------------------------
// A spreadsheet-style <table>: a STICKY header row (row 0 of the file) + a body
// of data rows. The first row is always treated as the header. The body is built
// IMPERATIVELY (a few-thousand-row React tree would be pathological) keyed on
// content.seq, exactly like CodeBody: the FIRST batch of rows is appended
// synchronously (instant top), the rest stream in over rAF ticks, and every body
// row carries content-visibility:auto so off-screen rows cost ~nothing to lay out
// (O(visible) layout, no virtualisation library — every cell stays a real node,
// so native select/copy keep working). Cell text never wraps (white-space:nowrap
// + ellipsis) and the table scrolls horizontally for wide files. Ragged rows are
// padded to / clipped against the column count so columns stay aligned.

const CSV_FIRST_BATCH = 120;   // body rows appended synchronously on mount (a screenful+)
const CSV_ROW_BATCH = 800;     // body rows appended per scheduled rAF tick
const CSV_MAX_COLS = 512;      // hard column cap (a pathological wide row can't blow up the DOM)

/** Live controller for a mounted CSV grid: owns the streaming row build + its rAF
 *  pump so a teardown (file switch / toggle to raw) cancels in-flight work. */
interface CsvController {
    seq: number;
    cancelled: boolean;
    rafId: number;
    rowsBuilt: number;
    teardown: () => void;
}
let csvCtrl: CsvController | null = null;

/** Build the grid DOM into `mount` and stream the body rows in. Returns the
 *  controller (also stored in csvCtrl). One call per CSV grid mount. */
function buildCsvController(mount: HTMLElement): CsvController {
    // Parse the edited BUFFER (so a Raw edit shows up in the grid on toggle-back),
    // falling back to the original text when the file is unedited.
    const rows = parseDelimited(editBufferText(), activeWindow.csvView.delimiter);
    const header = rows.length ? rows[0] : [];
    // Column count = the widest of the header / a sample of data rows, so ragged
    // rows still get enough columns; capped so a runaway row can't explode the DOM.
    let cols = header.length;
    const sample = Math.min(rows.length, 200);
    for (let i = 1; i < sample; i++) if (rows[i].length > cols) cols = rows[i].length;
    cols = Math.max(1, Math.min(cols, CSV_MAX_COLS));
    const dataCount = Math.max(0, rows.length - 1);

    const table = document.createElement("table");
    table.className = "dockview-csv-table";

    // --- sticky header row (file row 0). A header cell may be empty; show its
    //     1-based column index as a faded fallback so the column is still clickable
    //     /readable. The whole thead is position:sticky via CSS. -----------------
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    for (let c = 0; c < cols; c++) {
        const th = document.createElement("th");
        th.className = "dockview-csv-th";
        const v = header[c] ?? "";
        if (v.length) th.textContent = v;
        else { th.textContent = ""; th.classList.add("dockview-csv-empty"); }
        th.title = v; // full value on hover (cells truncate with ellipsis)
        htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    mount.appendChild(table);

    const ctrl: CsvController = {
        seq: activeWindow.content.seq,
        cancelled: false,
        rafId: 0,
        rowsBuilt: 0,
        teardown: () => { /* set below */ }
    };

    // Append data rows [from,to) (file rows from+1 .. to). Built off-DOM as an
    // HTML string parsed in one template, then attached in a single reflow per
    // batch — same cheap-bulk-append trick the code viewer uses. Short rows are
    // padded with empty cells, extra cells past `cols` are dropped, so the grid
    // is always exactly `cols` wide and stays aligned.
    const appendRows = (from: number, to: number) => {
        let s = "";
        for (let i = from; i < to; i++) {
            const r = rows[i + 1]; // +1: skip the header row
            s += "<tr class=\"dockview-csv-row\">";
            for (let c = 0; c < cols; c++) {
                const v = (r && c < r.length) ? r[c] : "";
                // attribute-escape for the title, body-escape for the text.
                s += "<td class=\"dockview-csv-td\" title=\"" + escapeAttr(v) + "\">" + escapeHtml(v) + "</td>";
            }
            s += "</tr>";
        }
        const tmp = document.createElement("template");
        tmp.innerHTML = s;
        tbody.appendChild(tmp.content);
        ctrl.rowsBuilt = to;
    };

    const pump = () => {
        ctrl.rafId = 0;
        if (ctrl.cancelled) return;
        if (ctrl.rowsBuilt < dataCount) {
            appendRows(ctrl.rowsBuilt, Math.min(dataCount, ctrl.rowsBuilt + CSV_ROW_BATCH));
            if (ctrl.rowsBuilt < dataCount) {
                ctrl.rafId = (window.requestAnimationFrame || window.setTimeout)(pump) as unknown as number;
            }
        }
    };

    ctrl.teardown = () => {
        ctrl.cancelled = true;
        if (ctrl.rafId) {
            try { (window.cancelAnimationFrame || window.clearTimeout)(ctrl.rafId); } catch { /* ignore */ }
            ctrl.rafId = 0;
        }
    };

    // First batch synchronous (instant top), the rest stream across rAF ticks.
    appendRows(0, Math.min(dataCount, CSV_FIRST_BATCH));
    if (ctrl.rowsBuilt < dataCount) {
        ctrl.rafId = (window.requestAnimationFrame || window.setTimeout)(pump) as unknown as number;
    }

    csvCtrl = ctrl;
    return ctrl;
}

/** The CSV GRID body: an imperatively-built <table> inside a horizontally-
 *  scrollable column, keyed on content.seq so a new file (or a raw->grid toggle)
 *  remounts it fresh. React mounts the empty scroll wrap; buildCsvController fills
 *  it and streams the rows. */
function CsvBody() {
    const { useRef, useEffect } = React;
    const mountRef = useRef(null as HTMLElement | null);
    useEffect(() => {
        const m = mountRef.current;
        if (!m) return;
        const ctrl = buildCsvController(m);
        // restore the saved scroll once the (first) rows exist.
        consumePendingScroll();
        return () => {
            ctrl.teardown();
            if (csvCtrl === ctrl) csvCtrl = null;
        };
    }, [activeWindow.content.seq]);
    return React.createElement(
        "div",
        {
            key: activeWindow.content.seq,
            className: "dockview-csv-scroll",
            // focusable so a click into the grid gives the panel keyboard focus.
            tabIndex: 0
        },
        React.createElement("div", { ref: mountRef, className: "dockview-csv-mount" })
    );
}

/** Flip a CSV between the grid and the raw text view. Raw IS the editable surface
 *  (its CM mounts editable, edits go to the temporary buffer); Grid re-parses from
 *  the edited buffer so a Raw edit shows up in the grid on toggle-back. Each view
 *  re-mounts fresh (a new content.seq) and opens at its own top. */
function toggleCsvMode() {
    if (activeWindow.content.type !== "csv") return;
    activeWindow.csvView.mode = activeWindow.csvView.mode === "grid" ? "raw" : "grid";
    // leaving the raw view: close its find bar so it doesn't linger over the grid.
    if (activeWindow.csvView.mode === "grid" && activeWindow.codeView.findOpen) toggleCodeFind();
    activeWindow.content.seq += 1; // new body identity -> CodeBody/CsvBody remount fresh
    pendingScrollTop = null; // each view opens at its own top (no cross-bleed)
    forceRender?.();
}

/** Flip the editable text family between its VIEW mode and EDIT mode (2b). The
 *  CSV grid/raw toggle is a SEPARATE path (toggleCsvMode) — this drives code,
 *  markdown and .artifact.
 *   - code: ONE CodeMirror instance, flipped read↔edit live via the compartment
 *     (no remount — scroll/find/IME survive). The doc already shows the buffer.
 *   - markdown / .artifact: the body SWITCHES (rendered iframe ↔ editable CM over
 *     the source). Toggling back to VIEW RE-RENDERS from the edited buffer (md
 *     re-marked, html re-stamped) so your edits are reflected in the render. */
function toggleEditMode() {
    if (activeWindow.content.type !== "code" && activeWindow.content.type !== "markdown" && activeWindow.content.type !== "html") return;
    const entering = activeWindow.editView.mode === "view";
    activeWindow.editView.mode = entering ? "edit" : "view";

    if (activeWindow.content.type === "code") {
        // Same CM instance: just reconfigure editability. No seq bump, no remount.
        codeCtrl?.setEditable(entering);
        forceRender?.(); // repaint the toggle's active state (row 2)
        return;
    }

    // markdown / artifact = a body swap (iframe <-> CM). When LEAVING edit, rebuild
    // the rendered doc from the edited buffer so the render reflects the edits.
    if (!entering) {
        const src = editBufferText();
        const fullHtml = activeWindow.content.type === "markdown" ? renderMarkdownDoc(src) : src;
        setArtifactHtml(fullHtml);
        // keep the cache entry's rendered payload in sync so a re-open shows edits.
        if (activeWindow.activeCacheKey != null) {
            const e = contentCache.get(activeWindow.activeCacheKey);
            if (e) { e.html = activeWindow.content.html; e.frameHtml = activeWindow.content.frameHtml; }
        }
    }
    // close any find bar from the edit CM so it doesn't linger over the render.
    if (!entering && activeWindow.codeView.findOpen) toggleCodeFind();
    activeWindow.content.seq += 1; // new body identity -> iframe/CM remount fresh
    pendingScrollTop = null; // each mode opens at its own top
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
    const url = activeWindow.content.url;
    const name = activeWindow.content.name || "file";
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
                // "Open in browser" = an in-app Vesktop window (unified path), not
                // the external OS browser. The file failed to load so there's no
                // in-memory content; embed its url in the in-app window.
                onClick: () => { if (url) openUrlInVesktopWindow(url, name); }
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
        { className: "dockview-unsupported dockview-error-card", key: activeWindow.content.seq },
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
    const url = activeWindow.content.url;
    const name = activeWindow.content.name || "file";
    const ext = extOf(name) || extOf(url);
    return React.createElement(
        "div",
        { className: "dockview-unsupported", key: activeWindow.content.seq },
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
                    // "Open in browser" = an in-app Vesktop window (unified path).
                    // A binary file we can't preview has no in-memory content; embed
                    // its url in the in-app window (the browser downloads it if it
                    // can't render — same as opening the link, but in-app).
                    onClick: () => { if (url) openUrlInVesktopWindow(url, name); }
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
    if (activeWindow.content.name == null) {
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
    if (activeWindow.content.error != null) {
        return renderErrorBody(activeWindow.content.error);
    }
    if (activeWindow.content.type === "pdf") {
        if (activeWindow.content.loading || activeWindow.content.pdf.doc == null) {
            return React.createElement(LoadingBody, null);
        }
        return React.createElement(PdfBody, null);
    }
    if (activeWindow.content.type === "image") {
        return React.createElement(ImageBody, null);
    }
    if (activeWindow.content.type === "code") {
        if (activeWindow.content.loading || activeWindow.content.code == null) {
            return React.createElement(LoadingBody, null);
        }
        return React.createElement(CodeBody, null);
    }
    if (activeWindow.content.type === "csv") {
        if (activeWindow.content.loading || activeWindow.content.code == null) {
            return React.createElement(LoadingBody, null);
        }
        // Grid by default; the header's Table/Raw toggle flips to the code viewer
        // over the SAME content.code (so raw is the literal file text).
        return activeWindow.csvView.mode === "raw"
            ? React.createElement(CodeBody, null)
            : React.createElement(CsvBody, null);
    }
    if (activeWindow.content.type === "unknown") {
        // Still sniffing (a text file gets retyped to "code" on resolve, so the
        // only "unknown" left after load is a sniffed-binary file).
        if (activeWindow.content.loading) {
            return React.createElement(LoadingBody, null);
        }
        return renderUnsupportedBody();
    }
    if (activeWindow.content.type === "mcpapp") {
        if (activeWindow.content.loading || activeWindow.content.frameHtml == null) {
            return React.createElement(LoadingBody, null);
        }
        return renderMcpAppBody();
    }
    // docx (mammoth->HTML) and mermaid (->SVG) are VIEW-ONLY: there's no editable
    // source, so they always render through the same dark sandboxed iframe as the
    // markdown/artifact view path (no edit-mode CM swap).
    if (activeWindow.content.type === "docx" || activeWindow.content.type === "mermaid") {
        if (activeWindow.content.loading || activeWindow.content.frameHtml == null) {
            return React.createElement(LoadingBody, null);
        }
        return renderHtmlBody();
    }
    // markdown + .artifact (html) share the iframe path in VIEW mode. In EDIT mode
    // the body SWITCHES to an editable CM over the source (raw md / html source) —
    // mirroring the CSV Grid↔Raw body swap (toggleEditMode re-renders on the way
    // back). The CM seeds from editBufferText() and writes edits to the buffer.
    if (activeWindow.content.loading) {
        return React.createElement(LoadingBody, null);
    }
    if (activeWindow.editView.mode === "edit") {
        return React.createElement(CodeBody, null);
    }
    if (activeWindow.content.frameHtml == null) {
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

/** A small SVG toolbar button (square, hover bg) — shared by all tool types.
 *  `disabled` keeps the button in its slot but dimmed + non-interactive (Discord
 *  grammar rule 9: a control never disappears by mode; when inactive it renders
 *  disabled, not removed). A disabled button drops its hover/active state, dims,
 *  shows a default cursor, and no-ops on click. */
function toolBtn(key: string, label: string, path: string, onClick: () => void, active = false, disabled = false) {
    return React.createElement(
        "button",
        {
            key,
            type: "button",
            className: "dockview-tool-btn"
                + (active && !disabled ? " dockview-tool-btn-active" : "")
                + (disabled ? " dockview-tool-btn-disabled" : ""),
            "aria-label": label,
            title: label,
            "aria-pressed": (active && !disabled) || undefined,
            "aria-disabled": disabled || undefined,
            disabled,
            onClick: disabled ? undefined : onClick
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
// Open-hand "pan tool" glyph (Material "pan_tool" outline) for the PDF drag-mode
// toggle: highlighted = pan (drag moves the page), dim = text-select.
const PAN_HAND_PATH = "M21 11.5v5a4.5 4.5 0 0 1-4.5 4.5h-3.4a4.5 4.5 0 0 1-3.18-1.32l-4.9-4.9a1.4 1.4 0 0 1 1.98-1.98l1.5 1.5V5.5a1.25 1.25 0 0 1 2.5 0v5h.5v-7a1.25 1.25 0 0 1 2.5 0v7h.5v-6a1.25 1.25 0 0 1 2.5 0v6h.5v-4.5a1.25 1.25 0 0 1 2.5 0Z";

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
    if (activeWindow.content.loading || activeWindow.content.error || activeWindow.content.pdf.doc == null) return null;
    const pct = Math.round(activeWindow.pdfView.zoom * 100);
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
                    placeholder: String(activeWindow.pdfView.page),
                    onChange: (e: any) => setPageInput(e.target.value.replace(/[^0-9]/g, "")),
                    onKeyDown: (e: any) => {
                        if (e.key === "Enter") { e.preventDefault(); commitPage(); }
                        e.stopPropagation();
                    },
                    onBlur: () => { if (pageInput) commitPage(); }
                }),
                React.createElement("span", { className: "dockview-tool-pagetotal" }, " / " + activeWindow.pdfView.total)
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
        // drag-mode toggle (state-colour, member-list grammar): a single hand icon
        // button that HIGHLIGHTS when pan is active. Off = text-select (drag selects
        // PDF text, the default + current behaviour); on (highlighted) = pan (drag
        // scrolls the page on both axes so a zoomed PDF can be moved sideways). The
        // colour state — not a label — says which mode is active. Always present
        // (rule 9), never removed; mid priority so it collapses with find.
        React.createElement(
            "div",
            { className: "dockview-tool-group dockview-collapse-mid" },
            toolBtn("pdf-dragmode",
                activeWindow.pdfView.dragMode === "pan" ? STRINGS.pdf.dragSelect : STRINGS.pdf.dragPan,
                PAN_HAND_PATH,
                () => pdfControls?.toggleDragMode(), activeWindow.pdfView.dragMode === "pan")
        ),
        // find toggle (the only header toggle for PDF; fit-width is in ⋯).
        // Mid priority: collapses before the zoom group but after the arrows.
        React.createElement(
            "div",
            { className: "dockview-tool-group dockview-collapse-mid" },
            toolBtn("pdf-find", STRINGS.pdf.find,
                "M10 4a6 6 0 1 0 3.71 10.71l4.29 4.3a1 1 0 0 0 1.42-1.42l-4.3-4.29A6 6 0 0 0 10 4Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z",
                () => pdfControls?.toggleFind(), activeWindow.pdfView.findOpen)
        )
    );
}

// Chevron glyphs for the prev/next image stepper (Discord-style ghost icons).
const IMG_PREV_PATH = "M15.3 18.7a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 1 1 1.4 1.4L10 12l5.3 5.3a1 1 0 0 1 0 1.4Z";
const IMG_NEXT_PATH = "M8.7 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 1 1-1.4-1.4L14 12 8.7 6.7a1 1 0 0 1 0-1.4Z";

/** Image header controls: prev/next channel-image nav + the shared zoom group +
 *  a reset-to-fit + fullscreen. The prev/next pair cycles through the channel's
 *  images IN ORDER (oldest→newest), like Discord's native lightbox; at a true end
 *  (no more to fetch) or while a load-more is in flight the button DIMS rather
 *  than vanishing (grammar rule 9). */
function ImageHeaderControls() {
    if (activeWindow.content.loading || activeWindow.content.error || !activeWindow.content.url) return null;
    const pct = Math.round(activeWindow.imgView.scale * 100);
    return React.createElement(
        React.Fragment,
        null,
        // prev/next image stepper — highest priority (it's the headline image
        // action), so it never collapses. Dim at a true end / while loading.
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            toolBtn("img-prev", STRINGS.image.prevImage, IMG_PREV_PATH,
                () => galleryStep(-1), false, !galleryCanStep(-1)),
            toolBtn("img-next", STRINGS.image.nextImage, IMG_NEXT_PATH,
                () => galleryStep(1), false, !galleryCanStep(1))
        ),
        zoomGroup("img", pct, () => imgControls?.zoomOut(), () => imgControls?.zoomIn()),
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            toolBtn("zoom-reset", STRINGS.zoom.reset,
                "M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5 1 1 0 1 0-2 0 7 7 0 1 0 7-7Z",
                () => imgControls?.reset()),
            // Fullscreen toggle (IMG-2): the active state reflects whether the
            // lightbox is currently open, so the button reads as a toggle.
            toolBtn("img-fullscreen",
                activeWindow.imgView.fullscreen ? STRINGS.image.exitFullscreen : STRINGS.image.enterFullscreen,
                "M5 5h5a1 1 0 0 1 0 2H7v3a1 1 0 1 1-2 0V5Zm9 0h5v5a1 1 0 1 1-2 0V7h-3a1 1 0 1 1 0-2ZM6 14a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2H5v-5a1 1 0 0 1 1-1Zm12 0a1 1 0 0 1 1 1v5h-5a1 1 0 1 1 0-2h3v-3a1 1 0 0 1 1-1Z",
                () => imgControls?.toggleFullscreen(),
                activeWindow.imgView.fullscreen)
        )
    );
}

/** Code row-2 controls: language label, find trigger, copy. (Word wrap is always
 *  on, so there is no wrap toggle.) Own component for the copy "Copied" flash. */
function CodeHeaderControls() {
    const { useState } = React;
    const [copied, setCopied] = useState(false);
    if (activeWindow.content.loading || activeWindow.content.error || activeWindow.content.code == null) return null;
    const copy = () => {
        // copy what's SHOWN: the edited buffer in edit mode, else the original.
        const text = editBufferText();
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
    const editing = activeWindow.editView.mode === "edit";
    return React.createElement(
        React.Fragment,
        null,
        // language label = lowest priority (informational); collapses first.
        React.createElement("span", { className: "dockview-tool-lang dockview-collapse-low", title: STRINGS.code.detectedLanguage }, activeWindow.content.codeLang),
        // find toggle (mirrors PDF). Mid priority: collapses before wrap/copy.
        React.createElement(
            "div",
            { className: "dockview-tool-group dockview-collapse-mid" },
            toolBtn("code-find", STRINGS.code.find,
                "M10 4a6 6 0 1 0 3.71 10.71l4.29 4.3a1 1 0 0 0 1.42-1.42l-4.3-4.29A6 6 0 0 0 10 4Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z",
                () => toggleCodeFind(), activeWindow.codeView.findOpen)
        ),
        copyBtn("code-copy", STRINGS.code.copy, copied, copy),
        // Edit toggle (2b): one pencil button that highlights when EDIT is on
        // (member-list state-colour grammar). Read = CM read-only, Edit = CM
        // editable over the temporary buffer.
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            toolBtn("code-edit", editing ? STRINGS.edit.exitEditCode : STRINGS.edit.enterEditCode,
                EDIT_PENCIL_PATH, () => toggleEditMode(), editing)
        )
    );
}

/** The pencil glyph used by every edit toggle (code / markdown / artifact). */
const EDIT_PENCIL_PATH = "M19.3 8.9 15.1 4.7l1.4-1.4a2 2 0 0 1 2.8 0l1.4 1.4a2 2 0 0 1 0 2.8l-1.4 1.4ZM13.7 6.1l4.2 4.2L8.6 19.6 3 21l1.4-5.6 9.3-9.3Z";

/** A ghost icon copy button (Discord message code-block copy glyph) with a
 *  "copied" check flash. Shared by code + CSV row-2 controls. `label` is the
 *  tooltip; `copied` flips the glyph to a check + tints positive. */
function copyBtn(key: string, label: string, copied: boolean, onClick: () => void) {
    return React.createElement(
        "button",
        {
            key,
            type: "button",
            className: "dockview-tool-btn dockview-tool-copy" + (copied ? " dockview-tool-copied" : ""),
            "aria-label": copied ? STRINGS.code.copied : label,
            title: copied ? STRINGS.code.copied : label,
            onClick
        },
        React.createElement(
            "svg",
            { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            copied
                ? React.createElement("path", { fill: "currentColor", d: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" })
                : React.createElement("path", { fill: "currentColor", d: "M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2Zm2 0h5a2 2 0 0 1 2 2v5h2V5h-9v2ZM6 9v9h9V9H6Z" })
        )
    );
}

/** CSV row-2 controls: a single STATE-COLOUR Raw toggle (member-list-toggle
 *  grammar — one ghost icon button that fills/highlights when raw is active),
 *  plus a find trigger (raw only, since raw reuses the code body) and a copy icon.
 *  Word wrap is always on, so there is no wrap control. */
function CsvHeaderControls() {
    const { useState } = React;
    const [copied, setCopied] = useState(false);
    if (activeWindow.content.loading || activeWindow.content.error || activeWindow.content.code == null) return null;
    const raw = activeWindow.csvView.mode === "raw";
    const copy = () => {
        // raw mode may hold an edited buffer; grid mode = the original text.
        const text = editBufferText();
        const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
        try {
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
            } else { fallbackCopy(text, done); }
        } catch { fallbackCopy(text, done); }
    };
    const children: any[] = [];
    // Find trigger. Find runs over the raw CM body, so it is only ACTIVE in Raw
    // mode; in Grid mode it stays in its slot but DISABLED (dimmed) rather than
    // vanishing (grammar rule 9 — never appear/disappear by mode).
    children.push(React.createElement(
        "div",
        { key: "csv-find-grp", className: "dockview-tool-group dockview-collapse-mid" },
        toolBtn("csv-find", STRINGS.code.find,
            "M10 4a6 6 0 1 0 3.71 10.71l4.29 4.3a1 1 0 0 0 1.42-1.42l-4.3-4.29A6 6 0 0 0 10 4Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z",
            () => toggleCodeFind(), activeWindow.codeView.findOpen, !raw)
    ));
    // Always: the Raw state-colour toggle (icon highlights when active) + copy.
    children.push(React.createElement(
        "div",
        { key: "csv-toggle-grp", className: "dockview-tool-group" },
        // Raw toggle = one button that changes COLOUR by state (off = grid view,
        // highlighted = raw text). The "</>" code glyph reads as "show the raw text".
        toolBtn("csv-raw", STRINGS.csv.rawHint,
            "M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4Zm5.2 0L19.2 12l-4.6-4.6L16 6l6 6-6 6-1.4-1.4Z",
            () => toggleCsvMode(), raw),
        copyBtn("csv-copy", STRINGS.csv.copyHint, copied, copy)
    ));
    return React.createElement(React.Fragment, null, ...children);
}

/** Markdown / .artifact row-2 controls (2b): a single state-colour EDIT toggle
 *  (Rendered ↔ source-edit). In EDIT mode the body is an editable CM, so a find
 *  trigger + copy appear too (mirroring the code row); in RENDERED mode it's just
 *  the toggle (the iframe owns its own content). `mdMode` true = markdown (edit the
 *  raw md source), false = .artifact (edit the html source). */
function EditTextHeaderControls(props: { mdMode: boolean }) {
    const { useState } = React;
    const [copied, setCopied] = useState(false);
    if (activeWindow.content.loading || activeWindow.content.error) return null;
    const editing = activeWindow.editView.mode === "edit";
    const copy = () => {
        const text = editBufferText();
        const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
        try {
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
            } else { fallbackCopy(text, done); }
        } catch { fallbackCopy(text, done); }
    };
    const children: any[] = [];
    // Find runs over the editable CM body, which only exists in EDIT mode; in
    // RENDERED mode the body is the read-only iframe (no find target), so find
    // stays in its slot DISABLED (dimmed) rather than vanishing (grammar rule 9).
    children.push(React.createElement(
        "div",
        { key: "edit-find-grp", className: "dockview-tool-group dockview-collapse-mid" },
        toolBtn("edit-find", STRINGS.code.find,
            "M10 4a6 6 0 1 0 3.71 10.71l4.29 4.3a1 1 0 0 0 1.42-1.42l-4.3-4.29A6 6 0 0 0 10 4Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z",
            () => toggleCodeFind(), activeWindow.codeView.findOpen, !editing)
    ));
    // Copy stays in its slot in both modes (it copies the source/buffer either way),
    // so it never vanishes — no need to disable it by mode.
    children.push(copyBtn("edit-copy", STRINGS.code.copy, copied, copy));
    // Always: the edit state-colour toggle (pencil highlights when editing).
    const enter = props.mdMode ? STRINGS.edit.enterEditMarkdown : STRINGS.edit.enterEditArtifact;
    const exit = props.mdMode ? STRINGS.edit.exitEditMarkdown : STRINGS.edit.exitEditArtifact;
    children.push(React.createElement(
        "div",
        { key: "edit-toggle-grp", className: "dockview-tool-group" },
        toolBtn("edit-toggle", editing ? exit : enter, EDIT_PENCIL_PATH,
            () => toggleEditMode(), editing)
    ));
    return React.createElement(React.Fragment, null, ...children);
}

/** The per-viewer control cluster for the current content type, rendered in the
 *  SECOND header row (below the icon/name/⋯/X top row). Markdown + .artifact get
 *  the edit toggle (2b); unknown has no row 2 (see hasViewerControls). */
function HeaderControls() {
    if (activeWindow.content.type === "pdf") return React.createElement(PdfHeaderControls, null);
    if (activeWindow.content.type === "image") return React.createElement(ImageHeaderControls, null);
    if (activeWindow.content.type === "code") return React.createElement(CodeHeaderControls, null);
    if (activeWindow.content.type === "csv") return React.createElement(CsvHeaderControls, null);
    if (activeWindow.content.type === "markdown") return React.createElement(EditTextHeaderControls, { mdMode: true });
    if (activeWindow.content.type === "html") return React.createElement(EditTextHeaderControls, { mdMode: false });
    return null;
}

/** True when the current content has row-2 controls (so the second header row is
 *  rendered). Markdown + .artifact now carry the edit toggle; only unknown has none.
 *  An EMPTY dock (after clearArtifact: type stays "html" but content.name is null)
 *  has no file, so it must NOT render a controls row — otherwise the header shows a
 *  spurious second strip over an empty body. */
function hasViewerControls(): boolean {
    if (activeWindow.content.loading || activeWindow.content.error) return false;
    if (activeWindow.content.name == null) return false;
    return activeWindow.content.type === "pdf" || activeWindow.content.type === "image"
        || activeWindow.content.type === "code" || activeWindow.content.type === "csv"
        || activeWindow.content.type === "markdown" || activeWindow.content.type === "html";
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
    fitWidth: menuIcon("M4 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1Zm16 0a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1ZM8.7 8.3a1 1 0 0 0-1.4 1.4l.29.3H7a1 1 0 0 0 0 2h.59l-.3.3a1 1 0 1 0 1.42 1.4l2-2a1 1 0 0 0 0-1.4l-2-2Zm6.6 0a1 1 0 0 1 1.4 1.4l-.29.3H17a1 1 0 1 1 0 2h-.59l.3.3a1 1 0 0 1-1.42 1.4l-2-2a1 1 0 0 1 0-1.4l2-2Z"),
    // Paperclip — the universal "attach a file" affordance (matches Discord's own).
    attach: menuIcon("M16.5 6.3 8.8 14a2 2 0 1 0 2.83 2.83l7.07-7.07a4 4 0 1 0-5.66-5.66l-7.07 7.07a6 6 0 0 0 8.49 8.49l6.36-6.36a1 1 0 0 0-1.41-1.42l-6.37 6.37a4 4 0 0 1-5.65-5.66l7.07-7.07a2 2 0 0 1 2.83 2.83l-7.08 7.07a.99.99 0 0 1-1.4-1.41l7.7-7.7a1 1 0 0 0-1.42-1.41Z"),
    // Pushpin — Discord's own "Pinned messages" glyph tone; pins this window as a tab.
    pin: menuIcon("M19.38 11.38a3 3 0 0 0 0-4.24l-2.52-2.52a3 3 0 0 0-4.24 0l-1.06 1.06a1 1 0 0 0 0 1.42l.7.7-4.6 4.6a1 1 0 0 0 0 1.41l.36.36-2.83 2.83a2 2 0 0 0-.44.68l-1 2.5a1 1 0 0 0 1.3 1.3l2.5-1a2 2 0 0 0 .68-.44l2.83-2.83.36.36a1 1 0 0 0 1.41 0l4.6-4.6.7.7a1 1 0 0 0 1.42 0l1.06-1.06Z")
};

// ---------------------------------------------------------------------------
// Header "⋯ more" context menu — Discord-native Menu (ContextMenuApi). Holds
// only SECONDARY actions; the per-type toolbar already exposes zoom/page/etc.
// ---------------------------------------------------------------------------
function DockMoreMenu({ win }: { win?: DockWindow } = {}) {
    // The ⋯ menu is PARAMETERIZED by the tab's window `w`. A non-active tab's ⋯
    // opens this menu for THAT window and every action operates on it IN PLACE —
    // opening the menu never switches the active tab (no setActiveWindow). When no
    // window is passed (the lone-window header ⋯) it targets the active window.
    const w = win || activeWindow;
    const isActive = w === activeWindow;
    const url = w.content.url;
    const name = w.content.name as string | null;
    const type = w.content.type;
    const isHtml = type === "html";
    const isImage = type === "image";
    const isPdf = type === "pdf";

    const items: any[] = [];

    // Attach to message: stage THIS window's file as a pending upload on the active
    // channel (the native attachment chip). Shown whenever there's a file to attach
    // — text in memory (code/csv/unknown), inline artifact html, or a url
    // (pdf/image/markdown/artifact-from-url). attachActiveFile(w) picks the source.
    const canAttach = !w.content.loading && !w.content.error && w.content.name != null
        && (w.content.code != null || (isHtml && w.content.html != null) || url != null);
    if (canAttach) {
        items.push(React.createElement(Menu.MenuItem, {
            id: "dockview-more-attach",
            label: STRINGS.menu.attach,
            icon: MENU_ICON.attach,
            // For the ACTIVE window, open the inline filename bar (grammar rule 6) —
            // it's active-window header chrome — so the user picks/keeps a name. For
            // a NON-active tab there is no inline bar in its (hidden) header, so
            // attach THAT window's file directly under its own name.
            action: () => { if (isActive) openAttachBar(); else attachActiveFile(null, w); }
        }));
    }

    // Pin / Unpin: promote THIS window to a persistent TAB (survives channel
    // switches), or demote a pinned window back to the channel-bound transient. The
    // label reflects THIS window's pinned state. Shown whenever there's a window.
    items.push(React.createElement(Menu.MenuItem, {
        id: "dockview-more-pin",
        label: w.pinned ? STRINGS.menu.unpin : STRINGS.menu.pin,
        icon: MENU_ICON.pin,
        action: () => { if (w.pinned) unpinActiveWindow(w); else pinActiveWindow(w); }
    }));

    // PDF-only: "Fit to width" (reset zoom to 100%). A secondary control moved
    // off the header (spec §2.1 PDF "fit-width → ⋯"). Shown only when zoomed away
    // from fit, since at 100% it's a no-op. The header keeps the zoom group +/-.
    // The shared `pdfControls` only drive the VISIBLE active viewer, so this item
    // is offered only for the active window (a hidden tab has no live viewer).
    if (isActive && isPdf && w.content.pdf.doc != null && Math.round(w.pdfView.zoom * 100) !== 100) {
        items.push(React.createElement(Menu.MenuItem, {
            id: "dockview-more-fit-width",
            label: STRINGS.menu.fitToWidth,
            icon: MENU_ICON.fitWidth,
            action: () => pdfControls?.fitWidth()
        }));
    }

    // Open in browser: open the CURRENT file in a real IN-APP Vesktop window (선인's
    // default — an in-app window, NOT the external browser). ONE reliable path for
    // every viewer (correction-batch item (2)): openInVesktopWindow() builds the
    // per-type shell (artifact html / rendered markdown / <pre> text / <embed> pdf /
    // <img> image, embedding url-backed types by their working url — consolidating
    // copy-link's url, item (3)) and opens it via the empty-window + document.write
    // path, which rides Chromium's always-allowed about:blank rule so it's in-app
    // regardless of the "Open Links in app" setting. (The OLD code sent non-HTML
    // types to openExternalLink → the external OS browser, and a bare window.open
    // was a silent no-op — both fixed here.)
    items.push(React.createElement(Menu.MenuItem, {
        id: "dockview-more-popout",
        label: STRINGS.menu.openInNewWindow,
        icon: MENU_ICON.popout,
        action: () => openInVesktopWindow(w)
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
// ATTACH FILENAME BAR (2c-2) — a native inline filename input shown as a SECOND
// header row when the user picks ⋯ → "첨부하기" (or attaches a brand-new file).
//
// Discord grammar rule 6 (the "new thread name" pattern): the original filename
// is the input's PLACEHOLDER, so leaving it blank reuses that name; typing renames
// the staged file. A brand-new file (no original name) uses `message.md` as the
// placeholder. This is a minimal NATIVE-style inline input (NOT a custom modal):
// it occupies the same second-row strip the viewer controls use, so the card's
// flex-column layout flows the body below it with no offset math. Confirm = the
// real Discord primary (BRAND/blurple) Button (grammar rule 3); Cancel = a ghost
// text button (rule 4).
//
// The filename field is UNCONTROLLED (defaultValue + onChange), so typing it never
// re-renders — IME-safe — and keeps the onKeyDown stopPropagation so the panel's
// single-key shortcuts never eat a keystroke. `attachBarName` mirrors the typed
// value; Enter confirms, Esc cancels.
// ---------------------------------------------------------------------------

// When true the second header row is the attach filename bar (overrides the
// viewer controls strip). `attachBarName` mirrors the input's live value.
let attachBarOpen = false;
let attachBarName = "";

/** Open the attach filename bar for the currently-shown file. The placeholder is
 *  the file's own name; the user may rename or leave it blank. */
function openAttachBar() {
    attachBarOpen = true;
    attachBarName = "";
    forceRender?.();
}
function closeAttachBar() {
    attachBarOpen = false;
    attachBarName = "";
    forceRender?.();
}
/** Confirm the attach bar: stage the (possibly edited) buffer under the chosen
 *  name (blank → the file's own name), then close the bar. */
function confirmAttachBar() {
    attachActiveFile(attachBarName);
    closeAttachBar();
}

/** The placeholder for the attach filename input: the file's own name, or the
 *  new-file default (`message.md`) when there is none. */
function attachPlaceholderName(): string {
    return (activeWindow.content.name as string | null) || STRINGS.attach.defaultNewName;
}

/** The attach filename sub-toolbar (second header row): a native filename input
 *  (original name as placeholder, grammar rule 6) + a blurple Attach confirm + a
 *  ghost Cancel. */
function attachToolbar() {
    const placeholder = attachPlaceholderName();
    return React.createElement(
        "div",
        { className: "dockview-attach-toolbar" },
        React.createElement("input", {
            key: "attach-name-" + activeWindow.content.seq,
            className: "dockview-attach-name",
            type: "text",
            placeholder,
            "aria-label": STRINGS.attach.hint,
            // autoFocus so the rename field is ready the instant the bar opens.
            autoFocus: true,
            defaultValue: "",
            spellCheck: false,
            onChange: (e: any) => { attachBarName = e.target.value; },
            onKeyDown: (e: any) => {
                e.stopPropagation();
                if (e.key === "Enter") { e.preventDefault(); confirmAttachBar(); }
                else if (e.key === "Escape") { e.preventDefault(); closeAttachBar(); }
            }
        }),
        // Cancel: a ghost text button (grammar rule 4).
        React.createElement(
            "button",
            {
                key: "attach-cancel",
                type: "button",
                className: "dockview-attach-cancel",
                onClick: () => closeAttachBar()
            },
            STRINGS.attach.cancel
        ),
        // Attach: Discord's real primary (BRAND/blurple) button (grammar rule 3).
        React.createElement(
            Button,
            {
                className: "dockview-attach-confirm",
                color: Button.Colors.BRAND,
                size: Button.Sizes.SMALL,
                "aria-label": STRINGS.attach.hint,
                onClick: () => confirmAttachBar()
            },
            STRINGS.attach.confirm
        )
    );
}

// ---------------------------------------------------------------------------
// Tabs (pin-driven multi-window). The tabs live INSIDE the existing header TOP
// row — they ARE its icon/name slot — and are shown ONLY when ≥2 windows exist
// (the lone transient renders the plain icon+title instead, so the single-window
// case is byte-identical to before the multi-window work).
//
// "header = tab" model: each tab carries its OWN ⋯ + ✕ — there is NO shared
// far-right cluster when tabs are showing. The controls are PERSISTENT on EVERY
// tab (active AND inactive), always rendered at rest with NO hover/active gating,
// so every tab's width is STABLE — hovering or switching the active tab never
// changes any tab's width (no layout shift, the thing 선인 hates).
//   - EVERY tab: file glyph + name + ⋯ (opens THAT window's ⋯ menu IN PLACE) + ✕
//     (closes THAT window). Active vs inactive is shown ONLY by the underline +
//     bright/muted text, never by showing/hiding controls.
//   - ⋯ on a tab opens the menu PARAMETERIZED by THAT window — it does NOT switch
//     the active tab (no setActiveWindow), so a non-active tab's pin/attach/open
//     act on that window in place (선인: pressing ⋯ need not jump to that tab).
//   - ✕ closes THAT window directly (closeTab leaves the active binding alone for
//     a non-active tab, so it never switches to it first).
// Tabs are FLAT (icon + name), not boxed: the active tab gets a subtle underline +
// brighter text (Option B), NOT a bordered pill. No invented chrome.
// ---------------------------------------------------------------------------
const TAB_CLOSE_PATH = "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z";
const TAB_MORE_PATH = "M7 12.001C7 13.105 6.105 14 5 14C3.895 14 3 13.105 3 12.001C3 10.896 3.895 10.001 5 10.001C6.105 10.001 7 10.896 7 12.001ZM14 12.001C14 13.105 13.105 14 12 14C10.895 14 10 13.105 10 12.001C10 10.896 10.895 10.001 12 10.001C13.105 10.001 14 10.896 14 12.001ZM19 14C20.105 14 21 13.105 21 12.001C21 10.896 20.105 10.001 19 10.001C17.895 10.001 17 10.896 17 12.001C17 13.105 17.895 14 19 14Z";

/** A file-type glyph for a tab. SIZE PARITY with the single-window header's
 *  leading glyph (.dockview-header-icon = 20px): a tab must never shrink any
 *  element vs the pre-tab header — same 20px glyph, not a smaller 16px one. */
function tabIcon(type: ContentType) {
    return React.createElement(
        "svg",
        { className: "dockview-tab-icon", width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
        ...(FILE_TYPE_ICON[type] || FILE_TYPE_ICON.unknown).map(
            ([d, extra]: IconPath, i: number) =>
                React.createElement("path", { key: i, fill: "currentColor", d, ...(extra || {}) })
        )
    );
}

/** A per-tab ghost icon control (⋯ / ✕) — a flat, borderless icon button that
 *  lives at a tab's right edge. Distinct from the tab body so its click never
 *  bubbles into a tab switch. */
function tabCtrlBtn(opts: { key: string; cls: string; label: string; path: string; onClick: (e: any) => void; }) {
    return React.createElement(
        "button",
        {
            key: opts.key,
            type: "button",
            className: "dockview-tab-ctrl " + opts.cls,
            "aria-label": opts.label,
            title: opts.label,
            onClick: opts.onClick
        },
        React.createElement(
            // SIZE PARITY with the single-window header's ⋯/✕ icons (20px SVG in a
            // 32px iconWrapper). The tab control's SVG matches that 20px exactly — a
            // tab's ⋯/✕ must never read smaller than the pre-tab header's.
            "svg",
            { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: opts.path })
        )
    );
}

/** Tabs row. Every tab carries its OWN persistent ⋯ + ✕ acting on THAT window.
 *  `onCloseActive` is the active window's close path (resets the attach bar before
 *  closing) — the active tab's ✕ uses it; an inactive tab's ✕ uses closeTab(w.id)
 *  directly (no attach bar to reset on a hidden window). */
function DockTabs({ onCloseActive }: { onCloseActive: (e: any) => void; }) {
    return React.createElement(
        "div",
        { className: "dockview-tabs", role: "tablist" },
        ...windows.map(w => {
            const isActive = w.id === activeWindowId;
            const label = (w.content.name as string | null) || STRINGS.empty.text;
            return React.createElement(
                "div",
                {
                    key: w.id,
                    className: "dockview-tab" + (isActive ? " dockview-tab-active" : ""),
                    role: "tab",
                    "aria-selected": isActive,
                    title: label,
                    // Clicking the tab BODY (icon/name area) switches active.
                    onClick: () => switchToWindow(w.id)
                },
                tabIcon(w.content.type),
                React.createElement("span", { className: "dockview-tab-name" }, label),
                // Per-tab controls — PERSISTENT on every tab (no hover/active gating),
                // so tab widths are stable (no layout shift). The ⋯ opens THIS
                // window's menu IN PLACE (parameterized by `w`, NEVER setActiveWindow
                // → no tab switch). The ✕ closes THIS window.
                tabCtrlBtn({
                    key: "more",
                    cls: "dockview-tab-more",
                    label: STRINGS.header.more,
                    path: TAB_MORE_PATH,
                    onClick: (e: any) => {
                        e.stopPropagation();
                        ContextMenuApi.openContextMenu(e, () => React.createElement(DockMoreMenu, { win: w }));
                    }
                }),
                tabCtrlBtn({
                    key: "close",
                    cls: "dockview-tab-close",
                    label: STRINGS.header.close,
                    path: TAB_CLOSE_PATH,
                    onClick: (e: any) => {
                        e.stopPropagation();
                        if (isActive) onCloseActive(e); else closeTab(w.id);
                    }
                })
            );
        })
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

    const [width, setWidth] = useState(activeWindow.state.width);
    const resizing = useRef(false);

    useEffect(() => {
        activeWindow.state.width = width;
        lsSet(LS_WIDTH, String(Math.round(width)));
        applyOpenState();
    }, [width]);

    // After a cache RESTORE of a non-PDF file (code / image / iframe), re-apply
    // the saved scroll once the body DOM is committed. The PDF body restores its
    // OWN scroll after its lazy page boxes are built (it needs the column height
    // to exist first), so we skip it here.
    useEffect(() => {
        if (activeWindow.content.type !== "pdf") consumePendingScroll();
    });

    const onResizeStart = useCallback((e: any) => {
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        resizing.current = true;
        resizeDragging = true;
        const startX = e.clientX;
        const startWidth = activeWindow.state.width;
        // Width the rendered content currently assumes; the live PDF preview
        // scales by (newWidth / this). Use the clamped start width as the base.
        const baseWidth = clampWidth(startWidth);
        let liveScaled = false;
        // Capture the scroll anchor NOW, before the first --scale-factor change,
        // so the PDF live preview can hold the visible content stationary as the
        // page boxes rescale (no-op for non-PDF content).
        pdfControls?.beginLiveScale();

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
            // Clamp the drag so a docked panel can't grow past the chat's min
            // (native clamps the drag; floating is for a too-narrow window only).
            const next = clampDockDrag(startWidth + delta);
            if (next !== activeWindow.state.width) {
                activeWindow.state.width = next;
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
            const final = clampDockDrag(startWidth + delta);
            activeWindow.state.width = final;
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
        // The far-right ✕ closes the ACTIVE window (the one the ⋯ menu acts on).
        // With a lone window that IS the dock, so closeTab falls through to
        // closePanel() (member-list restore etc.) — byte-identical to the old
        // dock-level X. With ≥2 windows it closes just the active tab and
        // activates a neighbour. There is no separate dock-level X anymore;
        // this single ✕ is the ONE close path for the active window.
        attachBarOpen = false;
        closeTab(activeWindowId);
    }, []);

    const hasContent = activeWindow.content.name != null;
    // The TOP row is pure Discord grammar — the file-type glyph + the filename
    // title. A new file shows its default name (message.md) like any other file;
    // the rename/Attach controls live in the SECOND row, never up here.
    const title = hasContent ? (activeWindow.content.name as string) : "DockView";

    // Leading file-type glyph (mirrors a real thread header's [thread glyph] +
    // title structure). One muted, single-colour, document-framed icon per
    // content type so the header reads as "a file is docked here" at a glance.
    // Paths are built lazily here (React is ready now) from the plain-data map.
    const iconType = activeWindow.content.type;
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
            ...(FILE_TYPE_ICON[iconType] || FILE_TYPE_ICON.unknown).map(
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

    // The header grows to TWO rows whenever there's a second-row strip below the
    // top row: the attach filename bar (when open) OR a viewer's relocated
    // controls. The `--tworow` modifier releases the fixed 48px height so the
    // section fits both rows. The attach bar takes the slot over the controls.
    const showAttachBar = attachBarOpen && hasContent;
    const showViewerRow = !showAttachBar && hasViewerControls();
    const twoRow = showAttachBar || showViewerRow;

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
            // No separate tab-strip row: the tabs live INSIDE the existing top row
            // (the icon/name slot). The card's first child is the header section.
            React.createElement(
                "section",
                {
                    // Discord's native header container (`container__9293f`) is locked to a
                    // single 48px row with `justify-content:center`; our two-row header
                    // needs to GROW to fit the second-row strip, otherwise the upper title
                    // row overflows upward and gets clipped past the card's top edge (the
                    // title + close X slice off). `--tworow` releases the fixed height and
                    // top-aligns the rows.
                    className: `${CLS.headerSection} dockview-header`
                        + (twoRow ? " dockview-header--tworow" : "")
                },
                React.createElement(
                    "div",
                    {
                        className: `${CLS.upper} dockview-header-upper`
                            + (windows.length >= 2 ? " dockview-header-upper--tabs" : "")
                    },
                    React.createElement(
                        "div",
                        {
                            className: `${CLS.headerChildren} dockview-header-children`
                                + (windows.length >= 2 ? " dockview-header-children--tabs" : "")
                        },
                        // The icon/name slot of the LOCKED top row. With a lone window
                        // it is the plain [file-type glyph] + title (byte-identical to
                        // before the multi-window work — no tab chrome, no highlight).
                        // With ≥2 windows the SAME slot holds the flat tabs; each tab
                        // carries its OWN PERSISTENT ⋯/✕ acting on THAT window in
                        // place, so there is NO shared far-right cluster.
                        ...(windows.length >= 2
                            ? [React.createElement(DockTabs, {
                                onCloseActive: close
                            })]
                            : [
                                leadingIcon,
                                React.createElement(
                                    "h2",
                                    { className: `${CLS.title} dockview-title`, title },
                                    title
                                )
                            ])
                    ),
                    // The shared far-right ⋯/✕ cluster exists ONLY for the lone window
                    // (its plain header). With ≥2 tabs the ⋯/✕ live PER-TAB inside
                    // DockTabs (the active tab's), never shared — so we omit it.
                    windows.length >= 2
                        ? null
                        : React.createElement(
                            "div",
                            { className: `${CLS.toolbar} dockview-header-actions` },
                            // The top row is LOCKED to icon / name / ⋯ / X.
                            moreBtn,
                            closeBtn
                        )
                ),
                // SECOND ROW. Attach bar (when open): the filename input + Attach +
                // Cancel. Otherwise viewers (pdf/image/code/csv/md/artifact): the
                // per-type controls strip — relocated here so the top row stays
                // icon/name/⋯/X. Both are a sibling of the upper row inside
                // `.dockview-header`, so the card's flex-column layout flows the body
                // below with no offset math. Unknown has NO second row (no controls).
                showAttachBar
                    ? attachToolbar()
                    : showViewerRow
                        ? React.createElement(
                            "div",
                            { className: "dockview-viewer-toolbar" },
                            React.createElement(HeaderControls, null)
                        )
                        : null
            ),
            (() => {
                // The find box is a FLOATING browser-style Ctrl+F panel positioned
                // top-right OVER the body (grammar rule 7) — it does NOT inset the
                // scrolling body the way the old in-header find dropdown did. PDF and
                // every CM surface share the same FindBar component, each wired to its
                // viewer. The box sits last inside the (position:relative) body-wrap.
                const pdfFind = hasContent && activeWindow.content.type === "pdf" && activeWindow.pdfView.findOpen && activeWindow.content.pdf.doc;
                // Code find applies to plain code, a CSV viewed in RAW mode, and a
                // markdown / .artifact in EDIT mode — every case whose body is the
                // editable/read CM. The grid + rendered iframe views have no find.
                const codeFind = hasContent && activeWindow.codeView.findOpen && cmBodyShown();
                return React.createElement(
                    "div",
                    { className: "dockview-body-wrap" },
                    React.createElement(
                        "div",
                        {
                            // PDF gets a modifier so its body can scroll horizontally
                            // (a zoomed page overflows the width and must be pannable);
                            // every other viewer keeps overflow-x hidden (no h-scroll).
                            className: "dockview-body"
                                + (hasContent && activeWindow.content.type === "pdf" ? " dockview-body-pdf" : "")
                        },
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

// ---------------------------------------------------------------------------
// Native member-list collapse — behave EXACTLY like a real thread.
//
// Opening a real Discord thread makes Discord itself toggle the channel's member
// list OFF: the people-icon button in the channel header loses its lit
// (`selected__`) state and Discord hides/collapses the member aside. Closing the
// thread restores it. We reproduce that by dispatching Discord's OWN action
// (`CHANNEL_TOGGLE_MEMBERS_SECTION`, exposed as `toggleMembersSection()`), NOT by
// CSS-hiding the aside — a `display:none` would leave Discord thinking the list
// is still open, so the toggle button would stay LIT while the list is gone
// (the inconsistent cosmetic override this replaces).
//
// READ SIGNAL: the action flips a Flux flag that BOTH lights the button AND
// shows/hides the `membersWrap` aside. DOM presence alone is not reliable across
// Discord builds (a collapsed aside can remain mounted), so we key off the
// locale-independent aside class AND require it to be actually visible.
// (The button's lit class is `selected__`; aria-labels are localized.)
//
// EDGE-TRIGGERED: we only act from explicit open/close/channel-switch edges
// (toggle/load/onChannelSelect/start/stop), never from the high-frequency
// re-injection observer — so a typing-indicator tick can't make us fight the
// store, and a manual re-show by the user while the panel is open is honored
// (we don't re-collapse until the next explicit edge, just like a thread only
// re-collapses on the next navigation).
// ---------------------------------------------------------------------------

/** True ⟺ we collapsed the member list and owe a restore when the panel closes. */
let memberListRestorePending = false;

/** DM analogue of memberListRestorePending: true only when DockView itself
 *  collapsed the user-profile sidebar while opening. */
let profileSidebarRestorePending = false;

/** Set while WE are the ones firing `CHANNEL_TOGGLE_MEMBERS_SECTION` (our open-time
 *  collapse / close-time restore). The action is a pure, argument-less toggle that
 *  Discord ALSO fires when the user clicks the people-icon header button, and both
 *  go through the same FluxDispatcher — so the only way to tell our own dispatch
 *  apart from a real user click in the Flux subscriber is this flag. Flux dispatch
 *  is synchronous (the subscriber runs INSIDE dispatchMemberListToggle), so the
 *  flag is reliably true exactly for our own toggles and false for user clicks. */
let selfMemberToggle = false;

/** Same self-dispatch guard for DM user-profile sidebar toggles. */
let selfProfileToggle = false;

function elementIsActuallyVisible(el: HTMLElement): boolean {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;

    for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
        const style = getComputedStyle(cur);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
            return false;
        }
    }

    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
}

/** Is the server member list currently shown? Keyed off the `membersWrap` aside
 *  plus real visibility. A collapsed member list may remain mounted in the DOM;
 *  treating mere presence as "shown" causes DockView to skip the owed restore. */
function isMemberListShown(): boolean {
    return Array.from(document.querySelectorAll<HTMLElement>('aside[class*="membersWrap"]'))
        .some(elementIsActuallyVisible);
}

function isUserProfileSidebarShown(): boolean {
    return !!document.querySelector('aside[aria-labelledby^="user-profile-sidebar-heading"]');
}

function isThreadCard(el: Element | null) {
    return el instanceof HTMLElement && el.matches('div[class*="chatLayerWrapper"]');
}

function findNativeChannelSidebar(inner: HTMLElement | null = findPageInner()): HTMLElement | null {
    if (!inner) return null;
    for (const child of Array.from(inner.children) as HTMLElement[]) {
        if (child.id === HOST_ID) continue;
        if (isThreadCard(child)) return child;
        if (isThreadCard(child.firstElementChild)) return child;
    }
    return null;
}

/** Dispatch Discord's own member-list toggle (same action the header button and a
 *  thread fire). Resolved fresh each call so a late webpack chunk can't stale it.
 *  Flagged with `selfMemberToggle` so our Flux subscriber ignores the resulting
 *  synchronous CHANNEL_TOGGLE_MEMBERS_SECTION (it's us, not a user click). */
function dispatchMemberListToggle(): boolean {
    selfMemberToggle = true;
    try {
        const mod = (findByProps as any)?.("toggleMembersSection");
        if (mod && typeof mod.toggleMembersSection === "function") {
            mod.toggleMembersSection();
            return true;
        }
    } catch { /* ignore — fall through, panel still works without the collapse */ }
    finally { selfMemberToggle = false; }
    return false;
}

function dispatchUserProfileSidebarToggle(): boolean {
    selfProfileToggle = true;
    try {
        const mod = (findByProps as any)?.("toggleUserProfileSidebarSection");
        if (mod && typeof mod.toggleUserProfileSidebarSection === "function") {
            mod.toggleUserProfileSidebarSection();
            return true;
        }
    } catch { /* ignore — fall through, panel still works without the collapse */ }
    finally { selfProfileToggle = false; }
    return false;
}

function closeNativeChannelSidebar(): boolean {
    if (!findNativeChannelSidebar()) return false;
    try {
        const mod = (findByProps as any)?.("openThreadAsSidebar", "closeChannelSidebar");
        const baseChannelId = getCurrentChannelId();
        if (baseChannelId && mod && typeof mod.closeChannelSidebar === "function") {
            mod.closeChannelSidebar(baseChannelId);
            return true;
        }
    } catch { /* ignore — fallback hiding still prevents visual overlap */ }
    return false;
}

/** Drive the native member-list state to match the panel's open state.
 *  open=true  → if the list is shown, collapse it (button light goes off) and
 *               remember we owe a restore.
 *  open=false → if we collapsed it and it is still collapsed, restore it. If the
 *               user manually re-showed it meanwhile, leave their choice intact. */
function syncNativeMemberList(open: boolean) {
    if (open) {
        if (isMemberListShown() && dispatchMemberListToggle()) {
            memberListRestorePending = true;
        }
    } else if (memberListRestorePending) {
        // Only toggle back if it's still collapsed (avoid re-hiding a list the
        // user manually re-opened while the panel was up).
        if (!isMemberListShown()) dispatchMemberListToggle();
        memberListRestorePending = false;
    }
}

function syncNativeProfileSidebar(open: boolean) {
    if (open) {
        if (isUserProfileSidebarShown() && dispatchUserProfileSidebarToggle()) {
            profileSidebarRestorePending = true;
        }
    } else if (profileSidebarRestorePending) {
        if (!isUserProfileSidebarShown()) dispatchUserProfileSidebarToggle();
        profileSidebarRestorePending = false;
    }
}

// ---------------------------------------------------------------------------
// Reverse parity: a real thread and the member list are mutually exclusive, so
// clicking the people-icon header button while a THREAD is open CLOSES the
// thread (and shows members). Our panel sits in that same exclusive slot, so it
// must do the same: pressing the member-list button (or, in a DM, the
// user-profile sidebar button) while the panel is open CLOSES our panel and lets
// that sidebar take the slot. Driven off the Flux toggle actions (subscribed in
// index.tsx) rather than a button-DOM listener, so it survives Discord re-rendering
// the header and works regardless of locale.
// ---------------------------------------------------------------------------

/** Close the panel because something else (member list / user-profile sidebar)
 *  is taking over the exclusive right slot — exactly like opening the member list
 *  evicts a thread. This is the plain close path MINUS the member-list restore:
 *  the user just asked for that sidebar, so we must NOT re-collapse it. We clear
 *  memberListRestorePending so the normal close machinery can't undo their choice. */
function closeForExclusiveTakeover() {
    if (!dockHasWindows()) return;
    // We owe no restore: the user explicitly wants the sidebar now. Clearing this
    // BEFORE closing stops syncNativeMemberList/restoreHiddenMembers from fighting
    // them by re-hiding the list they just opened.
    memberListRestorePending = false;
    profileSidebarRestorePending = false;
    // The whole dock vacates the slot: close every window (pinned + transient).
    closeAllWindowsState();
    lsSet(LS_OPEN, "0");
    saveCurrentChannelState();
    applyOpenState(); // drops html.dockview-open → the sidebar is no longer CSS-hidden
    forceRender?.();
}

/** Mark every window closed + drop the lightbox + clear the transient slot's
 *  remembered-open. Pinned windows are REMOVED (the dock is being vacated as a
 *  whole — there is no per-tab close here). Used by the exclusive-takeover and
 *  the header-X close paths so closing the dock leaves no window to show. */
function closeAllWindowsState() {
    activeWindow.imgView.fullscreen = false;
    // Remove pinned tabs (the dock is closing entirely) and keep the lone
    // transient marked closed/empty so the single-window invariants hold.
    const transient = transientWindow();
    windows.length = 0;
    const t = transient || makeWindow({ pinned: false, ownerChannelId: currentChannelId });
    t.pinned = false;
    t.state.open = false;
    t.imgView.fullscreen = false;
    windows.push(t);
    setActiveWindow(t);
}

/** Flux subscriber for CHANNEL_TOGGLE_MEMBERS_SECTION. Fires for BOTH our own
 *  open/close dispatches and a real user click on the people-icon button. We only
 *  act on a genuine user click (selfMemberToggle === false) while the panel is
 *  open: that means the user is turning the member list ON in the slot our panel
 *  occupies, so we vacate it. The action carries no show/hide flag and the aside
 *  mounts a tick LATER (not synchronously in the handler), so we confirm the
 *  member list actually came up on the next macrotask before closing — guarding
 *  against any spurious toggle that would hide rather than show. */
export function onMemberSectionToggle() {
    if (selfMemberToggle) return;       // our own collapse/restore — ignore
    if (!dockHasWindows()) return;            // nothing of ours to evict
    // The aside isn't in the DOM yet at dispatch time; let Discord's store + render
    // settle, then confirm the member list is now shown before we yield the slot.
    // The mount lands ~a macrotask later, but the exact ordering vs. our timer is
    // not guaranteed, so we poll a couple of short ticks rather than risk missing
    // it on a single setTimeout(0) (a false negative = the panel wouldn't close).
    let tries = 0;
    const check = () => {
        if (!dockHasWindows()) return;        // closed meanwhile
        if (isMemberListShown()) { closeForExclusiveTakeover(); return; }
        if (++tries < 4) setTimeout(check, 24);
    };
    setTimeout(check, 0);
}

/** Flux subscriber for USER_PROFILE_SIDEBAR_TOGGLE_SECTION — the DM analog of the
 *  member-list button (it competes for the same exclusive right slot). We never
 *  dispatch this action ourselves, so there is no self-trigger to guard; any fire
 *  is a user click. When the panel is open, vacate the slot for the profile
 *  sidebar, same as for the member list. (Our open-state CSS already hides the
 *  profile sidebar, but without this the panel would otherwise just stay put.) */
export function onUserProfileSidebarToggle() {
    if (selfProfileToggle) return;
    if (!dockHasWindows()) return;
    closeForExclusiveTakeover();
}

/** Native thread/channel sidebar opened while DockView owns the right slot:
 *  vacate the slot and do not restore DockView when that sidebar later closes. */
export function onChannelSidebarView() {
    if (!dockHasWindows()) return;
    closeForExclusiveTakeover();
}

function clearExclusiveRightSlotHidden(root: ParentNode = document) {
    root.querySelectorAll<HTMLElement>(`[${EXCLUSIVE_HIDDEN_ATTR}]`)
        .forEach(el => el.removeAttribute(EXCLUSIVE_HIDDEN_ATTR));
}

function hideExclusiveRightSlot(inner: HTMLElement | null = findPageInner()) {
    clearExclusiveRightSlotHidden();
    if (!dockHasWindows() || !inner) return;

    const host = document.getElementById(HOST_ID);
    const mark = (el: Element | null) => {
        if (!(el instanceof HTMLElement)) return;
        if (el.id === HOST_ID || (host && host.contains(el))) return;
        el.setAttribute(EXCLUSIVE_HIDDEN_ATTR, "true");
    };

    inner.querySelectorAll<HTMLElement>('aside[aria-labelledby^="user-profile-sidebar-heading"]')
        .forEach(mark);

    const children = Array.from(inner.children) as HTMLElement[];
    for (const child of children) {
        if (child.id === HOST_ID) continue;
        if (isThreadCard(child) || isThreadCard(child.firstElementChild)) {
            mark(child);
            continue;
        }
        const next = child.nextElementSibling;
        if (
            child.children.length === 0
            && !(child.textContent || "").trim()
            && (isThreadCard(next) || isThreadCard(next?.firstElementChild ?? null))
        ) {
            mark(child);
        }
    }
}

function nodeMayContainExclusiveRightSlot(node: Node) {
    if (!(node instanceof HTMLElement)) return false;
    if (node.matches('aside[aria-labelledby^="user-profile-sidebar-heading"], div[class*="chatLayerWrapper"]')) return true;
    return !!node.querySelector('aside[aria-labelledby^="user-profile-sidebar-heading"], div[class*="chatLayerWrapper"]');
}

/** Reflect open/closed across the spacer host AND the exclusive right slot
 *  (server member list / DM user-profile panel / native thread sidebar).
 *
 *  Exclusion is applied by `hideExclusiveRightSlot()`, which marks the current
 *  native sidebar/thread nodes and lets CSS hide only those marked nodes. */
function applyOpenState() {
    const host = document.getElementById(HOST_ID);
    const inner = findPageInner();
    // Kept as a harmless debug/compat marker; the hide path below no longer
    // depends on this class because Discord may rewrite className while typing.
    if (inner) inner.classList.add("dockview-page-inner");

    if (dockHasWindows()) {
        if (host) {
            // Drive open/closed via a class (display:block !important) instead of
            // inline display — Discord's layout code intermittently resets our
            // injected sibling's inline `display` to none, but it never beats the
            // class rule. width/flex/mode all come from applyDockLayout() (below).
            host.classList.add("dockview-open");
        }
        // Kept for compatibility with any older debug CSS; the current sidebar
        // exclusion is the targeted data attribute set by hideExclusiveRightSlot.
        document.documentElement.classList.add("dockview-open");
    } else {
        if (host) host.classList.remove("dockview-open");
        document.documentElement.classList.remove("dockview-open");
    }
    // Geometry (docked-push + clamp, or floating-overlay) is owned by one place.
    applyDockLayout();
    hideExclusiveRightSlot(inner);
}

/** Width the message area shares with the dock = the page-inner flex container's
 *  inner width (chat + host are its flex children). This is robust to the server
 *  rail / channel sidebar being shown or hidden, because those sit OUTSIDE the
 *  page-inner div — its clientWidth is exactly the content area the two share.
 *  Falls back to a window-derived estimate before the inner div exists. */
function availableContentWidth(inner: HTMLElement | null): number {
    const cw = inner?.clientWidth || 0;
    if (cw > 0) return cw;
    // Pre-mount fallback: window minus a coarse left-chrome estimate.
    return Math.max(0, (window.innerWidth || 1280));
}

/** TWO-MODE geometry: decide docked (push) vs floating (overlay) from the shared
 *  content width and apply the host's width/flex/position accordingly. This is
 *  the SINGLE place the mode + clamp live; every entry point (open, channel
 *  switch, window resize, resize-drag) calls it.
 *
 *  Native parity:
 *   - DOCKED: the host stays an in-flow flex spacer that pushes the chat. The
 *     APPLIED width is clamped to keep the chat ≥ CHAT_MIN_WIDTH (and the dock
 *     ≥ DOCK_MIN_WIDTH) — we never overwrite the user's intended `dockWidth`,
 *     only what is painted, so the dock restores its full width when the window
 *     grows again (exactly like native).
 *   - FLOATING: triggered only when even DOCK_MIN_WIDTH can't fit beside
 *     CHAT_MIN_WIDTH (the WINDOW is too narrow). The host is taken out of flow
 *     (position:absolute via .dockview-host--floating) so the chat reclaims FULL
 *     width underneath; the card overlays from the content's right edge at a
 *     width capped to leave a clickable chat sliver. No resize handle in this
 *     mode (CSS hides it under the floating class). */
function applyDockLayout() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    if (!dockHasWindows()) {
        // Closed: leave no floating mark behind and drop the inline geometry.
        host.classList.remove("dockview-host--floating");
        return;
    }

    const inner = findPageInner();
    const avail = availableContentWidth(inner);
    const want = activeWindow.state.width; // the user's intended (persisted) width

    // Floating ⟺ even the dock's minimum can't sit beside the chat's minimum.
    const floating = avail > 0 && (avail - DOCK_MIN_WIDTH) < CHAT_MIN_WIDTH;

    if (floating) {
        // Overlay: width fits the content and leaves a chat sliver clickable.
        const maxFloat = Math.max(DOCK_MIN_WIDTH, avail - FLOAT_CHAT_SLIVER);
        const applied = Math.max(DOCK_MIN_WIDTH, Math.min(want, maxFloat));
        host.classList.add("dockview-host--floating");
        // position:absolute (from the class) takes the host out of the flex row;
        // width is the overlay width. flex is reset so it contributes nothing.
        host.style.flex = "0 0 auto";
        host.style.width = `${applied}px`;
    } else {
        // Docked push + clamp: keep the chat ≥ its min while docked, but never
        // below the dock's own min. Only the APPLIED width is clamped.
        host.classList.remove("dockview-host--floating");
        let applied = want;
        if (avail > 0) {
            const maxDocked = avail - CHAT_MIN_WIDTH;
            applied = Math.min(want, maxDocked);
            applied = Math.max(applied, DOCK_MIN_WIDTH);
        }
        host.style.flex = `0 0 ${applied}px`;
        host.style.width = `${applied}px`;
    }
}

/** Write ONLY the host's geometry from state.width, nothing else. Used in the
 *  resize drag's rAF loop so a width change is a single cheap layout pass (no
 *  React render, no document-class / page-inner work like applyOpenState). The
 *  mode/clamp recompute lives in applyDockLayout(), so a drag re-evaluates the
 *  mode live too. */
function applyHostWidth() {
    applyDockLayout();
}

/** Drop the document state class (restoring any preemptively-hidden DM profile /
 *  thread sidebar) and the page-inner tag, AND restore the natively-collapsed
 *  member list, so no DockView marks linger after the plugin stops. Used on
 *  plugin stop; a normal close goes through applyOpenState + syncNativeMemberList. */
function restoreHiddenMembers() {
    document.documentElement.classList.remove("dockview-open");
    document.querySelectorAll(".dockview-page-inner").forEach(el => el.classList.remove("dockview-page-inner"));
    clearExclusiveRightSlotHidden();
    syncNativeMemberList(false); // un-collapse the member list if we collapsed it
    syncNativeProfileSidebar(false);
}

/** Close the panel — the side-effects run by the header X (close useCallback).
 *  Persists open:false, restores the native sidebars/member list we collapsed,
 *  and re-renders. */
function closePanel() {
    // The header X closes the WHOLE dock (every tab — pinned + transient): "close"
    // means no windows left, and the dock vacates the right slot.
    closeAllWindowsState();
    lsSet(LS_OPEN, "0");
    saveCurrentChannelState();
    applyOpenState();
    syncNativeMemberList(false);
    syncNativeProfileSidebar(false);
    forceRender?.();
}

function toggle() {
    const open = !dockHasWindows();
    if (open) {
        closeNativeChannelSidebar();
        // Re-open the lone transient (the toggle never resurrects pinned tabs that
        // were closed; pin-driven tabs are created by opening files + pinning).
        const t = transientWindow() || (() => { const w = makeWindow({ pinned: false, ownerChannelId: currentChannelId }); windows.push(w); return w; })();
        t.state.open = true;
        setActiveWindow(t);
        ensureHost();
    } else {
        closeAllWindowsState();
    }
    lsSet(LS_OPEN, open ? "1" : "0");
    saveCurrentChannelState();
    applyOpenState();
    syncNativeMemberList(open); // collapse the member list like a thread / restore on close
    syncNativeProfileSidebar(open);
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
    observer = new MutationObserver(records => {
        if (dockHasWindows() && records.some(r =>
            r.target === observedParent
            || Array.from(r.addedNodes).some(nodeMayContainExclusiveRightSlot)
        )) {
            hideExclusiveRightSlot();
        }
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
// MCP bridge WebSocket + its single pending reconnect timer (lazy — never opened
// at module eval; startMcpClient() opens it from startPanel, stopMcpClient() tears
// it down from stopPanel).
let mcpSocket: WebSocket | null = null;
let mcpReconnect: any = null;
// resources/read correlation: ws read id -> the render directive awaiting its HTML.
let mcpReadSeq = 0;
const mcpPendingReads = new Map<number, { resourceUri: string; tool: any; result: any }>();
// Claude-artifact runtime source, fetched lazily (NEVER at module eval) from the
// bridge's http server on first `artifact` directive and cached for reuse so the
// ~1.7MB runtime is sent over the wire at most once per session.
let mcpRuntime: string | null = null;

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

/** Render a Claude-artifact directive's TSX `code` with the cached runtime. Inlines
 *  the runtime + a call to window.__renderArtifact(code, {}) into a self-contained
 *  HTML doc and renders it through renderMcpApp (sandboxed iframe, allow-scripts only,
 *  nonced inline scripts). The runtime (mcpRuntime) is already "<script"-neutralized
 *  by the bridge, so loadMcpApp→injectNonce only stamps the real top-level <script>
 *  we add here. The TSX `code` is "</script"-neutralized so a literal closing tag in
 *  the source can't break the HTML parser (\/=/, identical to the browser). The
 *  dormant MCP-Apps handshake is harmless: no tool-input/result is pushed. */
function renderArtifactCode(msg: any) {
    if (mcpRuntime == null) return;
    const code = String(msg.code).replaceAll("</script", "<\\/script");
    const body = "<!doctype html><html><head><meta charset=utf-8></head>"
        + "<body style=\"margin:0;background:#1e1f22\"><div id=\"root\">loading…</div>"
        + "<script>" + mcpRuntime + "\nwindow.__renderArtifact(" + JSON.stringify(code) + ",{});</script>"
        + "</body></html>";
    try { renderMcpApp({ id: "artifact:" + (msg.name || "artifact"), html: body }); } catch { /* ignore */ }
}

/** Open (or re-open) the MCP bridge WebSocket. Reads the enable toggle / token /
 *  port from Vencord settings AT CONNECT TIME (never at module eval) — Discord
 *  deletes localStorage in the renderer, so the connect info lives in Vencord's
 *  own store. With the bridge disabled or no token we just log and stay
 *  disconnected. Sends the hello handshake on open, then speaks the MCP-Apps host
 *  ws protocol: on `render` it fetches the ui:// resource via `read`, renders it
 *  with renderMcpApp, and (after the frame's handshake) pushes tool-input/result;
 *  `call.res` resolves a proxied tools/call by replying to the originating frame.
 *  Schedules a single reconnect on close/error (unless we're shutting down).
 *  Guards against a double connect when a socket is already OPEN/CONNECTING. */
function startMcpClient() {
    if (!active) return; // don't reconnect after stopPanel
    if (mcpSocket && (mcpSocket.readyState === WebSocket.OPEN || mcpSocket.readyState === WebSocket.CONNECTING)) return;
    if (!settings.store.mcpBridgeEnabled) {
        console.debug("[dockview] mcp: bridge disabled in settings — not connecting");
        return;
    }
    const token = settings.store.mcpBridgeToken;
    if (!token) {
        console.debug("[dockview] mcp: no bridge token in settings — not connecting");
        return;
    }
    let sock: WebSocket;
    try {
        sock = new WebSocket(`ws://127.0.0.1:${settings.store.mcpBridgePort || 9820}`);
    } catch (e) {
        console.debug("[dockview] mcp: connect failed", e);
        return;
    }
    mcpSocket = sock;
    sock.addEventListener("open", () => {
        try { sock.send(JSON.stringify({ type: "hello", token })); } catch { /* ignore */ }
    });
    sock.addEventListener("message", (ev: MessageEvent) => {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "render" && msg.resourceUri) {
            // Fetch the ui:// resource's HTML; remember the launching tool so it can
            // be pushed to the frame once it renders + completes its handshake.
            const readId = ++mcpReadSeq;
            mcpPendingReads.set(readId, { resourceUri: msg.resourceUri, tool: msg.tool || null, result: msg.result });
            try { sock.send(JSON.stringify({ type: "read", id: readId, uri: msg.resourceUri })); } catch { mcpPendingReads.delete(readId); }
        } else if (msg.type === "read.res") {
            const req = mcpPendingReads.get(msg.id);
            if (!req) return;
            mcpPendingReads.delete(msg.id);
            const c = Array.isArray(msg.contents) ? msg.contents[0] : null;
            const html = c && typeof c.text === "string" ? c.text : null;
            if (html == null) return;
            try {
                renderMcpApp({
                    id: req.resourceUri,
                    html,
                    toolArguments: req.tool ? req.tool.arguments : undefined,
                    toolResult: req.result
                });
            } catch { /* ignore */ }
        } else if (msg.type === "call.res") {
            const pending = mcpPendingCalls.get(msg.id);
            if (!pending) return;
            mcpPendingCalls.delete(msg.id);
            mcpReplyResult(pending.win, pending.rpcId, msg.result);
        } else if (msg.type === "open") {
            // Plain artifact push (not an MCP App): the server asks the dock to
            // open ordinary content (html/markdown/code/pdf/image/csv) the same way
            // a chip click / __dockView.load would — no widget handshake involved.
            try { load({ name: msg.name || "artifact", html: msg.html ?? null, url: msg.url ?? null, type: msg.type2 ?? undefined }); } catch { /* ignore */ }
        } else if (msg.type === "artifact" && typeof msg.code === "string") {
            // Claude-artifact push: render TSX `msg.code` with the artifact runtime.
            // The runtime is large (~1.7MB), so fetch it lazily on the first artifact
            // and cache it — later artifacts reuse the cached source and never re-fetch.
            if (mcpRuntime != null) {
                renderArtifactCode(msg);
            } else {
                // The runtime lives on the bridge's http server, which is the ws port
                // + 1 (the bridge's PUSH_PORT — settings only stores the ws port).
                const httpPort = (settings.store.mcpBridgePort || 9820) + 1;
                fetch(`http://127.0.0.1:${httpPort}/runtime.js`)
                    .then(r => r.text())
                    .then(t => { mcpRuntime = t; renderArtifactCode(msg); })
                    .catch(e => console.debug("[dockview] mcp: runtime fetch failed", e));
            }
        }
    });
    const reschedule = () => {
        if (mcpSocket === sock) mcpSocket = null;
        if (!active) return; // shutting down — no reconnect
        clearTimeout(mcpReconnect);
        mcpReconnect = setTimeout(startMcpClient, 3000);
    };
    sock.addEventListener("close", reschedule);
    sock.addEventListener("error", reschedule);
}

/** Tear the MCP bridge down: cancel any pending reconnect and close the socket.
 *  In-flight ws read/call correlations are dropped (no socket to answer them). */
function stopMcpClient() {
    clearTimeout(mcpReconnect);
    mcpReconnect = null;
    try { mcpSocket?.close(); } catch { /* ignore */ }
    mcpSocket = null;
    mcpPendingReads.clear();
    mcpPendingCalls.clear();
}

/** Reconnect the bridge after a settings change. No-op safe when the panel
 *  isn't running (the `active` guard means stop+start collapse to just stop).
 *  Called from settings.ts's onChange via a lazy import (cycle-free). */
export function restartMcpClient() {
    if (!active) return;
    stopMcpClient();
    startMcpClient();
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
        if (!dockHasWindows()) return;
        const host = document.getElementById(HOST_ID);
        if (!host) return;
        // The dock panel must hold keyboard focus (the user clicked/tabbed into
        // it). Hovering is NOT enough — otherwise a mouse merely resting over the
        // docked panel would let the viewer swallow keys typed into chat. The PDF
        // body and image wrap are tabIndex=0, so a click focuses them.
        const ae = document.activeElement as HTMLElement | null;
        const focused = host.contains(ae);
        if (!focused) return;

        // Ctrl/Cmd+F — open (and focus) the floating find box, or jump to the next
        // match if it's already open. This MUST run BEFORE the editable-target bail
        // below: the CM body's `.cm-content` reports as editable (it's a read-only
        // contenteditable), so a focus inside the code/CSV-raw/edit surface would
        // otherwise swallow Ctrl+F and the box would never open while you're reading
        // the file — the exact moment you want to find. Discord may eat the global
        // Ctrl+F, so we own it whenever the dock holds focus. (Esc/Enter/Shift+Enter
        // are handled by the find input itself once it's focused.)
        if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
            if (activeWindow.content.type === "pdf" && pdfControls && activeWindow.content.pdf?.doc) {
                e.preventDefault();
                if (!activeWindow.pdfView.findOpen) pdfControls.toggleFind();
                else pdfControls.findNext();
                return;
            }
            if (cmBodyShown()) {
                e.preventDefault();
                if (!activeWindow.codeView.findOpen) toggleCodeFind();
                else if (activeWindow.codeView.findMatches) codeCtrl?.focusMatch(activeWindow.codeView.findActive % activeWindow.codeView.findMatches);
                else focusFindBox();
                return;
            }
            // any other body (image / md-rendered / csv-grid): no find target —
            // fall through (the box never opens where the row-2 icon is dimmed).
        }

        // Belt-and-braces: if focus is on a text field (the panel's own find /
        // page-jump inputs, or anything editable), single-key shortcuts must not
        // fire. The panel inputs also stopPropagation, this is the backstop.
        if (isEditableTarget(ae)) return;

        // PDF branch: with NO modifier, ←/→ or PageUp/PageDown for page nav, +/-
        // zoom. (Ctrl+F find is handled by the shared block above, before the
        // editable bail, so it works whatever the dock-internal focus is.)
        if (activeWindow.content.type === "pdf" && pdfControls) {
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

        // CM bodies (code / CSV-raw / markdown-edit / artifact-edit) have no other
        // single-key shortcuts; their Ctrl+F is handled by the shared block above.
        if (cmBodyShown()) return;

        // Image zoom keys — only when no modifier.
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (activeWindow.content.type !== "image" || !imgControls) return;
        if (e.key === "+" || e.key === "=") {
            e.preventDefault();
            imgControls.zoomIn();
        } else if (e.key === "-" || e.key === "_") {
            e.preventDefault();
            imgControls.zoomOut();
        } else if (e.key === "0") {
            e.preventDefault();
            imgControls.reset();
        } else if (e.key === "f" || e.key === "F") {
            // Toggle the fullscreen lightbox (IMG-2). Esc closes it from anywhere
            // (the overlay binds its own capture handler); 'f' toggles from the
            // focused panel like the other single-key image shortcuts.
            e.preventDefault();
            imgControls.toggleFullscreen();
        } else if (e.key === "ArrowLeft") {
            // Step to the previous channel image (inline; the lightbox handles its
            // own ←/→ at capture and stops propagation, so this is inline-only).
            if (galleryCanStep(-1)) { e.preventDefault(); galleryStep(-1); }
        } else if (e.key === "ArrowRight") {
            if (galleryCanStep(1)) { e.preventDefault(); galleryStep(1); }
        }
    };
    window.addEventListener("keydown", onKeyDown);

    // On every window resize: re-evaluate the docked/floating mode + clamp (a
    // window that narrows must flip a wide dock to floating even if the PERSISTED
    // width doesn't change — applyDockLayout clamps only what is applied, never
    // the user's intended width, so the dock restores its width when the window
    // grows again). Also hard-re-clamp the persisted width to the legacy bound
    // (innerWidth*0.6) so a stored value can never exceed the window itself.
    onResize = () => {
        if (!dockHasWindows()) return;
        const w = clampWidth(activeWindow.state.width);
        if (w !== activeWindow.state.width) {
            activeWindow.state.width = w;
            forceRender?.();
        }
        applyDockLayout();
    };
    window.addEventListener("resize", onResize);

    // Markdown/artifact sandbox iframes postMessage link clicks up to us; open
    // them in the external browser instead of navigating inside the sandbox.
    onMessage = (e: MessageEvent) => {
        const d = e?.data;
        if (d && typeof d === "object" && typeof d.__dockViewOpenLink === "string") {
            openExternalLink(d.__dockViewOpenLink);
            return;
        }
        // MCP-app frame → host. iframe ↔ host is raw JSON-RPC 2.0 over postMessage
        // (the message IS the JSON-RPC object). The sandbox has no allow-same-origin,
        // so event.origin is "null" — never gate on it; identify the sending app by
        // matching event.source to a registered frame contentWindow, then route the
        // request/notification through the MCP-Apps host handler.
        if (d && typeof d === "object" && d.jsonrpc === "2.0" && typeof d.method === "string") {
            const appId = mcpAppIdForSource(e.source);
            if (appId) {
                handleMcpFrameMessage(appId, e.source as Window, d);
            }
        }
    };
    window.addEventListener("message", onMessage);

    // Open the MCP bridge (no-op when disabled or no token is set in settings).
    startMcpClient();

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
    // 2b. MCP bridge socket + its pending reconnect (active already false above,
    //     so no callback re-opens it).
    stopMcpClient();
    mcpFrames.clear();
    mcpSessions.clear();
    // 3. observer + its debounce
    observer?.disconnect();
    observer = null;
    observedParent = null;
    clearTimeout(debounce);
    debounce = null;
    // 4. close panel state + restore the member list (mutual-exclusion undo).
    //    Collapse the window collection back to a single closed transient so a
    //    re-start begins from the clean single-window state.
    windows.length = 0;
    const w0 = makeWindow({ pinned: false, ownerChannelId: null });
    w0.state.open = false;
    windows.push(w0);
    setActiveWindow(w0);
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
    activeWindow.activeDescriptor = null;
    // 8. reset the persistence latch so a re-start re-loads from DataStore. The
    //    mirror itself is kept (already-correct values) but writes are paused
    //    until the next loadPersistedState resolves.
    persistLoaded = false;
}

// Debug surface: a single neutral window handle so manual console testing
// still works. Removed again on stop().
export function exposeDebug() {
    (window as any).__dockView = {
        // The DockWindow itself, plus the per-window fields mapped back onto it so
        // the historical debug getters (state/content/*View) read the LIVE active
        // window via getters (it's reassigned on every tab switch — a captured
        // snapshot would go stale).
        get activeWindow() { return activeWindow; },
        toggle, ensureHost, applyOpenState, get state() { return activeWindow.state; }, DockPanel, CLS, findPageInner,
        onChannelSelect, getCurrentChannelId, channelStates,
        load, retry: retryActiveLoad, clear: clearArtifact, popout: popoutArtifact, get content() { return activeWindow.content; }, detectType,
        // "Open in browser" (in-app Vesktop window) debug surface.
        openInVesktopWindow, vesktopWindowHtml,
        contentCache, get loadSeq() { return loadSeq; }, get activeCacheKey() { return activeWindow.activeCacheKey; },
        get pdfView() { return activeWindow.pdfView; }, get pdfControls() { return pdfControls; },
        get imgView() { return activeWindow.imgView; }, get imgControls() { return imgControls; },
        // image gallery (prev/next) debug surface: drive + assert the nav.
        get gallery() { return activeWindow.gallery; }, refreshGallery, galleryStep, galleryCanStep,
        get galleryIndex() { return galleryCurrentIndex(); },
        get memberListShown() { return isMemberListShown(); },
        get memberListRestorePending() { return memberListRestorePending; },
        get profileSidebarShown() { return isUserProfileSidebarShown(); },
        get profileSidebarRestorePending() { return profileSidebarRestorePending; },
        get selfMemberToggle() { return selfMemberToggle; },
        get selfProfileToggle() { return selfProfileToggle; },
        closeNativeChannelSidebar,
        onMemberSectionToggle, onUserProfileSidebarToggle, onChannelSidebarView, closeForExclusiveTakeover,
        attachActiveFile, onNewFile,
        // multi-window (pin-driven tabs) debug surface: the window collection +
        // the tab actions so CDP can drive pin/unpin/switch/close + assert state.
        get windows() { return windows; }, get activeWindowId() { return activeWindowId; },
        get dockOpen() { return dockHasWindows(); },
        switchToWindow, pinActiveWindow, unpinActiveWindow, closeTab, transientWindow,
        // 2c attach + new-file debug surface: the attach filename bar + the
        // new-file flags so CDP can drive the attach-edited-buffer + new-file paths.
        openAttachBar, closeAttachBar, confirmAttachBar,
        get attachBarOpen() { return attachBarOpen; }, set attachBarName(v: string) { attachBarName = v; },
        get isNewFile() { return getIsNewFile(); },
        // 2b editable-surface debug surface: the mode toggles + the buffer so CDP
        // can drive edit-mode + assert the temporary buffer / re-render loop.
        get editView() { return activeWindow.editView; }, get csvView() { return activeWindow.csvView; }, toggleEditMode, toggleCsvMode, toggleCodeFind,
        get editBuffer() { return editBufferText(); }, get codeCtrl() { return codeCtrl; },
        // MCP Apps host surface debug: render a widget + drive/inspect the bridge +
        // peek the live frame/session registries and pending ws correlations.
        renderMcpApp, startMcpClient, stopMcpClient, restartMcpClient, get mcpView() { return activeWindow.mcpView; },
        get mcpFrames() { return mcpFrames; }, get mcpSessions() { return mcpSessions; },
        get mcpPendingReads() { return mcpPendingReads; }, get mcpPendingCalls() { return mcpPendingCalls; }
    };
}
export function unexposeDebug() {
    try { delete (window as any).__dockView; } catch { /* ignore */ }
}
