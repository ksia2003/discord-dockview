/*
 * The DockView contract.
 *
 * Every module in the plugin agrees on the shapes declared here. The engine is
 * format-agnostic: it knows about windows, a content cache, and a Viewer
 * interface, but nothing about what a PDF or a spreadsheet actually is. Each
 * viewer under viewers/ implements Viewer and registers itself; adding a new
 * file format is one new module plus one line in the registry.
 *
 * The data shapes (PanelContent, CacheEntry, the per-viewer view-state
 * interfaces) mirror the field names of the original single-file plugin so the
 * port stays mechanical.
 */

/** A dock body or toolbar — a React function component. Typed structurally so
 *  this contract file stays import-free (the runtime React comes from
 *  @webpack/common in the modules that actually render). */
export type ViewerComponent = (props?: any) => any;

/** Every file format the dock can render. "unknown" is the fallback. */
export type ContentType =
    | "html"
    | "pdf"
    | "code"
    | "markdown"
    | "image"
    | "audio"
    | "video"
    | "unknown"
    | "csv"
    | "mcpapp"
    | "docx"
    | "rtf"
    | "odt"
    | "odp"
    | "xlsx"
    | "mermaid"
    | "graphviz"
    | "ipynb"
    | "structured"
    | "rasterimage"
    | "model3d"
    | "dxf"
    | "pptx"
    | "email"
    | "msg"
    | "raw"
    | "dicom"
    | "postscript";

// ── panel content ───────────────────────────────────────────────────────────

export interface PdfState {
    doc: any | null; // pdf.js PDFDocumentProxy
    pages: number;
    renderToken: number; // bumped per pdf load so a stale render aborts
}

/** The parsed 3D model handed from the loader to the body. `object` is the three.js
 *  root (THREE.Object3D) the loader produced; the body adds it to a Scene, frames a
 *  camera around its bounding box, and runs the WebGLRenderer. Kept opaque (`any`)
 *  so this contract file never imports three. `renderToken` bumps per load so a
 *  superseded body drops the stale object. The object's geometries/materials are
 *  released by the viewer's dispose() on cache eviction. */
export interface Model3DState {
    object: any | null; // THREE.Object3D root (or null before/after load)
    renderToken: number;
}

/** The parsed presentation handed from the loader to the body. The loader runs the
 *  renderer's DOM-free parse (parseZip → buildPresentation → PresentationData), so the
 *  body only has to mount a viewer over the already-parsed model — mirroring how the
 *  pdf/3D loaders persist the heavy parsed handle and the body just renders it. Kept
 *  opaque (`any` = @aiden0z/pptx-renderer's PresentationData) so this contract file
 *  never imports the renderer. The model is owned by the CACHE ENTRY
 *  (entry.pptxPresentation), kept alive while cached so a re-open is instant; it holds
 *  no GPU/worker handle (just decoded slide data + media bytes), so it needs no
 *  dispose() — the live viewer instance + its blob: URLs are body-owned and torn down
 *  on unmount. `renderToken` bumps per load so a superseded body drops the stale deck. */
export interface PptxState {
    presentation: any | null;
    renderToken: number;
}

/** A parsed workbook handed from the xlsx loader to the body. SheetJS reads the
 *  whole workbook once; the loader serialises EVERY sheet to CSV text and keeps the
 *  ordered sheet names + the per-sheet CSV here, so the body can switch sheets with
 *  no re-fetch/re-parse. Owned by the CACHE ENTRY (entry.xlsxWorkbook), kept alive
 *  while cached so a re-open is instant — plain decoded text, no GPU/worker handle,
 *  so no dispose() is needed. The xlsx body feeds the active sheet's CSV into the
 *  existing csv grid; `names`/`csv` stay parallel arrays (csv[i] is names[i]'s text).
 *  renderToken bumps per load so a superseded body drops the stale workbook. */
export interface XlsxState {
    names: string[]; // ordered sheet names (workbook order)
    csv: string[]; // csv[i] = sheet names[i] serialised to RFC-4180 CSV text
    renderToken: number;
}

