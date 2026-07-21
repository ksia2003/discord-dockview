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

import { requestRender } from "../../engine/forceRender";
import { injectNonce, pageNonce, setArtifactHtml } from "../../engine/nonce";
import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, MarkdownViewState, Viewer, ViewerContext
} from "../../engine/types";
import type { FindBarModel } from "../../engine/types";
import { resetEditView, restoreEditState, snapshotEditState } from "../../edit/editMode";
import { CodeBody } from "../text/CodeBody";
import { CodeViewer } from "../text/CodeViewer";
import { DocHeaderControls } from "./DocHeaderControls";
import { HtmlBody, wrapMarkdownDocFull } from "./iframe";
import {
    addHeadingIds, highlightMarkdownCode, markdownToHtml, renderFrontmatterCard, splitFrontmatter
} from "./markdown";

/** The full markdown → dark sandboxed-doc pipeline (marked + code highlight +
 *  KaTeX-aware wrapper). Pulled out so the loader (first render from the fetched
 *  source) and the edit toggle (re-render from the edited buffer) render
 *  identically. Exported so edit/ (the cross-cutting edit layer) and external/
 *  (the pop-out window) re-render markdown the same way the viewer does. */
export function renderMarkdownDoc(md: string): string {
    // Peel a leading YAML frontmatter block off before marked sees it (else the `---`
    // opener becomes a rule and the keys a loose paragraph) and render it as a card.
    const { frontmatter, body } = splitFrontmatter(md);
    const frontmatterHtml = frontmatter != null ? renderFrontmatterCard(frontmatter) : "";
    const { html, hasMath } = markdownToHtml(body);
    // Give headings stable ids + collect the outline for the TOC overlay.
    const withIds = addHeadingIds(html);
    const bodyHtml = highlightMarkdownCode(withIds.html);
    return wrapMarkdownDocFull(bodyHtml, hasMath, frontmatterHtml, withIds.toc);
}

/** The markdown viewer's per-window view-state slice (the TOC open flag). */
export function mdState(win = getActiveWindow()): MarkdownViewState {
    return (win.viewStates.markdown ??= { tocOpen: false }) as MarkdownViewState;
}

/** Does the CURRENT markdown doc have any headings? The rendered frameHtml carries a
 *  `.dv-toc` nav exactly when the outline is non-empty, so the header can gate its
 *  TOC toggle on that without re-parsing. False for a still-loading / empty doc. */
export function markdownHasToc(win = getActiveWindow()): boolean {
    return typeof win.content.frameHtml === "string" && win.content.frameHtml.includes('class="dv-toc"');
}

/** Toggle the markdown TOC overlay. The overlay lives INSIDE the srcdoc iframe (it
 *  scrolls that document), so we flip the view-state for the header's active colour
 *  and postMessage the new state into the iframe. The iframe isn't remounted by this
 *  (no seq bump), so the message reaches the live frame. */
export function toggleMarkdownToc(): void {
    const win = getActiveWindow();
    if (win.content.type !== "markdown" || !markdownHasToc(win)) return;
    const st = mdState(win);
    st.tocOpen = !st.tocOpen;
    postTocState(st.tocOpen);
    requestRender(); // repaint the toggle's active state
}

/** Post the TOC open/close state into the dock's markdown iframe. */
function postTocState(open: boolean): void {
    const frame = document.querySelector<HTMLIFrameElement>("#dockview-root .dockview-body .dockview-frame");
    try { frame?.contentWindow?.postMessage({ __dockViewMdToc: open }, "*"); } catch { /* ignore */ }
}

/** MARKDOWN loader: fetch → marked → dark doc → nonce sandbox iframe path. */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    mdState(ctx.window).tocOpen = false; // a fresh markdown file opens with the TOC closed
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

function createState(): MarkdownViewState {
    return { tocOpen: false };
}
function resetState(vs: MarkdownViewState): void {
    if (vs) vs.tocOpen = false; // a fresh markdown file opens with the TOC closed
}
/** Park the TOC open flag + the cross-cutting edit mode + buffer so a cache return
 *  reopens the TOC state and the edited source / rendered-vs-edit mode. */
function snapshot(vs: MarkdownViewState, entry: CacheEntry, ctx: ViewerContext): void {
    entry.view.mdTocOpen = vs?.tocOpen ?? false;
    snapshotEditState(ctx.window, entry);
}
/** Restore the TOC open flag + the edit mode + buffer (restore runs on the active
 *  window in showContent). */
function restore(vs: MarkdownViewState, entry: CacheEntry): void {
    if (vs) vs.tocOpen = entry.view.mdTocOpen ?? false;
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

export const MarkdownViewer: Viewer<MarkdownViewState> = {
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
