/*
 * The PowerPoint viewer — the Viewer contract over @aiden0z/pptx-renderer (type
 * "pptx").
 *
 * A .pptx is an Office Open XML presentation: a ZIP of slide XML + media. The
 * @aiden0z/pptx-renderer parses that ZIP into a PresentationData model and renders
 * each slide to positioned HTML/SVG. The render needs a live container (it drives an
 * IntersectionObserver for windowed list rendering and emits DOM, not a self-
 * contained HTML-document string) — but the PARSE is DOM-free (parseZip →
 * buildPresentation). So the split mirrors PdfViewer exactly:
 *
 *   - load() fetches the file as bytes, lazily loads the renderer (off Vesktop
 *     startup, behind the "Loading presentation viewer…" dock state), runs the
 *     DOM-free parse, and dual-writes the parsed PresentationData to BOTH the cache
 *     entry (entry.pptxPresentation) and the live content (content.pptx.presentation),
 *     bumping renderToken so a superseded body drops the stale deck. The slide COUNT
 *     (presentation.slides.length) is written to the view-state here so the header's
 *     slide counter is correct the instant the body mounts. Like pdf/3D, the parsed
 *     model is the big resource, owned by the CACHE ENTRY, not the body.
 *
 *   - PptxBody only mounts a viewer over the already-parsed model (new PptxViewer
 *     (host) → load(presentation) → renderList()), owns that live instance + its
 *     blob: URLs / observers, and destroys it on unmount.
 *
 *   - createState/resetState: the per-window PptxViewState (slide nav). snapshot/
 *     restore park/restore the current slide on the entry so a cache return reopens
 *     the deck on the same slide.
 *
 * The parsed model holds no GPU/worker handle (just decoded slide data + media
 * bytes), so this viewer needs NO dispose() — the only heavy live resource is the
 * body-owned viewer instance, torn down on unmount; the cached model is freed with
 * the entry by GC.
 *
 * The renderer is HEAVY (echarts + jszip + the OOXML model). Its ONLY import is the
 * DYNAMIC `() => import("@aiden0z/pptx-renderer")` below (in load) and in PptxBody,
 * routed through engine/lazyLib so its top-level EXECUTION leaves Vencord startup.
 * NEVER add a static `import … from "@aiden0z/pptx-renderer"` to this module or
 * PptxBody — that re-loads the renderer at Vencord init and undoes the lazy-lib batch.
 */

import { getCacheEntry } from "../../engine/cache";
import { withLibLoading } from "../../engine/lazyLib";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, PptxViewState, Viewer, ViewerContext
} from "../../engine/types";
import { PptxBody, pptxState, resetPptxView } from "./PptxBody";
import { PptxHeaderControls } from "./PptxHeaderControls";

// The lazy-lib cache key (shared by the loader's parse import and the body's render
// import so both await the single cached module).
export const PPTX_LIB_KEY = "pptx-renderer";

/** pptx loader: reset the live deck, fetch the file, lazily load the renderer, run
 *  its DOM-free parse (parseZip → buildPresentation), then dual-write the parsed
 *  PresentationData (entry always while it's still the cache's live entry; content
 *  only while the token is current). The render itself runs in PptxBody. */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    // Reset the live deck BEFORE the fetch (mirrors pdf/3D): null the previous model
    // and BUMP renderToken so the body (keyed on renderToken) drops the stale deck
    // instead of showing A's slides until B resolves.
    ctx.content.pptx = { presentation: null, renderToken: ctx.content.pptx.renderToken + 1 };
    resetPptxView(ctx.window);
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
        .then(async buf => {
            // Lazy-load the renderer through engine/lazyLib so the dock shows "Loading
            // presentation viewer…" while the (code-dense) lib spins up the first time
            // this session; subsequent opens reuse the cached module instantly.
            const lib: any = await withLibLoading(ctx, STRINGS.loading.lib.pptx, PPTX_LIB_KEY,
                () => import("@aiden0z/pptx-renderer"));
            // DOM-free parse: ZIP → files → PresentationData. The slide count + size
            // are available on the model without ever touching a container.
            const files = await lib.parseZip(buf, lib.RECOMMENDED_ZIP_LIMITS);
            const presentation = lib.buildPresentation(files);
            if (!presentation || !Array.isArray(presentation.slides) || presentation.slides.length === 0) {
                throw new Error("This presentation has no slides.");
            }
            return presentation;
        })
        .then((presentation: any) => {
            const total = presentation.slides.length;
            // Only keep the model on `entry` if it is STILL the cache's live entry for
            // its key (a rapid re-click could have replaced it); otherwise the entry is
            // detached and storing the model there would be pointless. No teardown is
            // needed (plain decoded data), so there's no leak to guard against.
            const live = entry != null && getCacheEntry(entry.key) === entry;
            if (live) { entry!.pptxPresentation = presentation; entry!.loading = false; entry!.error = null; }

            if (!token.isCurrent()) return; // superseded — don't touch content
            ctx.content.pptx.presentation = presentation;
            ctx.content.pptx.renderToken += 1; // a fresh deck is ready to render
            // Fill the slide total now so the header counter is correct on first
            // paint; clamp the (possibly cache-restored) current slide into range.
            const vs = pptxState(ctx.window);
            vs.total = total;
            vs.slide = Math.min(Math.max(1, vs.slide || 1), total);
            ctx.content.loading = false;
            ctx.content.loadingLabel = null;
            ctx.content.error = null;
            ctx.requestRender();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (!token.isCurrent()) return;
            ctx.content.loading = false;
            ctx.content.loadingLabel = null;
            ctx.content.error = String(e?.message || e);
            ctx.requestRender();
        });
}

function createState(): PptxViewState {
    return { slide: 1, total: 0 };
}

function resetState(vs: PptxViewState): void {
    if (!vs) return;
    vs.slide = 1;
    vs.total = 0;
}

/** Park the current slide on the entry so a cache return reopens the deck there. */
function snapshot(vs: PptxViewState, entry: CacheEntry): void {
    entry.view.pptxSlide = vs?.slide ?? 1;
}

/** Restore the saved slide on a cache return. total is re-derived from the cached
 *  presentation's slide count (so the header counter is right before the body mounts);
 *  the body jumps to the saved slide once the deck renders. */
function restore(vs: PptxViewState, entry: CacheEntry): void {
    if (!vs) return;
    vs.slide = entry.view.pptxSlide ?? 1;
    const total = entry.pptxPresentation?.slides?.length ?? 0;
    vs.total = total;
    if (total) vs.slide = Math.min(Math.max(1, vs.slide), total);
}

export const PptxViewer: Viewer<PptxViewState> = {
    type: "pptx",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: PptxBody,
    HeaderControls: PptxHeaderControls
    // No dispose: the parsed model on the entry is plain data (freed with the entry by
    // GC); the only heavy LIVE resource — the PptxViewer instance + its blob: URLs /
    // observers — is owned by PptxBody and torn down on unmount.
};
