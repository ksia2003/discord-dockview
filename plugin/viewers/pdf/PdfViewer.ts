/*
 * The PDF viewer — the Viewer contract over pdf.js (type "pdf").
 *
 * The hardest viewer + the most verbatim-sensitive cores (all in PdfBody / the
 * lazy pdfWorker). This module is the thin contract shell:
 *
 *  - load(): port of the old loadPdf — fetch the file as an ArrayBuffer
 *    (ctx.fetch → r.arrayBuffer()), hand it to loadPdfjs().getDocument, then write
 *    the resolved doc + page count to BOTH the cache entry (entry.pdfDoc/pdfPages)
 *    and the live content (content.pdf.doc/pages). The DUAL-WRITE + destroy-on-
 *    supersede is verbatim: the doc is persisted to the entry whenever that entry
 *    is STILL the cache's live entry for its key (so a re-open is instant even if
 *    this load was superseded); if the entry was detached (a rapid re-click
 *    disposed + replaced it) the doc is destroyed to avoid the leak. The live
 *    content is written ONLY while token.isCurrent().
 *  - createState/resetState: the per-window PdfViewState (resetPdfView defaults).
 *  - snapshot/restore: park/restore page/zoom/fit/dragMode on the entry's view
 *    (the shared scrollTop is saved by engine/viewState through the default
 *    .dockview-body scroller; PdfBody re-applies it itself after its lazy page
 *    boxes exist, via the pendingScroll hook in buildLayout). find never persists.
 *  - Body = PdfBody, HeaderControls = PdfHeaderControls, findModel = the pdf find
 *    (wired to the live "pdf" controller via the shared FindBar) while find is open.
 *  - dispose(entry) = destroyPdfDoc(entry.pdfDoc): the cache calls this on eviction
 *    to release the pdf.js doc (worker-side page caches) — the ONLY viewer that
 *    needs dispose.
 *  - fitWidth(): an EXTRA method (not part of the Viewer interface) the ⋯ more-menu
 *    calls (DockMoreMenu reads getViewer("pdf").fitWidth()); it drives the live
 *    "pdf" controller's fitWidth.
 *
 * No module-top work: imports + function/const decls only. pdf.js is loaded
 * lazily inside load() / PdfBody; the worker + Map polyfill run on first open.
 */

import { getCacheEntry } from "../../engine/cache";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, FindBarModel, LoadOpts, LoadToken, PdfViewState, Viewer, ViewerContext
} from "../../engine/types";
import { PdfBody, pdfController, pdfState, resetPdfView } from "./PdfBody";
import { PdfHeaderControls } from "./PdfHeaderControls";
import { loadPdfjs } from "./pdfWorker";

/** Release a pdf.js document and everything it owns (worker-side page caches).
 *  Prefer the loadingTask.destroy (the cleanest teardown), then the doc's own
 *  destroy(), and finally cleanup() — best-effort, each swallowed so a teardown
 *  never throws upward. (The old resetPdf called the non-existent doc.destroy()
 *  inside a swallow try/catch, silently leaking every PDF — this is the fix.) */
export function destroyPdfDoc(doc: any): void {
    if (!doc) return;
    try {
        const lt = doc.loadingTask;
        if (lt && typeof lt.destroy === "function") { lt.destroy(); return; }
    } catch { /* fall through */ }
    try { if (typeof doc.destroy === "function") { doc.destroy(); return; } } catch { /* fall through */ }
    try { if (typeof doc.cleanup === "function") doc.cleanup(); } catch { /* ignore */ }
}

/** PDF loader (port of loadPdf): fetch → ArrayBuffer → loadPdfjs().getDocument,
 *  then the verbatim dual-write + destroy-on-supersede. */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    // Reset the live PDF content + view BEFORE the fetch (port of the old loadPdf's
    // resetPdf): null the previous file's doc and BUMP renderToken so the body
    // (keyed on renderToken) drops the stale column immediately instead of
    // rendering A's pages until B resolves. The engine's showContent doesn't touch
    // content.pdf on a fresh fetch (only the cache-hit / clear paths do), so this
    // viewer owns the reset on a miss. A cache RESTORE never reaches load (it
    // re-points content.pdf via mountFromCache + keeps the saved view).
    ctx.content.pdf = { doc: null, pages: 0, renderToken: ctx.content.pdf.renderToken + 1 };
    resetPdfView(ctx.window);
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = STRINGS.error.noSource.title;
        return;
    }
    ctx.content.loading = true;
    const reqUrl = opts.url;
    ctx.fetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.arrayBuffer();
        })
        .then(buf => loadPdfjs().then(pdfjsLib => {
            const task = pdfjsLib.getDocument({ data: new Uint8Array(buf) });
            return task.promise;
        }))
        .then((doc: any) => {
            if (!doc) return;
            // Only keep the doc if `entry` is STILL the cache's live entry for its
            // key (a rapid re-click could have disposed + replaced it). Otherwise
            // the entry is detached and storing the doc there would leak it — so
            // destroy it. The doc is persisted even when superseded (so a re-open
            // is instant), as long as the entry is still live.
            const live = entry != null && getCacheEntry(entry.key) === entry;
            if (live) { entry!.pdfDoc = doc; entry!.pdfPages = doc.numPages; entry!.loading = false; entry!.error = null; }
            else { destroyPdfDoc(doc); }
            if (!token.isCurrent()) return; // superseded — don't touch content
            ctx.content.pdf.doc = doc;
            ctx.content.pdf.pages = doc.numPages;
            pdfState(ctx.window).total = doc.numPages;
            // keep the cached/restored page if any (applyCachedView set it); else 1.
            ctx.content.pdf.renderToken += 1; // signal: a fresh doc is ready to render
            ctx.content.loading = false;
            ctx.content.error = null;
            ctx.requestRender();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (!token.isCurrent()) return;
            ctx.content.loading = false;
            ctx.content.error = String(e?.message || e);
            ctx.requestRender();
        });
}

