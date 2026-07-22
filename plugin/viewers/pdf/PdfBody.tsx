/*
 * The PDF body — a scrollable column of page wrappers (canvas + selectable text
 * layer) rendered by pdf.js, with page navigation, fit-to-width zoom, drag-to-pan
 * and an in-panel find.
 *
 * This is the project's MOST verbatim-sensitive viewer: every isolation trick
 * below was measured and live-verified against the host (Discord typing/cursor
 * latency). It is intentionally ONE giant effect closure with shared mutable refs
 * — the render units (layout / raster / text-layer / find / live-scale) all close
 * over the same `pagesRef` / `matchesRef` / `renderScaleRef` / `liveAnchorRef`, so
 * decomposing it into many components/hooks would break the careful ref sharing.
 * Only the obviously-pure helpers (approximateFraction / floorToDivide) are split
 * out, above the component.
 *
 * Like every other body it publishes an imperative controller into the forceRender
 * "pdf" live-controller slot (page nav / zoom / fit / drag-mode / find +
 * begin/live/endLiveScale); the header toolbar, the ⋯ menu, the keyboard and the
 * resize drag read it back. UNMOUNT GUARD (load-bearing): on teardown we only clear
 * the slot if we still own it — a remount can register a new controller before the
 * old body's effect cleanup runs, and a bare clear would null the LIVE controller
 * the new body just published.
 *
 * The big resource — the pdf.js document — is owned by the cache entry, NOT this
 * body: PdfViewer.load() persists it to entry.pdfDoc and the body only reads
 * content.pdf.doc. So the unmount drops the per-page PDFPageProxy refs but never
 * destroys the doc (PdfViewer.dispose / cache eviction does that).
 *
 * The VERBATIM cores (do NOT "clean up" — all measured):
 *  - Main-thread pdf.js worker + Map/WeakMap upsert polyfill — lazy, in pdfWorker.ts.
 *  - DETACHED text-layer build (buildTextLayer): build the spans in an OFF-DOCUMENT
 *    div, then replaceChildren into the live column. In-column the per-glyph
 *    measureText forces a synchronous full-column round() recalc — 1531ms → ~1ms.
 *  - Bitmap quantization (approximateFraction / floorToDivide / sizeCanvas): pins
 *    the canvas backing store to the text-layer grid so selection edges aren't ragged.
 *  - Live-scale on resize (beginLiveScale / liveScale / endLiveScale): the
 *    --scale-factor CSS-var preview + per-page-fraction scroll anchor.
 *  - MessageChannel macrotask yield (yieldTask): a genuine task boundary, NOT rAF
 *    (the browser folds back-to-back rAFs into one frame under saturation).
 *
 * No module-top work: the pure helpers + function decls only; pdfjs is loaded
 * lazily (loadPdfjs) inside the effect, React is read at call time.
 */

import { React } from "@vencord/types/webpack/common";

import { dockHasFocus, isTextEntryFocused } from "../../engine/dockKeyboard";
import { clearLiveController, getLiveController, requestRender, setLiveController } from "../../engine/forceRender";
import { consumePendingScroll, getPendingScrollTop } from "../../engine/viewState";
import { getActiveWindow } from "../../engine/window";
import type { DockWindow, PdfFit, PdfViewState } from "../../engine/types";
import { loadPdfjs } from "./pdfWorker";

// The live-controller slot name (the old `pdfControls` module singleton).
export const PDF_CONTROLLER = "pdf";

export const PDF_MIN_ZOOM = 0.25;
export const PDF_MAX_ZOOM = 5;

// --- resize-drag flag (shared with the host's left-edge resize handler) ------
// During a width drag the PDF body must NOT raster (the drag only re-points
// --scale-factor for a cheap GPU preview; rastering mid-drag piles dozens of
// CPU-bound pdf.js renders into one multi-second freeze). The host's resize
// handler flips this on at drag start / off at drag end (and drives the "pdf"
// controller's begin/live/endLiveScale around it); the effect below reads it in
// every raster path. Module-level so the host can set it without a live ref.
let resizeDragging = false;
export function setPdfResizeDragging(on: boolean): void { resizeDragging = on; }
export function pdfResizeDragging(): boolean { return resizeDragging; }

