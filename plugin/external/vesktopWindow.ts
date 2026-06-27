/*
 * Pop-out — open the CURRENT doc / artifact in a separate Vesktop window.
 *
 * external/openExternal.ts owns the low-level reliable open (the empty-window +
 * document.write path that rides Chromium's about:blank rule, so it opens an in-app
 * BrowserWindow regardless of the "Open Links in app" setting) plus the url-only
 * embed shell the state cards use. THIS module builds the per-content-type document
 * from the LIVE content (+ the edit buffer) so "Open in browser" / "Pop out" shows
 * the same thing the dock shows:
 *   - html / docx / mermaid / graphviz / ipynb — their own full rendered document
 *     (html shows the edited buffer when edited);
 *   - markdown — the SAME rendered dark doc the viewer iframe shows (reuse the
 *     render pipeline), edited buffer when edited;
 *   - code / csv-raw / structured-raw / unknown — raw text in a <pre>;
 *   - pdf — the file embedded by its working url (<embed>);
 *   - image — the file centred on a dark backdrop by its working url.
 *
 * No module-top work: only imports + function decls. renderMarkdownDoc (which lazily
 * registers marked) and the edit buffer are reached only inside vesktopWindowHtml.
 */

import { escapeHtml } from "../engine/html";
import { getActiveWindow } from "../engine/window";
import type { DockWindow } from "../engine/types";
import { editBufferText } from "../edit/editMode";
import { renderMarkdownDoc } from "../viewers/doc/MarkdownViewer";
import { absUrl, openUrlInVesktopWindow, openVesktopWindow } from "./openExternal";

// Minimal dark page chrome shared by the per-type shells so the popped-out window
// reads like the dock (dark bg, no margins, fills the viewport).
const VESKTOP_WINDOW_CSS =
    "html,body{margin:0;padding:0;height:100%;background:#1e1f22;color:#dbdee1;"
    + "font-family:'gg sans','Noto Sans',Helvetica,Arial,sans-serif;}";

/** The HTML document to show when opening the CURRENT file in a Vesktop window,
 *  picked per content type. URL-backed types embed by their WORKING url (the same
 *  url the panel loaded + copy-link copies); text-ish types write their content
 *  directly. Returns null when there's nothing to show (null → the caller falls
 *  back to embedding the url, or no-ops). */
export function vesktopWindowHtml(w: DockWindow = getActiveWindow()): string | null {
    const type = w.content.type;
    const url = w.content.url ? absUrl(w.content.url) : null;

    // html / inline artifact — the artifact document itself. When edited, show the
    // edited buffer; else the original html. docx (mammoth->HTML), mermaid (->SVG),
    // graphviz, ipynb are view-only and store their FULL rendered dark doc in
    // content.html, so they pop out exactly that document.
    if (type === "html" || type === "docx" || type === "mermaid" || type === "graphviz" || type === "ipynb") {
        const html = (type === "html" && w.editView.editBuffer != null) ? editBufferText(w) : w.content.html;
        return html || null;
    }
    // markdown — the SAME rendered dark document the viewer iframe shows (reuse the
    // render pipeline). Edited buffer when edited, else the raw source.
    if (type === "markdown") {
        const md = (w.editView.editBuffer != null) ? editBufferText(w) : (w.content.code || "");
        return renderMarkdownDoc(md);
    }
    // code / csv-raw / structured-raw / unknown-as-text — raw text in a <pre>.
    if (type === "code" || type === "csv" || type === "structured" || type === "unknown") {
        const text = (w.content.code != null)
            ? ((w.editView.editBuffer != null) ? editBufferText(w) : w.content.code)
            : "";
        const pre = `<pre style="margin:0;padding:16px;white-space:pre-wrap;word-break:break-word;`
            + `font-family:Menlo,Consolas,'Courier New',monospace;font-size:13px;line-height:1.5;`
            + `color:#dbdee1;">${escapeHtml(text)}</pre>`;
        return `<!doctype html><html><head><meta charset="utf-8"><style>${VESKTOP_WINDOW_CSS}</style></head><body>${pre}</body></html>`;
    }
    // pdf — embed the file by url (the working url). <embed> renders the PDF via the
    // built-in viewer; <iframe> is the fallback the browser uses if <embed> fails.
    if (type === "pdf" && url) {
        const body = `<embed src="${escapeHtml(url)}" type="application/pdf" `
            + `style="position:fixed;inset:0;width:100%;height:100%;border:none;">`;
        return `<!doctype html><html><head><meta charset="utf-8"><style>${VESKTOP_WINDOW_CSS}</style></head><body>${body}</body></html>`;
    }
    // image — the file centred on a dark backdrop (the working url).
    if (type === "image" && url) {
        const body = `<div style="position:fixed;inset:0;display:flex;align-items:center;`
            + `justify-content:center;background:#1e1f22;">`
            + `<img src="${escapeHtml(url)}" alt="" style="max-width:100%;max-height:100%;object-fit:contain;"></div>`;
        return `<!doctype html><html><head><meta charset="utf-8"><style>${VESKTOP_WINDOW_CSS}</style></head><body>${body}</body></html>`;
    }
    return null;
}

/** Open the CURRENTLY-shown file in a real in-app Vesktop window (the default "Open
 *  in browser" — an in-app window, NOT the external browser). One reliable path for
 *  every viewer: build the per-type shell, then open the empty window and write it.
 *  Falls back to embedding the url (state-card path) when there's a url but no
 *  renderable in-memory content (e.g. a still-loading file). */
export function openInVesktopWindow(w: DockWindow = getActiveWindow()): void {
    const html = vesktopWindowHtml(w);
    const name = (w.content.name as string | null) || "file";
    if (html) { openVesktopWindow(html, name); return; }
    if (w.content.url) openUrlInVesktopWindow(w.content.url, name);
}

/** Pop the current (or given) artifact out into a standalone in-app Vesktop window.
 *  Kept for the artifact popout + the debug surface; shares the one reliable
 *  empty-window + write path. */
export function popoutArtifact(html?: string | null, name?: string | null): void {
    const win = getActiveWindow();
    const h = html ?? win.content.html;
    const n = name ?? (win.content.name as string | null) ?? "artifact";
    if (!h) return;
    openVesktopWindow(h, n);
}
