/*
 * The MARKDOWN viewer — type "markdown".
 *
 * load(): fetch the .md text → marked (+ KaTeX math + code highlight) → the dark
 * markdown doc wrapper → the engine's nonce/sandbox machinery (setArtifactHtml,
 * which stamps the host CSP nonce onto the frameHtml). The RAW markdown source is
 * kept in content.code (lang "markdown") so the P8 edit layer can open a CM over
 * the source; the rendered html is the VIEW.
 *
 * The verbatim dual-write is preserved: the cache entry is ALWAYS filled (so a
 * later return is a hit even if this load is superseded), but the live content is
 * written ONLY while the token is current.
 *
 * Body = the shared HtmlBody iframe shell (iframe.ts). HeaderControls = a view-only
 * copy-source row (DocHeaderControls); the find + edit-source toggle that the
 * monolith's EditTextHeaderControls carried are the P8 cross-cutting edit/ concern
 * and are intentionally absent this phase. capabilities.editable is declared so the
 * P8 edit/ layer can ride this viewer; this phase renders read-only.
 *
 * No module-top work: marked/katex registration is lazy (markdown.ts), the doc is
 * only built inside load(), and the components read React at call time.
 */

import { injectNonce, pageNonce, setArtifactHtml } from "../../engine/nonce";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { DocHeaderControls } from "./DocHeaderControls";
import { HtmlBody, wrapMarkdownDoc } from "./iframe";
import { highlightMarkdownCode, markdownToHtml } from "./markdown";

/** The full markdown → dark sandboxed-doc pipeline (marked + code highlight +
 *  KaTeX-aware wrapper). Pulled out so the loader (first render from the fetched
 *  source) and the P8 edit toggle (re-render from the edited buffer) render
 *  identically. */
function renderMarkdownDoc(md: string): string {
    const { html, hasMath } = markdownToHtml(md);
    const bodyHtml = highlightMarkdownCode(html);
    return wrapMarkdownDoc(bodyHtml, hasMath);
}

/** MARKDOWN loader: fetch → marked → dark doc → nonce sandbox iframe path. */
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
        .then(md => {
            const fullHtml = renderMarkdownDoc(md);
            // Always fill the entry (a later return is a hit even if superseded).
            // Keep the RAW markdown source (entry.code, lang "markdown") so the P8
            // edit mode can open a CM over the source; frameHtml is the nonce-
            // stamped rendered doc.
            if (entry) {
                entry.html = fullHtml;
                const nonce = pageNonce();
                entry.frameHtml = nonce ? injectNonce(fullHtml, nonce) : fullHtml;
                entry.code = md;
                entry.codeLang = "markdown";
                entry.loading = false;
                entry.error = null;
            }
            if (!token.isCurrent()) return;
            setArtifactHtml(ctx.content, fullHtml);
            ctx.content.code = md;
            ctx.content.codeLang = "markdown";
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
    /* markdown view has no per-window view-state of its own this phase */
}
function snapshot(): void {
    /* nothing format-specific to park; the shared scrollTop is handled by the engine */
}
function restore(): void {
    /* nothing format-specific to restore */
}

export const MarkdownViewer: Viewer = {
    type: "markdown",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: HtmlBody,
    HeaderControls: DocHeaderControls,
    // The iframe owns its own scroll (the srcdoc document scrolls), so the engine's
    // default .dockview-body scroller doesn't apply — the body has no host scroller
    // to snapshot. No findModel (the rendered iframe has no in-page find target;
    // find is a P8 edit-mode concern). No dispose (the iframe is GC'd with its DOM).
    capabilities: { editable: true } // edit/ mode (P8) rides the markdown viewer
};