/** What is currently loaded into a window. `seq` is bumped on every (re)load and
 *  on a sub-view swap (grid↔raw, rendered↔edit) so React remounts the body. */
export interface PanelContent {
    name: string | null;
    type: ContentType;
    html: string | null;
    frameHtml: string | null;
    pdf: PdfState;
    model3d: Model3DState;
    pptx: PptxState;
    xlsx: XlsxState;
    code: string | null;
    codeLang: string;
    url: string | null;
    loading: boolean;
    /** Optional label shown by LoadingBody while a heavy viewer library spins up
     *  ("Loading HEIC decoder…"). null → the generic "Loading…" copy. Set via
     *  engine/lazyLib withLibLoading and always cleared when the lib resolves. */
    loadingLabel: string | null;
    error: string | null;
    binary: boolean; // an "unknown" file sniffed as binary → unsupported fallback
    seq: number;
}

// ── per-viewer view-state ────────────────────────────────────────────────────
// Each viewer owns one of these. The engine stores them opaquely in
// DockWindow.viewStates keyed by ContentType; a viewer casts its own slice.

export type PdfFit = "width" | "page";
export type PdfDragMode = "text" | "pan";

export interface PdfViewState {
    page: number;
    total: number;
    fit: PdfFit;
    zoom: number;
    dragMode: PdfDragMode;
    rotation: number; // 0 | 90 | 180 | 270 — clockwise page rotation (PDF-4)
    findOpen: boolean;
    findQuery: string;
    findMatches: number;
    findActive: number; // 1-based index of the active match (0 = none)
    findCase: boolean;
}

export interface ImgViewState {
    scale: number;
    tx: number;
    ty: number;
    natW: number;
    natH: number;
    rotation: number; // 0 | 90 | 180 | 270 — clockwise image rotation (IMG-3)
    fullscreen: boolean;
}

/** The raster viewer's per-window view-state: the current PAGE of a multi-page TIFF
 *  (1-based) + the total page count. Single-page raster files (psd/heic/single TIFF)
 *  retype to "image" and never reach this slice; only a multi-page TIFF keeps its
 *  "rasterimage" surface and drives a page selector off these numbers. `total` is 1
 *  until the loader has counted the TIFF's IFDs. Parked on the cache entry so a
 *  return reopens the same page. */
export interface RasterViewState {
    page: number; // 1-based current page
    total: number; // page count (1 = single page, no nav chrome)
}

export interface CodeViewState {
    findOpen: boolean;
    findQuery: string;
    findMatches: number;
    findActive: number;
    findCase: boolean;
}

export interface CsvViewState {
    mode: "grid" | "raw";
    delimiter: string; // "," for csv, "\t" for tsv (decided at load)
}

export interface TreeViewState {
    mode: "tree" | "raw";
    kind: "json" | "xml";
}

export interface McpAppViewState {
    appId: string | null;
}

/** The 3D viewer's per-window view-state: the OrbitControls camera pose, so a cache
 *  return reopens the model at the same angle/zoom the user left it. All optional —
 *  a fresh open auto-frames the model and writes these from the framed camera. */
export interface Model3DViewState {
    // camera position + the orbit target, in world space (3 numbers each).
    camPos: [number, number, number] | null;
    target: [number, number, number] | null;
}

/** The pptx viewer's per-window view-state: the current slide (1-based) + the total,
 *  driving the header's slide counter + prev/next, and parked on the cache entry so a
 *  return reopens the deck on the same slide. `total` is 0 until the deck's slide count
 *  is known (the body fills it once the renderer parses the presentation). */
export interface PptxViewState {
    slide: number;
    total: number;
}

/** The xlsx viewer's per-window view-state: which sheet is selected (0-based index
 *  into the workbook's parallel names/csv arrays) plus a copy of the sheet names so
 *  the bottom tab strip can render before the parsed workbook is on hand (and so a
 *  cache restore knows the tab labels). Parked on the cache entry so a return reopens
 *  the workbook on the same sheet. `sheet` is clamped into range by the loader. */
export interface XlsxViewState {
    sheet: number; // 0-based selected sheet index
    names: string[]; // ordered sheet names (mirrors the workbook), for the tab strip
}

