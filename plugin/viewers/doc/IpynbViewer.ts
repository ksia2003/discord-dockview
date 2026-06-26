/*
 * The IPYNB viewer — type "ipynb" (Jupyter notebook).
 *
 * The notebook JSON is fetched, parsed, and its cells are built into ONE HTML
 * document — markdown cells go through the shared marked md→HTML, code cells become
 * a highlighted <pre><code> plus their rendered outputs, with an "In [n]:" prompt
 * gutter echoing the Jupyter layout. That document is pushed through the SAME dark
 * sandboxed-iframe pipeline the markdown viewer uses (wrapMarkdownDoc + the engine's
 * nonce machinery via setArtifactHtml).
 *
 * VIEW-ONLY: there is no editable source, so it never enters edit mode (no
 * HeaderControls, no editable capability). On a JSON parse failure the loader surfaces
 * a load error (the shared error card offers download/open).
 *
 * sanitizeNbHtml strips the obvious script/eval vectors from a notebook's UNTRUSTED
 * text/html or SVG output before injecting it. The iframe is already null-origin +
 * CSP'd (sandbox allow-scripts only, no allow-same-origin reach to the host, the page
 * nonce gates inline script), so this is belt-and-braces to keep the doc from breaking
 * — not the only guard.
 *
 * No module-top executable work — only imports + function decls; the notebook is only
 * built inside load().
 */

import { escapeAttr, escapeHtml } from "../../engine/html";
import { injectNonce, pageNonce, setArtifactHtml } from "../../engine/nonce";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { getHighlighter, highlightCode } from "../text/highlighter";
import { HtmlBody, wrapMarkdownDoc } from "./iframe";
import { highlightMarkdownCode, markdownToHtml } from "./markdown";

/** Coerce a notebook cell's `source` (an array of lines OR a single string per the
 *  nbformat spec) into one string. */
function nbSource(src: any): string {
    if (Array.isArray(src)) return src.join("");
    return typeof src === "string" ? src : "";
}

/** Strip the obvious script/eval vectors from a notebook's untrusted text/html or
 *  SVG output before injecting it. The sandbox iframe is already null-origin + CSP'd
 *  (no allow-same-origin reach to the host, and the page nonce gates inline script),
 *  so this is belt-and-braces to keep the doc from breaking, not the only guard. */
function sanitizeNbHtml(html: string): string {
    return String(html)
        .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
        .replace(/<script\b[^>]*>/gi, "")
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
        .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
        .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
        .replace(/javascript:/gi, "");
}

/** Pick the best MIME representation from an nbformat `data` bundle, in order: rich
 *  HTML, then a raster image (as a data: URI <img>), then plain text. Returns the
 *  output HTML fragment, or "" if nothing renderable. */
function nbDataToHtml(data: any): string {
    if (!data || typeof data !== "object") return "";
    // text/html: prefer it, but it's UNTRUSTED — strip <script>/event handlers and
    // wrap it so a broken fragment can't escape the cell. (Already inside the
    // null-origin, CSP'd sandbox iframe, but we still null out the obvious vectors.)
    if (data["text/html"] != null) {
        const raw = nbSource(data["text/html"]);
        return `<div class="dv-nb-out-html">${sanitizeNbHtml(raw)}</div>`;
    }
    // raster image → a base64 data: URI <img> (png/jpeg/gif are base64 in nbformat).
    for (const mime of ["image/png", "image/jpeg", "image/gif"]) {
        if (data[mime] != null) {
            const b64 = nbSource(data[mime]).replace(/\s+/g, "");
            return `<img class="dv-nb-img" alt="output" src="data:${mime};base64,${escapeAttr(b64)}">`;
        }
    }
    // image/svg+xml is XML text, not base64.
    if (data["image/svg+xml"] != null) {
        return `<div class="dv-nb-out-html">${sanitizeNbHtml(nbSource(data["image/svg+xml"]))}</div>`;
    }
    if (data["text/plain"] != null) {
        return `<pre>${escapeHtml(nbSource(data["text/plain"]))}</pre>`;
    }
    return "";
}

