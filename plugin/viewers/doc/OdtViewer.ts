/*
 * The ODT viewer — type "odt" (OpenDocument Text).
 *
 * An .odt is a ZIP of ODF XML (binary), so the loader fetches it as an ArrayBuffer
 * and converts it to an HTML fragment with the lightweight odtToHtml() transform
 * (see odt.ts — fflate unzip + native DOMParser, no webodf), then pushes the HTML
 * through the SAME dark sandboxed-iframe document the markdown / docx viewers use
 * (wrapMarkdownDoc + the engine's nonce machinery via setArtifactHtml). A quiet
 * "Converted from .odt" banner sits at the top as a light affordance that this is a
 * rendering, not the literal file.
 *
 * Embedded pictures are resolved out of the zip to data: URLs inside odtToHtml(), so
 * they render inside the null-origin sandbox with no network fetch.
 *
 * VIEW-ONLY: there is no editable source for a converted .odt, so it has no
 * HeaderControls and never enters edit mode (no capabilities.editable).
 *
 * NO module-top executable work — only imports + function decls; odtToHtml is only
 * CALLED inside load().
 */

import { escapeHtml } from "../../engine/html";
import { injectNonce, pageNonce, setArtifactHtml } from "../../engine/nonce";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { HtmlBody, wrapMarkdownDoc } from "./iframe";
import { odtToHtml } from "./odt";

/** ODT loader: fetch as ArrayBuffer → odtToHtml (unzip + ODF→HTML) → dark markdown doc
 *  shell → nonce sandbox iframe. The verbatim dual-write is preserved (entry always
 *  filled, content only while the token is current). */
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
        .then(buf => {
            const banner = `<div class="dv-docx-note">${escapeHtml("Converted from .odt")}</div>`;
            const fullHtml = wrapMarkdownDoc(banner + odtToHtml(new Uint8Array(buf)), false);
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
    /* no per-window odt view-state */
}
function snapshot(): void {
    /* nothing format-specific to park */
}
function restore(): void {
    /* nothing format-specific to restore */
}

export const OdtViewer: Viewer = {
    type: "odt",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: HtmlBody,
    // View-only: no HeaderControls (a converted .odt has no editable source), no
    // findModel, no dispose (the iframe is GC'd with its DOM), no editable capability.
};