// ── cross-cutting capability state (NOT viewer-owned) ────────────────────────
// edit-mode rides over the text-family viewers; the gallery rides over the image
// viewer. They live as named slots on the window, owned by edit/ and
// viewers/image/ respectively — never by the engine.

export interface EditViewState {
    mode: "view" | "edit";
    editBuffer: string | null;
}

export interface GalleryEntry {
    messageId: string;
    url: string;
    name: string;
}

export interface GalleryState {
    channelId: string | null;
    items: GalleryEntry[];
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    loading: boolean; // a fetchMessages() is in flight
}

// ── the window ───────────────────────────────────────────────────────────────

/** One dock window. Pinned windows are global tabs that persist across channels;
 *  the single un-pinned window is transient, bound to the channel it opened in.
 *  Genuinely cross-window state (the cache, channel memory, host refs) lives
 *  outside this. `state.width` is a proxy onto the one global dock width. */
export interface DockWindow {
    id: string;
    pinned: boolean;
    ownerChannelId: string | null;
    state: { open: boolean; width: number };
    content: PanelContent;

    /** Per-viewer view-state, keyed by ContentType (viewer.createState()). The
     *  engine treats these as opaque; each viewer casts its own slice. */
    viewStates: Record<string, unknown>;

    /** Capability state owned by cross-cutting modules, not by a viewer. */
    editView: EditViewState; // edit/ (text family)
    gallery: GalleryState; // viewers/image/gallery.ts
    isNewFile: boolean;
    newFileChannel: any;

    /** Engine bookkeeping. */
    activeDescriptor: ChannelDescriptor | null;
    activeCacheKey: string | null;
}

// ── content cache (LRU) ──────────────────────────────────────────────────────

/** The view-state snapshot a cached file carries, so re-opening it restores
 *  scroll/zoom/page/mode/edits. Viewer-specific keys are written by
 *  viewer.snapshot() and read by viewer.restore(). */
export interface CachedView {
    pdfPage?: number;
    pdfZoom?: number;
    pdfFit?: PdfFit;
    pdfDragMode?: PdfDragMode;
    pdfRotation?: number; // 0|90|180|270, so a cache return reopens at the same rotation
    imgScale?: number;
    imgTx?: number;
    imgTy?: number;
    imgRotation?: number; // 0|90|180|270, so a cache return reopens at the same rotation
    // the 3D camera pose (OrbitControls position + target) so a cache return
    // reopens the model at the same view.
    modelCamPos?: [number, number, number] | null;
    modelTarget?: [number, number, number] | null;
    // the pptx slide (1-based) the user was on, so a cache return reopens the deck
    // on the same slide.
    pptxSlide?: number;
    // the xlsx sheet (0-based index) the user was on, so a cache return reopens the
    // workbook on the same sheet.
    xlsxSheet?: number;
    // the raster TIFF page (1-based) the user was on, so a cache return reopens the
    // multi-page TIFF on the same page.
    rasterPage?: number;
    scrollTop?: number; // shared scroll of the active body scroller
    csvMode?: "grid" | "raw";
    treeMode?: "tree" | "raw";
    editMode?: "view" | "edit";
    editBuffer?: string | null;
    // code/text find state, so a cache return reopens the file with the find bar
    // (query + case toggle) exactly as it was left.
    codeFindOpen?: boolean;
    codeFindQuery?: string;
    codeFindCase?: boolean;
}

