/*
 * The MERMAID viewer — type "mermaid".
 *
 * The .mmd/.mermaid source is rendered to an SVG with mermaid (async, dark theme) on
 * the MAIN side, then the finished SVG is dropped into the SAME dark sandboxed iframe
 * the markdown/docx viewers use. mermaid needs the live DOM to lay the diagram out,
 * so we render here and ship only the inert SVG into the (script-free) sandbox — no
 * mermaid runtime ever runs inside the iframe.
 *
 * ★ LAZY INIT (the cycle trap) ★ mermaid.initialize() is NOT called at module top —
 * it self-initializes against the DOM and would do work during the registry↔viewer
 * import cycle. ensureMermaid() runs it exactly once, on the FIRST diagram render.
 * startOnLoad:false (we drive every render explicitly); securityLevel "strict" strips
 * any embedded HTML/JS in node labels so a hostile diagram can't inject script when
 * we drop the SVG in.
 *
 * VIEW-ONLY: no editable source, no HeaderControls, no editable capability.
 *
 * mermaid is a plain bundled import (safe at module top); it is only CALLED inside
 * the functions below. No module-top executable work.
 */

import { escapeHtml } from "../../engine/html";
import { injectNonce, pageNonce, setArtifactHtml } from "../../engine/nonce";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { HtmlBody, wrapMarkdownDoc } from "./iframe";

import mermaid from "mermaid";

// mermaid is initialized once, lazily, on the first diagram render (see LAZY INIT).
let _mermaidReady = false;
function ensureMermaid(): void {
    if (_mermaidReady) return;
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    _mermaidReady = true;
}

/** Render mermaid source to a full dark sandboxed-iframe document. mermaid.render is
 *  async and DOM-dependent, so this returns a Promise<string>. On a parse/render error
 *  we degrade to the raw source in a red <pre> (one bad diagram never throws out of the
 *  loader). The finished SVG is centred in a scrollable dark body. */
async function renderMermaidDoc(src: string): Promise<string> {
    ensureMermaid();
    const id = "dvMermaid" + Math.random().toString(36).slice(2);
    let body: string;
    try {
        const { svg } = await mermaid.render(id, src);
        body = `<div class="dv-mermaid">${svg}</div>`;
    } catch (e) {
        body = `<pre class="dv-mermaid-error">${escapeHtml(String((e as any)?.message || e))}\n\n${escapeHtml(src)}</pre>`;
    }
    // Reuse the markdown doc shell (dark theme, link routing) so the diagram body
    // sits on the same dark page; the mermaid-specific layout rules live in MD_STYLE.
    return wrapMarkdownDoc(body, false);
}

/** MERMAID loader: fetch the diagram source as text → render to SVG → dark sandbox
 *  iframe. The verbatim dual-write is preserved. */
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
        .then(src => renderMermaidDoc(src))
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
    /* no per-window mermaid view-state */
}
function snapshot(): void {
    /* nothing format-specific to park */
}
function restore(): void {
    /* nothing format-specific to restore */
}

export const MermaidViewer: Viewer = {
    type: "mermaid",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: HtmlBody,
    // View-only: no HeaderControls, no findModel, no dispose, no editable capability.
};