/** The window's PDF view-state slice, created on demand. The VERY FIRST window is
 *  built at engine init BEFORE this viewer registers (the registry import that
 *  loads viewers transitively evaluates window.ts, whose initial makeWindow runs
 *  with an empty viewer set), so that one window can lack the slice. Every window
 *  made at runtime already has it; this back-fills the init-order edge. */
export function pdfState(win: DockWindow = getActiveWindow()): PdfViewState {
    let pv = win.viewStates[PDF_CONTROLLER] as PdfViewState | undefined;
    if (!pv) {
        pv = {
            page: 1, total: 0, fit: "width", zoom: 1, dragMode: "text", rotation: 0,
            findOpen: false, findQuery: "", findMatches: 0, findActive: 0, findCase: false
        };
        win.viewStates[PDF_CONTROLLER] = pv;
    }
    return pv;
}

/** Reset the PDF view to its fresh-open defaults (page 1, fit width, no find). */
export function resetPdfView(win: DockWindow = getActiveWindow()): void {
    const pv = pdfState(win);
    pv.page = 1;
    pv.total = 0;
    pv.fit = "width";
    pv.zoom = 1;
    pv.dragMode = "text";
    pv.rotation = 0;
    pv.findOpen = false;
    pv.findQuery = "";
    pv.findMatches = 0;
    pv.findActive = 0;
    pv.findCase = false;
}

/** The live PDF controller, driven by the header toolbar, the ⋯ menu, the keyboard
 *  and the resize drag. Mirrors the old `pdfControls` interface verbatim. */
export interface PdfController {
    goToPage: (n: number) => void;
    prevPage: () => void;
    nextPage: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    setFit: (f: PdfFit) => void;
    fitWidth: () => void; // reset zoom to 1 (fit panel width) + ensure width mode
    toggleDragMode: () => void; // flip text-select <-> pan for mouse drags
    rotate: () => void; // bump rotation 90° clockwise (0→90→180→270→0), re-raster
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
    // Pause the body's ResizeObserver re-raster for the duration of a dock-edge
    // drag (the drag drives its own live preview + a single drag-end re-raster);
    // the chrome's resize handler flips this true around begin/endLiveScale.
    setResizeDragging: (on: boolean) => void;
}