export interface CacheEntry {
    key: string;
    name: string;
    type: ContentType;
    url: string;
    html?: string | null;
    frameHtml?: string | null;
    code?: string | null;
    codeLang?: string;
    pdfDoc?: any | null; // kept alive while cached; released by viewer.dispose()
    pdfPages?: number;
    // the parsed three.js root (THREE.Object3D), kept alive while cached so a
    // re-open is instant; released (geometries/materials disposed) by the model3d
    // viewer.dispose() on eviction.
    model3dObject?: any | null;
    // the parsed presentation model (@aiden0z/pptx-renderer PresentationData), kept
    // alive while cached so a re-open re-renders without a re-fetch/re-parse. Plain
    // decoded data — no GPU/worker handle — so no dispose() needed (the live viewer
    // instance + its blob: URLs are owned + destroyed by the body on unmount).
    pptxPresentation?: any | null;
    // the parsed workbook (ordered sheet names + per-sheet CSV text), kept alive
    // while cached so a re-open re-renders without a re-fetch/re-parse. Plain decoded
    // text — no GPU/worker handle — so no dispose() needed.
    xlsxWorkbook?: { names: string[]; csv: string[] } | null;
    // A multi-page TIFF keeps its decoded source on the entry so page switches re-blob
    // a different IFD with NO re-fetch: `rasterTiff.buf` is the original TIFF bytes and
    // `rasterTiff.pages` is the IFD count. Single-page raster files (which retype to
    // "image") never set this. `rasterPageUrls` memoises the blob: url per already-
    // visited page (index 0-based) so flipping back to a page is instant; the raster
    // viewer's dispose() revokes every url here on eviction (mirrors the single blob
    // the retype path leaves on entry.url). Plain bytes — no GPU/worker handle.
    rasterTiff?: { buf: ArrayBuffer; pages: number } | null;
    rasterPageUrls?: (string | null)[];
    binary?: boolean;
    error?: string | null;
    loading: boolean;
    view: CachedView;
}

// ── per-channel memory ───────────────────────────────────────────────────────

export interface ChannelDescriptor {
    name: string;
    url: string;
    type: ContentType;
}

export interface ChannelMemory {
    open: boolean;
    descriptor: ChannelDescriptor | null;
}

// ── find ─────────────────────────────────────────────────────────────────────

/** Wires the shared FindBar to whichever viewer is active. */
export interface FindBarModel {
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

// ── the Viewer contract ──────────────────────────────────────────────────────

/** A monotonic load token. An async loader captures one and bails its
 *  content-write once it is no longer current (a newer load superseded it). */
export interface LoadToken {
    isCurrent(): boolean;
}

/** What load() is asked to render. A file usually has a url; a new-file surface
 *  carries its text in `code` with no url. */
export interface LoadOpts {
    name: string | null;
    url: string | null;
    type: ContentType;
    code?: string | null;
    noCache?: boolean; // a retry (error card) — the loader forces a fresh fetch
}

/** Everything a viewer's loader and body are handed by the engine. Replaces the
 *  ambient `activeWindow` the old monolith reached for from inside components. */
export interface ViewerContext {
    window: DockWindow;
    content: PanelContent; // === window.content
    requestRender(): void; // repaint the shell
    fetch(url: string, noCache?: boolean): Promise<Response>;
}

/** Optional cross-cutting features a viewer opts into. */
export interface ViewerCapabilities {
    editable?: boolean; // text family → edit/ mode applies
    gallery?: boolean; // image → gallery navigation applies
    openInWindow?: boolean; // external/ pop-out applies
}

/** One file format. Implemented by each module under viewers/ and listed once in
 *  viewers/registry.ts. `VS` is the viewer's own view-state slice. */
export interface Viewer<VS = unknown> {
    readonly type: ContentType;

    /** Fetch + parse into ctx.content and (if given) the cache entry, honoring the
     *  token. Always safe to write `entry`; only write `content` while
     *  token.isCurrent(). Async work resolves later and re-checks the token. */
    load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void;

    createState(): VS;
    resetState(vs: VS): void;
    snapshot(vs: VS, entry: CacheEntry, ctx: ViewerContext): void;
    restore(vs: VS, entry: CacheEntry): void;

    /** The body. The dispatcher keys it on content.seq. */
    Body: ViewerComponent;
    /** Optional second toolbar row. Omit → no row-2 strip for this type. */
    HeaderControls?: ViewerComponent;
    /** A find model when the body is findable in its current sub-view, else null. */
    findModel?(ctx: ViewerContext): FindBarModel | null;
    /** The element that owns vertical scroll (default ".dockview-body"). */
    scrollerSelector?(ctx: ViewerContext): string;
    /** Release per-entry resources on cache eviction (only pdf needs this). */
    dispose?(entry: CacheEntry): void;

    readonly capabilities?: ViewerCapabilities;
}
