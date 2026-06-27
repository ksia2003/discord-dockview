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

import { React } from "@webpack/common";

import { injectNonce, pageNonce, setArtifactHtml } from "../../engine/nonce";
import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import type { FindBarModel } from "../../engine/types";
import { resetEditView, restoreEditState, snapshotEditState } from "../../edit/editMode";
import { CodeBody } from "../text/CodeBody";
import { CodeViewer } from "../text/CodeViewer";
import { DocHeaderControls } from "./DocHeaderControls";
import { HtmlBody, wrapMarkdownDoc } from "./iframe";
import { highlightMarkdownCode, markdownToHtml } from "./markdown";

/** The full markdown → dark sandboxed-doc pipeline (marked + code highlight +
 *  KaTeX-aware wrapper). Pulled out so the loader (first render from the fetched
 *  source) and the edit toggle (re-render from the edited buffer) render
 *  identically. Exported so edit/ (the cross-cutting edit layer) and external/
 *  (the pop-out window) re-render markdown the same way the viewer does. */
export function renderMarkdownDoc(md: string): string {
    const { html, hasMath } = markdownToHtml(md);
    const bodyHtml = highlightMarkdownCode(html);
    return wrapMarkdownDoc(bodyHtml, hasMath);
}

/** MARKDOWN loader: fetch → marked → dark doc → nonce sandbox iframe path. */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    resetEditView(ctx.window); // a fresh markdown file opens rendered + unedited
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
    /* markdown has no per-window view-state of its own (edit mode rides editView) */
}
/** Park the cross-cutting edit mode + buffer so a cache return reopens the edited
 *  source / the rendered-vs-edit mode (markdown has no format-specific view-state). */
function snapshot(_vs: unknown, entry: CacheEntry, ctx: ViewerContext): void {
    snapshotEditState(ctx.window, entry);
}
/** Restore the edit mode + buffer (restore runs on the active window in showContent). */
function restore(_vs: unknown, entry: CacheEntry): void {
    restoreEditState(getActiveWindow(), entry);
}

/** The markdown body dispatcher: the rendered dark iframe in VIEW mode; the shared
 *  editable CodeBody over the raw md source in EDIT mode (the edit/ capability rides
 *  this body swap — toggleEditMode bumps content.seq + re-renders on the way back). */
function MarkdownBodyDispatch() {
    return getActiveWindow().editView.mode === "edit"
        ? React.createElement(CodeBody, null)
        : React.createElement(HtmlBody, null);
}

/** Find only has a target in EDIT mode (the editable CM over the raw source); the
 *  rendered iframe has no in-page find target, so VIEW mode returns null. */
function findModel(ctx: ViewerContext): FindBarModel | null {
    if (ctx.window.editView.mode !== "edit") return null;
    return CodeViewer.findModel ? CodeViewer.findModel(ctx) : null;
}

export const MarkdownViewer: Viewer = {
    type: "markdown",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: MarkdownBodyDispatch,
    HeaderControls: DocHeaderControls,
    findModel,
    // VIEW mode: the srcdoc iframe owns its own scroll (no host scroller). EDIT mode:
    // the CM editor owns the scroll, so the snapshot/restore reads through to it.
    scrollerSelector: (ctx: ViewerContext) =>
        ctx.window.editView.mode === "edit" ? ".cm-scroller" : "",
    capabilities: { editable: true } // edit/ mode rides the markdown viewer
};
