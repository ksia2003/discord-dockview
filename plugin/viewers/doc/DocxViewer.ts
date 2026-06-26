/*
 * The DOCX viewer — type "docx".
 *
 * A .docx is binary OOXML (NOT text), so the loader fetches it as an ArrayBuffer and
 * converts it to HTML with mammoth, then pushes the HTML through the SAME dark
 * sandboxed-iframe document the markdown viewer uses (wrapMarkdownDoc + the engine's
 * nonce machinery via setArtifactHtml). A quiet "Converted from .docx" banner sits at
 * the top as a light affordance that this is a rendering, not the literal file.
 *
 * VIEW-ONLY: there is no editable source for a converted .docx, so it has no
 * HeaderControls and never enters edit mode (no capabilities.editable).
 *
 * mammoth is a plain bundled import (safe at module top); it is only CALLED inside
 * load(). No module-top executable work.
 */

import { escapeHtml } from "../../engine/html";
import { injectNonce, pageNonce, setArtifactHtml } from "../../engine/nonce";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { HtmlBody, wrapMarkdownDoc } from "./iframe";

import * as mammoth from "mammoth";

/** DOCX loader: fetch as ArrayBuffer → mammoth → HTML → dark markdown doc shell →
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
    /* no per-window docx view-state */
}
function snapshot(): void {
    /* nothing format-specific to park */
}
function restore(): void {
    /* nothing format-specific to restore */
}

export const DocxViewer: Viewer = {
    type: "docx",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: HtmlBody,
    // View-only: no HeaderControls (a converted .docx has no editable source), no
    // findModel, no dispose (the iframe is GC'd with its DOM), no editable capability.
};