/** Render one code cell's outputs (stream / execute_result / display_data / error)
 *  to an HTML fragment. */
function nbOutputsToHtml(outputs: any[]): string {
    if (!Array.isArray(outputs) || !outputs.length) return "";
    let out = "";
    for (const o of outputs) {
        if (!o || typeof o !== "object") continue;
        const t = o.output_type;
        if (t === "stream") {
            out += `<pre class="dv-nb-out">${escapeHtml(nbSource(o.text))}</pre>`;
        } else if (t === "execute_result" || t === "display_data") {
            const frag = nbDataToHtml(o.data);
            if (frag) out += `<div class="dv-nb-out">${frag}</div>`;
        } else if (t === "error") {
            // strip ANSI colour escapes from the traceback, render it red.
            const tb = Array.isArray(o.traceback) ? o.traceback.join("\n") : String(o.evalue || o.ename || "");
            const clean = tb.replace(/\x1b\[[0-9;]*m/g, "");
            out += `<pre class="dv-nb-out dv-nb-out-err">${escapeHtml(clean)}</pre>`;
        }
    }
    return out;
}

/** Build ONE HTML document body from a parsed notebook's cells. Markdown cells go
 *  through the shared marked md→HTML; code cells become a highlighted <pre><code>
 *  (reusing highlightCode) plus their rendered outputs, with an "In [n]:" prompt
 *  gutter. Returns the inner body HTML (wrapMarkdownDoc supplies the dark shell). */
function notebookToHtml(nb: any): string {
    const cells: any[] = Array.isArray(nb?.cells) ? nb.cells : [];
    // language for code highlighting: notebook metadata, default python.
    const lang0 = (nb?.metadata?.language_info?.name || nb?.metadata?.kernelspec?.language || "python");
    const lang = getHighlighter().getLanguage(String(lang0)) ? String(lang0) : "python";
    const parts: string[] = [];
    let exec = 0;
    for (const cell of cells) {
        if (!cell || typeof cell !== "object") continue;
        const src = nbSource(cell.source);
        if (cell.cell_type === "markdown") {
            const { html } = markdownToHtml(src);
            const body = highlightMarkdownCode(html);
            parts.push(`<div class="dv-nb-cell"><div class="dv-nb-prompt"></div><div class="dv-nb-body dv-nb-md">${body}</div></div>`);
        } else if (cell.cell_type === "code") {
            const n = cell.execution_count != null ? cell.execution_count : (src.trim() ? ++exec : "");
            const codeHtml = highlightCode(src, lang);
            const outHtml = nbOutputsToHtml(cell.outputs);
            parts.push(
                `<div class="dv-nb-cell">` +
                `<div class="dv-nb-prompt">In [${escapeHtml(String(n ?? " "))}]:</div>` +
                `<div class="dv-nb-body"><div class="dv-nb-code"><pre><code class="hljs language-${escapeHtml(lang)}">${codeHtml}</code></pre></div>${outHtml}</div>` +
                `</div>`
            );
        } else if (cell.cell_type === "raw") {
            parts.push(`<div class="dv-nb-cell"><div class="dv-nb-prompt"></div><div class="dv-nb-body"><pre>${escapeHtml(src)}</pre></div></div>`);
        }
    }
    if (!parts.length) return `<p>(empty notebook)</p>`;
    return parts.join('<hr class="dv-nb-sep">');
}

/** IPYNB loader: fetch the notebook (JSON text) → parse → build one HTML document
 *  from its cells → dark sandbox iframe. On a JSON parse failure the throw is caught
 *  and surfaced as a load error. The verbatim dual-write is preserved. */
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
            const nb = JSON.parse(text); // throws → caught below → error card
            const body = notebookToHtml(nb);
            const fullHtml = wrapMarkdownDoc(body, false);
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
    /* no per-window ipynb view-state */
}
function snapshot(): void {
    /* nothing format-specific to park */
}
function restore(): void {
    /* nothing format-specific to restore */
}

export const IpynbViewer: Viewer = {
    type: "ipynb",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: HtmlBody,
    // View-only: no HeaderControls, no findModel, no dispose, no editable capability.
};
