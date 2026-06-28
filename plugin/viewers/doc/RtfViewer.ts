/*
 * The RTF viewer — type "rtf".
 *
 * An .rtf is rich-text MARKUP (plain text with \control words), so the loader
 * fetches it as TEXT and converts it to an HTML fragment with the self-contained
 * rtfToHtml() transform (see rtf.ts — no deps, no Node built-ins, a few KB), then
 * pushes the HTML through the SAME dark sandboxed-iframe document the markdown and
 * docx viewers use (wrapMarkdownDoc + the engine's nonce machinery via
 * setArtifactHtml). A quiet "Converted from .rtf" banner sits at the top as a light
 * affordance that this is a rendering, not the literal file.
 *
 * Why a hand-rolled transform and not a lib: rtf.js is ~11 MB (WMF/EMF canvas
 * rendering) and @iarna/rtf-to-html pulls rtf-parser → iconv-lite/readable-stream,
 * which need Node `buffer`/`stream`/`assert` built-ins Vencord's browser esbuild
 * won't polyfill (verified: that bundle errors out). The focused transform covers
 * what real chat .rtf carries — paragraphs, bold/italic/underline/strike, sub/super,
 * colours, font sizes, alignment, lists, Unicode/hex escapes — and degrades cleanly
 * on the rest (images, tables) rather than rendering broken.
 *
 * VIEW-ONLY: there is no editable source for a converted .rtf, so it has no
 * HeaderControls and never enters edit mode (no capabilities.editable).
 *
 * NO module-top executable work — only imports + function decls; rtfToHtml is only
 * CALLED inside load().
 */

import { escapeHtml } from "../../engine/html";
import { injectNonce, pageNonce, setArtifactHtml } from "../../engine/nonce";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { HtmlBody, wrapMarkdownDoc } from "./iframe";
import { rtfToHtml } from "./rtf";

/** RTF loader: fetch as text → rtfToHtml → HTML fragment → dark markdown doc shell →
 *  nonce sandbox iframe. The verbatim dual-write is preserved (entry always filled,
 *  content only while the token is current). */
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
        .then(text => {
            // Convert the RTF markup to a body HTML fragment, then wrap it in the dark
            // markdown doc shell (no math) so it themes + sandboxes identically.
            const banner = `<div class="dv-docx-note">${escapeHtml("Converted from .rtf")}</div>`;
            const fullHtml = wrapMarkdownDoc(banner + rtfToHtml(text), false);
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
    /* no per-window rtf view-state */
}
function snapshot(): void {
    /* nothing format-specific to park */
}
function restore(): void {
    /* nothing format-specific to restore */
}

export const RtfViewer: Viewer = {
    type: "rtf",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: HtmlBody,
    // View-only: no HeaderControls (a converted .rtf has no editable source), no
    // findModel, no dispose (the iframe is GC'd with its DOM), no editable capability.
};