function createState(): PdfViewState {
    return {
        page: 1, total: 0, fit: "width", zoom: 1, dragMode: "text", rotation: 0,
        findOpen: false, findQuery: "", findMatches: 0, findActive: 0, findCase: false
    };
}

function resetState(vs: PdfViewState): void {
    if (!vs) return;
    vs.page = 1;
    vs.total = 0;
    vs.fit = "width";
    vs.zoom = 1;
    vs.dragMode = "text";
    vs.rotation = 0;
    vs.findOpen = false;
    vs.findQuery = "";
    vs.findMatches = 0;
    vs.findActive = 0;
    vs.findCase = false;
}

/** Park page/zoom/fit/dragMode on the entry so a cache return reopens it as left.
 *  find is intentionally NOT persisted (a restored PDF opens with find closed).
 *  The shared scrollTop is saved by engine/viewState (default .dockview-body). */
function snapshot(vs: PdfViewState, entry: CacheEntry): void {
    entry.view.pdfPage = vs?.page ?? 1;
    entry.view.pdfZoom = vs?.zoom ?? 1;
    entry.view.pdfFit = vs?.fit ?? "width";
    entry.view.pdfDragMode = vs?.dragMode ?? "text";
    entry.view.pdfRotation = vs?.rotation ?? 0;
}

/** Restore page/zoom/fit/dragMode on a cache return. total comes from the cached
 *  page count; find is reset (never persists across opens). PdfBody re-applies the
 *  saved scrollTop itself once its page boxes exist (the pendingScroll hook). */
function restore(vs: PdfViewState, entry: CacheEntry): void {
    if (!vs) return; // missing slice (init-order edge) — back-filled on mount
    vs.zoom = entry.view.pdfZoom ?? 1;
    vs.fit = entry.view.pdfFit ?? "width";
    vs.page = entry.view.pdfPage ?? 1;
    vs.total = entry.pdfPages ?? 0;
    vs.dragMode = entry.view.pdfDragMode ?? "text";
    vs.rotation = entry.view.pdfRotation ?? 0;
    vs.findOpen = false;
    vs.findQuery = "";
    vs.findMatches = 0;
    vs.findActive = 0;
    vs.findCase = false;
}

/** The PDF find model — wired to the live "pdf" controller (PdfBody runs the
 *  CSS-Custom-Highlight search). Returns null unless the find bar is open, so the
 *  panel only mounts the shared FindBar then. */
function findModel(ctx: ViewerContext): FindBarModel | null {
    const pv = pdfState(ctx.window);
    if (!pv.findOpen) return null;
    return {
        query: pv.findQuery,
        matches: pv.findMatches,
        active: pv.findActive,
        caseSensitive: pv.findCase,
        placeholder: STRINGS.find.placeholder,
        setQuery: (q: string) => pdfController()?.setFindQuery(q),
        next: () => pdfController()?.findNext(),
        prev: () => pdfController()?.findPrev(),
        toggleCase: () => pdfController()?.toggleFindCase(),
        close: () => pdfController()?.toggleFind()
    };
}

/** Reset the PDF to fit-width (the ⋯ menu's "Fit to width"). Drives the live
 *  controller; an extra method NOT on the Viewer interface — DockMoreMenu calls it
 *  via getViewer("pdf").fitWidth() guarded behind `typeof === "function"`. */
function fitWidth(): void {
    pdfController()?.fitWidth();
}

export const PdfViewer: Viewer<PdfViewState> & { fitWidth: () => void } = {
    type: "pdf",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: PdfBody,
    HeaderControls: PdfHeaderControls,
    findModel,
    // PDF scrolls the body itself (.dockview-body, the default) — no inner
    // scroller, so no scrollerSelector. PdfBody re-applies the saved scrollTop
    // after its lazy page boxes exist (DockPanel skips its generic scroll restore
    // for pdf), so the default snapshot of .dockview-body is correct.
    dispose: (entry: CacheEntry) => { destroyPdfDoc(entry.pdfDoc); entry.pdfDoc = null; },
    // Extra (off-interface) method the ⋯ more-menu reaches for.
    fitWidth
};
