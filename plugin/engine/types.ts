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
    | "xlsx"
    | "mermaid"
    | "graphviz"
    | "ipynb"
    | "structured"
    | "rasterimage";

// ── panel content ───────────────────────────────────────────────────────────

export interface PdfState {
    doc: any | null; // pdf.js PDFDocumentProxy
    pages: number;
    renderToken: number; // bumped per pdf load so a stale render aborts
}

/** What is currently loaded into a window. `seq` is bumped on every (re)load and
 *  on a sub-view swap (grid↔raw, rendered↔edit) so React remounts the body. */
export interface PanelContent {
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
    fullscreen: boolean;
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
    imgScale?: number;
    imgTx?: number;
    imgTy?: number;
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
