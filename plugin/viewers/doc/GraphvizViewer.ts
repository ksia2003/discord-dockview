/*
 * The GRAPHVIZ viewer — type "graphviz" (.dot / .gv).
 *
 * @viz-js/viz is Graphviz compiled to WASM, with the binary embedded as a string
 * INSIDE the JS module (no separate .wasm file, no fetch, no dynamic import), so it
 * runs fully OFFLINE under Discord's CSP. The DOT source is rendered to an SVG string
 * on the MAIN side and only that inert SVG is shipped into the SAME dark sandboxed
 * iframe the mermaid/markdown viewers use — no viz runtime ever runs inside the
 * sandbox (mirrors the mermaid viewer exactly).
 *
 * ★ LAZY LOAD + WASM INIT ★ @viz-js/viz is pulled in with a DYNAMIC import() routed
 * through engine/lazyLib, so its module top-level leaves Vencord startup (an esbuild
 * IIFE bundle has no code-splitting, but a static import still RUNS the module at
 * init). instance() then returns a Promise<Viz>; ensureViz() memoizes that promise so
 * every later diagram reuses the same WASM module (no re-instantiation), resolved on
 * the FIRST .dot/.gv render behind a "Loading Graphviz engine…" dock state.
 *
 * Graphviz uses black-on-white by default; MD_STYLE draws the SVG on a light card
 * (.dv-graphviz) so the black text/edges stay legible on the dark page.
 *
 * VIEW-ONLY: no editable source, no HeaderControls, no editable capability.
 */

import { escapeHtml } from "../../engine/html";
import { withLibLoading } from "../../engine/lazyLib";
import { injectNonce, pageNonce, setArtifactHtml } from "../../engine/nonce";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { HtmlBody, wrapMarkdownDoc } from "./iframe";

// viz-js (Graphviz WASM) is loaded + resolved ONCE, lazily, on the first .dot/.gv
// render. The binary is bundled in-module (no fetch), so this resolves fully offline.
let _vizPromise: Promise<any> | null = null;
function ensureViz(ctx: ViewerContext): Promise<any> {
    if (!_vizPromise) {
        _vizPromise = withLibLoading(ctx, STRINGS.loading.lib.graphviz, "@viz-js/viz",
            async () => {
                const { instance } = await import("@viz-js/viz");
                return instance();
            });
    }
    return _vizPromise;
}

/** Render Graphviz/DOT source to a full dark sandboxed-iframe document. viz-js'
 *  renderString is synchronous once the WASM instance exists, but instance() is async,
 *  so this returns a Promise<string>. On a parse/render error we degrade to the raw
 *  source in a red <pre> (mirrors the mermaid viewer). The SVG is centred in a
 *  scrollable body on a light card (Graphviz uses black-on-white by default). */
async function renderGraphvizDoc(src: string, ctx: ViewerContext): Promise<string> {
    let body: string;
    try {
        const viz = await ensureViz(ctx);
        const svg = viz.renderString(src, { format: "svg" });
        body = `<div class="dv-graphviz">${svg}</div>`;
    } catch (e) {
        body = `<pre class="dv-mermaid-error">${escapeHtml(String((e as any)?.message || e))}\n\n${escapeHtml(src)}</pre>`;
    }
    // Reuse the markdown doc shell (dark theme, link routing) like mermaid/docx.
    return wrapMarkdownDoc(body, false);
}

/** GRAPHVIZ loader: fetch the .dot/.gv source as text → render to SVG → dark sandbox
 *  iframe. Structurally identical to the mermaid loader. */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
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
            return r.text();
        })
        .then(src => renderGraphvizDoc(src, ctx))
        .then(fullHtml => {
            if (entry) {
                entry.html = fullHtml;
                const nonce = pageNonce();
                entry.frameHtml = nonce ? injectNonce(fullHtml, nonce) : fullHtml;
                entry.loading = false;
                entry.error = null;
            }
            if (!token.isCurrent()) return;
            setArtifactHtml(ctx.content, fullHtml);
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

function createState(): unknown {
    return {};
}
function resetState(): void {
    /* no per-window graphviz view-state */
}
function snapshot(): void {
    /* nothing format-specific to park */
}
function restore(): void {
    /* nothing format-specific to restore */
}

export const GraphvizViewer: Viewer = {
    type: "graphviz",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: HtmlBody,
    // View-only: no HeaderControls, no findModel, no dispose, no editable capability.
};