/** Read the live PDF controller (header / menu / keyboard / resize reach for it). */
export function pdfController(): PdfController | null {
    return getLiveController<PdfController>(PDF_CONTROLLER);
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

/** The PDF body. Keyed on content.seq by the dispatcher; the effect builds the
 *  page column once pdf.js resolves and the doc is ready, then publishes the "pdf"
 *  controller. Re-render (zoom / resize) is debounced and DPR-aware. */
export function PdfBody() {
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

    const seq = getActiveWindow().content.seq;
    const renderToken = getActiveWindow().content.pdf.renderToken;

    useEffect(() => {
        const host = containerRef.current;
        if (!host) return;
        const win = getActiveWindow();
        const pv = pdfState(win);

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
            return Math.max(1, (sc?.clientWidth || host.clientWidth || win.state.width) - PDF_SIDE_INSET);
        };

        // pdfjs is loaded lazily on the first PDF open; until it resolves, TextLayer
        // (and getDocument, already used by the loader) aren't available. We capture
        // it here and use the captured module throughout this effect.
        let pdfjsLib: any = null;

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
            const docToken = win.content.pdf.renderToken;
            const p = pagesRef.current[idx];
            if (!p) return;
            const docScale = renderScaleRef.current;
            // already crisp at this scale (and text built) — nothing to do.
            if (p.rasterScale === docScale && p.textScale === docScale) return;
            if (p.rendering) return;
            p.rendering = true;
            try {
                const doc = win.content.pdf.doc;
                if (!doc) return;
                if (!p.page) {
                    try { p.page = await doc.getPage(p.n); } catch { return; }
                    if (docToken !== win.content.pdf.renderToken) return;
                }
                const viewport = p.page.getViewport({ scale: docScale, rotation: pv.rotation });
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
                    if (docToken !== win.content.pdf.renderToken) return;
                    p.rasterScale = docScale;
                    // Let the just-painted crisp canvas COMMIT (and the thread
                    // breathe) before the text layer — which for a text-dense page
                    // is the heavier half. Without this break the canvas render and
                    // the hundreds-of-spans text build run as one ~280ms task per
                    // page; split, the page visibly sharpens a frame sooner and
                    // input stays responsive between the two halves.
                    await yieldTask();
                    if (docToken !== win.content.pdf.renderToken) return;
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
                        if (docToken !== win.content.pdf.renderToken) return;
                        p.textScale = docScale;
                        // a live find must light up matches on a freshly-built page
                        if (pv.findOpen && pv.findQuery) reapplyFindOnPage(idx);
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
            const myToken = win.content.pdf.renderToken;
            try {
                while (rasterQueue.length) {
                    if (resizeDragging) break; // resume after the drag (endLiveScale re-pumps)
                    if (myToken !== win.content.pdf.renderToken) { rasterQueue.length = 0; break; } // doc swapped
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
            if (!vis.length) { rasterAround(pv.page || 1); return; }
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
            const doc = win.content.pdf.doc;
            if (!doc) return;
            const myPass = ++passRef.current;
            const docToken = win.content.pdf.renderToken;

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
                if (myPass !== passRef.current || docToken !== win.content.pdf.renderToken) return;
                let pg: any;
                try { pg = await doc.getPage(n); } catch { return; }
                // rotation-aware: at 90/270 the page's width/height swap, so the
                // fit-width column must size off the ROTATED dimensions.
                const vp = pg.getViewport({ scale: 1, rotation: pv.rotation });
                if (vp.width > refW) { refW = vp.width; refH = vp.height; }
            }
            if (!refW) return;
            const fitScale = pv.fit === "page"
                ? Math.min(availW / refW, availH / refH)
                : availW / refW;
            const docScale = fitScale * pv.zoom;
            renderScaleRef.current = docScale;
            applyScaleRound();
            host.style.setProperty("--scale-factor", String(docScale));

            matchesRef.current = [];
            ioRef.current?.disconnect();

            const built: typeof pagesRef.current = [];
            const frag = document.createDocumentFragment();
            for (let n = 1; n <= doc.numPages; n++) {
                if (myPass !== passRef.current || docToken !== win.content.pdf.renderToken) return;
                let page: any;
                try { page = await doc.getPage(n); } catch { return; }
                // base geometry at the CURRENT rotation (width/height swap at 90/270),
                // so the page box + cached baseW/baseH match the rotated raster.
                const base = page.getViewport({ scale: 1, rotation: pv.rotation });

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
            if (myPass !== passRef.current || docToken !== win.content.pdf.renderToken) return;
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
            if (getPendingScrollTop() != null) {
                consumePendingScroll(win);
            } else if (pv.page > 1) {
                const p = built[Math.min(built.length, pv.page) - 1];
                if (sc && p) sc.scrollTop = Math.max(0, p.wrap.offsetTop - 8);
            }
            updateCurrentPage();
            rasterAround(pv.page || 1);
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
            const docToken = win.content.pdf.renderToken;
            const sc = scroller();
            const availW = availWidth();
            const availH = Math.max(1, (sc?.clientHeight || 600) - PDF_SIDE_INSET);
            // widest page from cached base geometry (no pdf.js round-trip).
            let refW = 0, refH = 0;
            for (const p of pages) if (p.baseW > refW) { refW = p.baseW; refH = p.baseH; }
            if (!refW) return false;
            const fitScale = pv.fit === "page" ? Math.min(availW / refW, availH / refH) : availW / refW;
            const docScale = fitScale * pv.zoom;
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
                : Math.max(0, (pv.page || 1) - 1);
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
            if (pv.findOpen && pv.findQuery) runFind(pv.findQuery, false);
            if (docToken !== win.content.pdf.renderToken) return true;
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
            if (best !== pv.page) {
                pv.page = best;
                requestRender();
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
            const activeIdx = pv.findActive - 1;
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
            const docToken = win.content.pdf.renderToken;
            const p = pagesRef.current[idx];
            if (!p || p.textScale === renderScaleRef.current) return;
            const doc = win.content.pdf.doc;
            if (!doc) return;
            if (!p.page) {
                try { p.page = await doc.getPage(p.n); } catch { return; }
                if (docToken !== win.content.pdf.renderToken) return;
            }
            try {
                const viewport = p.page.getViewport({ scale: renderScaleRef.current, rotation: pv.rotation });
                // detached build (see buildTextLayer) — keeps a whole-document
                // find from freezing the host one page at a time.
                await buildTextLayer(p.textDiv, p.page, viewport);
                if (docToken !== win.content.pdf.renderToken) return;
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
            const cmp = pv.findCase ? q : q.toLowerCase();
            const hay = pv.findCase ? text : text.toLowerCase();
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
            const q = pv.findQuery.trim();
            if (!q || !hlSupported) return;
            const page = idx + 1;
            // remember which match was active (so we can re-aim at the same page)
            const activeWasOnPage = matchesRef.current[pv.findActive - 1]?.page === page;
            const fresh = collectPageMatches(idx, q).map(range => ({ page, range }));
            // rebuild the ordered list: drop this page's old entries, splice fresh
            // ones in at the page-ordered position. Matches are kept in page order;
            // within a page collectPageMatches already returns reading order.
            const before = matchesRef.current.filter(m => m.page < page);
            const after = matchesRef.current.filter(m => m.page > page);
            matchesRef.current = [...before, ...fresh, ...after];
            pv.findMatches = matchesRef.current.length;
            // keep a sane active index: if it was on this page, re-point at this
            // page's first fresh hit; otherwise leave it (clamped) where it was.
            if (pv.findMatches === 0) pv.findActive = 0;
            else if (activeWasOnPage && fresh.length) pv.findActive = before.length + 1;
            else if (pv.findActive === 0) pv.findActive = 1;
            else if (pv.findActive > pv.findMatches) pv.findActive = pv.findMatches;
            repaintHighlights();
            requestRender();
        };
        const runFind = async (query: string, jump: boolean) => {
            clearHighlights();
            pv.findMatches = 0;
            pv.findActive = 0;
            const q = query.trim();
            if (!q) { requestRender(); return; }
            if (!hlSupported) { requestRender(); return; }
            const myToken = win.content.pdf.renderToken;
            const pages = pagesRef.current;
            // Build text layers for every page (raster-free) so find sees the
            // WHOLE document, not just the pages that happen to be rastered. Each
            // build is a ~main-thread block; yield a macrotask between pages so a
            // big doc (or a re-find after a resize invalidated every text layer)
            // re-lights PROGRESSIVELY instead of freezing the UI in one run.
            for (let i = 0; i < pages.length; i++) {
                if (i > 0) await yieldTask();
                await ensureTextLayer(i);
                if (myToken !== win.content.pdf.renderToken || pv.findQuery.trim() !== q) return;
            }
            const all: typeof matchesRef.current = [];
            for (let i = 0; i < pages.length; i++) {
                for (const range of collectPageMatches(i, q)) all.push({ page: i + 1, range });
            }
            matchesRef.current = all;
            pv.findMatches = all.length;
            if (all.length > 0) {
                pv.findActive = 1;
                if (jump) focusMatch(0);
                else { repaintHighlights(); requestRender(); }
            } else {
                repaintHighlights();
                requestRender();
            }
        };
        const focusMatch = (idx: number) => {
            const m = matchesRef.current[idx];
            if (!m) return;
            pv.findActive = idx + 1;
            repaintHighlights();
            // ensure the match's page (+ neighbours) are crisp before we land.
            rasterAround(m.page);
            // scroll the occurrence's range into view (centre). Use the start
            // container's parent element — Range has no scrollIntoView itself.
            const anchor = (m.range.startContainer.parentElement || null);
            anchor?.scrollIntoView({ block: "center", behavior: "smooth" });
            requestRender();
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
            pv.page = idx + 1;
            requestRender();
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
            host.classList.toggle("dockview-pdf-pan", pv.dragMode === "pan");
            if (pv.dragMode !== "pan") host.classList.remove("dockview-pdf-panning");
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
            if (pv.dragMode !== "pan" || e.button !== 0) return;
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

        // Expose controls to the toolbar + keyboard + resize while this PDF is
        // mounted. Published into the forceRender "pdf" live-controller slot.
        const ctrls: PdfController = {
            goToPage: (n: number) => scrollToPage(n),
            prevPage: () => scrollToPage(pv.page - 1),
            nextPage: () => scrollToPage(pv.page + 1),
            zoomIn: () => { pv.zoom = Math.min(PDF_MAX_ZOOM, pv.zoom * 1.25); scheduleRerender(); requestRender(); },
            zoomOut: () => { pv.zoom = Math.max(PDF_MIN_ZOOM, pv.zoom / 1.25); scheduleRerender(); requestRender(); },
            setFit: (f: PdfFit) => { if (pv.fit !== f) { pv.fit = f; pv.zoom = 1; scheduleRerender(); requestRender(); } },
            fitWidth: () => { if (pv.fit !== "width" || pv.zoom !== 1) { pv.fit = "width"; pv.zoom = 1; scheduleRerender(); requestRender(); } },
            toggleDragMode: () => { pv.dragMode = pv.dragMode === "pan" ? "text" : "pan"; endPan(); syncPanClass(); requestRender(); },
            // Rotate 90° clockwise. A rotation swaps each page box's width/height (at
            // 90/270), which the cached baseW/baseH in rescale() can't express — so we
            // rebuild the column from scratch (buildLayout re-reads getViewport at the
            // new rotation, re-sizing every box + invalidating every raster). The find
            // highlights ride along: runFind re-collects after the rebuild if active.
            rotate: () => {
                pv.rotation = (pv.rotation + 90) % 360;
                if (win.content.pdf.doc) {
                    // rebuild, THEN re-light find (the rebuild empties matchesRef +
                    // rebuilds text layers at the new rotation, so old Ranges are stale).
                    buildLayout().then(() => {
                        if (pv.findOpen && pv.findQuery) runFind(pv.findQuery, false);
                    });
                }
                requestRender();
            },
            toggleFind: () => { pv.findOpen = !pv.findOpen; if (!pv.findOpen) { clearHighlights(); pv.findMatches = 0; pv.findActive = 0; pv.findQuery = ""; } requestRender(); },
            toggleFindCase: () => { pv.findCase = !pv.findCase; runFind(pv.findQuery, false); requestRender(); },
            setFindQuery: (qq: string) => { pv.findQuery = qq; runFind(qq, true); },
            findNext: () => { if (!pv.findMatches) return; focusMatch(pv.findActive % pv.findMatches); },
            findPrev: () => { if (!pv.findMatches) return; focusMatch((pv.findActive - 2 + pv.findMatches) % pv.findMatches); },
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
                const h = containerRef.current;
                if (!h) return;
                const r = pv.fit === "page" ? 1 : ratio;
                h.style.setProperty("--scale-factor", String(renderScaleRef.current * r));
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
                if (win.content.pdf.doc) renderAll();
                liveAnchorRef.current = null;
            },
            setResizeDragging: setPdfResizeDragging
        };
        setLiveController(PDF_CONTROLLER, ctrls);

        // zoom re-render is debounced (DPR-crisp re-raster of every page)
        let zoomDebounce: any = null;
        const scheduleRerender = () => {
            clearTimeout(zoomDebounce);
            zoomDebounce = setTimeout(() => { if (win.content.pdf.doc) renderAll(); }, 120);
        };

        // First paint: pdf.js must be resolved (TextLayer) before we build the
        // column. The doc itself is already loaded by PdfViewer.load (into
        // content.pdf.doc); loadPdfjs() is the cached promise that warmed during
        // that load, so this resolves immediately on every page after the first.
        let cancelled = false;
        loadPdfjs().then(mod => {
            if (cancelled || !host.isConnected) return;
            pdfjsLib = mod;
            renderAll();
        });

        // scroll -> current-page indicator (throttled via rAF)
        let scrollRaf = 0;
        const sc = scroller();
        const onScroll = () => {
            if (scrollRaf) return;
            scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateCurrentPage(); });
        };
        sc?.addEventListener("scroll", onScroll, { passive: true });

        // --- keyboard shortcuts (the ones the header tooltips advertise) -------
        // Wired to the SAME controller verbs the header buttons drive, behind the
        // shared dock-focus gate (so they never fire while typing in the Discord
        // chat box or another panel). The find input + a panning text-selection in
        // the PDF are NOT text-entry surfaces that swallow these, except the find
        // input (an <input>): single-key zoom/page keys skip it (isTextEntryFocused),
        // so typing "0"/"-" into a page/find field types normally. Ctrl/Cmd+F (find)
        // and Esc (close find) are not literal characters, so they apply on dock
        // focus regardless. Matches the image viewer's window-keydown pattern.
        const onKey = (e: KeyboardEvent) => {
            if (!dockHasFocus()) return;
            const ctrl = pdfController();
            if (!ctrl) return;
            // Ctrl/Cmd+F → open the SAME find bar the magnifier button opens.
            if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
                if (!pv.findOpen) { e.preventDefault(); ctrl.toggleFind(); }
                return;
            }
            // Esc → close find if it's open (the find INPUT handles its own Esc; this
            // covers Esc while focus is elsewhere in the dock).
            if (e.key === "Escape") {
                if (pv.findOpen) { e.preventDefault(); ctrl.toggleFind(); }
                return;
            }
            // The remaining single-key shortcuts must never hijack a real keystroke
            // in a text field (the find input / page-jump input) or a modifier chord.
            if (e.ctrlKey || e.altKey || e.metaKey) return;
            if (isTextEntryFocused()) return;
            if (e.key === "+" || e.key === "=") {
                e.preventDefault(); ctrl.zoomIn();
            } else if (e.key === "-" || e.key === "_") {
                e.preventDefault(); ctrl.zoomOut();
            } else if (e.key === "0") {
                e.preventDefault(); ctrl.fitWidth(); // reset/fit zoom (the "0" tooltip)
            } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
                e.preventDefault(); ctrl.prevPage();
            } else if (e.key === "ArrowRight" || e.key === "PageDown") {
                e.preventDefault(); ctrl.nextPage();
            }
        };
        window.addEventListener("keydown", onKey);

        let roDebounce: any = null;
        const ro = new ResizeObserver(() => {
            clearTimeout(roDebounce);
            roDebounce = setTimeout(() => {
                if (!win.content.pdf.doc) return;
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
            cancelled = true;
            passRef.current++; // invalidate the in-flight pass
            clearTimeout(roDebounce);
            clearTimeout(zoomDebounce);
            if (scrollRaf) cancelAnimationFrame(scrollRaf);
            sc?.removeEventListener("scroll", onScroll);
            window.removeEventListener("keydown", onKey);
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
            // UNMOUNT GUARD: only clear the slot if it's still ours (a remount may
            // have already published a new controller — don't null the live one).
            clearLiveController(PDF_CONTROLLER, ctrls);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [renderToken, seq]);

    return React.createElement("div", {
        key: seq,
        ref: containerRef,
        className: "dockview-pdf-container",
        // Focusable so a click into the PDF body gives the panel keyboard focus;
        // page-nav / zoom keys are gated on that focus (never on hover).
        tabIndex: 0
    });
}
