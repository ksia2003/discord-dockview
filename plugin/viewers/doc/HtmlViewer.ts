/*
 * The HTML / ARTIFACT viewer — type "html".
 *
 * A self-contained HTML artifact carries its OWN full document (DCCB delivers
 * artifacts as standalone .html now), so unlike markdown there is NO wrapMarkdownDoc
 * step — we render the artifact verbatim, only stamping the host CSP nonce onto its
 * inline scripts so they run under Discord's CSP.
 *
 * ★ VERBATIM, load-bearing (do not "simplify") ★
 *   - The nonce stamping is engine/nonce.ts (setArtifactHtml → pageNonce + injectNonce).
 *     injectNonce stamps ONLY inline scripts: it skips a <script> that already has a
 *     nonce and skips an external `src=` script (nonce-attr + a src is the classic
 *     trap). Reused, never reimplemented.
 *   - The sandbox is `sandbox="allow-scripts"` ONLY (set in iframe.ts/HtmlBody) — never
 *     allow-same-origin. A srcDoc frame with allow-same-origin inherits THIS document's
 *     origin, so a script in an untrusted-authored artifact could reach the host DOM and
 *     escape the sandbox. A null origin loses nothing here (the link bridge is
 *     postMessage, origin-agnostic).
 *
 * load() handles BOTH sources, mirroring the monolith's loadHtml:
 *   - inline html (opts.code, no url) — set the artifact directly; not cached.
 *   - url-backed html — fetch the text, stamp the nonce, dual-write entry + content.
 * The PRISTINE html source is kept in content.code (lang "html") as the immutable
 * edit/merge baseline the P8 edit layer opens — separate from the rendered frameHtml.
 *
 * Body = the shared HtmlBody iframe shell. HeaderControls = the view-only copy-source
 * row (DocHeaderControls); the rendered↔edit-html toggle is P8. capabilities.editable
 * is declared for that P8 layer; this phase renders read-only.
 *
 * No module-top work — only imports + function decls; the nonce is read at load time.
 */

import { React } from "@vencord/types/webpack/common";

import { injectNonce, pageNonce, setArtifactHtml } from "../../engine/nonce";
import { ensureIframeLinkBridge } from "../../engine/iframeLinkBridge";
import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, FindBarModel, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { resetEditView, restoreEditState, snapshotEditState } from "../../edit/editMode";
import { CodeBody } from "../text/CodeBody";
import { CodeViewer } from "../text/CodeViewer";
import { DocHeaderControls } from "./DocHeaderControls";
import { HtmlBody } from "./iframe";

/** HTML / artifact loader. Inline html (opts.code) renders directly (not cached);
 *  a url-backed artifact is fetched, nonce-stamped, and dual-written. */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    resetEditView(ctx.window); // a fresh artifact opens rendered + unedited
    // Inline artifact (no url) — the html came in on opts.code. Render it straight,
    // stash the pristine source as the edit baseline. Inline html is never cached
    // (no url to key on), so `entry` is null here.
    if (opts.code != null) {
        setArtifactHtml(ctx.content, opts.code);
        // Keep the PRISTINE html source in content.code (the immutable merge-diff
        // baseline + P8 edit source), separate from the rendered content.html.
        ctx.content.code = opts.code;
        ctx.content.codeLang = "html";
        ctx.content.loading = false;
        ctx.content.error = null;
        return;
    }
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
            // Always fill the entry. Stamp the nonce onto the entry's frameHtml the
            // same way setArtifactHtml stamps the live content, and stash the pristine
            // source (entry.code, lang "html") as the P8 edit baseline.
            if (entry) {
                entry.html = text;
                const nonce = pageNonce();
                const bridged = ensureIframeLinkBridge(text);
                entry.frameHtml = nonce ? injectNonce(bridged, nonce) : bridged;
                entry.code = text;
                entry.codeLang = "html";
                entry.loading = false;
                entry.error = null;
            }
            if (!token.isCurrent()) return;
            setArtifactHtml(ctx.content, text);
            ctx.content.code = text;
            ctx.content.codeLang = "html";
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
    /* html has no per-window view-state of its own (edit mode rides editView) */
}
/** Park the cross-cutting edit mode + buffer so a cache return reopens the edited
 *  html source / the rendered-vs-edit mode (html has no format-specific view-state).
 *  Inline artifacts (no url) have no cache entry, so this only fires for url-backed. */
function snapshot(_vs: unknown, entry: CacheEntry, ctx: ViewerContext): void {
    snapshotEditState(ctx.window, entry);
}
/** Restore the edit mode + buffer (restore runs on the active window in showContent). */
function restore(_vs: unknown, entry: CacheEntry): void {
    restoreEditState(getActiveWindow(), entry);
}

/** The html body dispatcher: the rendered sandboxed iframe in VIEW mode; the shared
 *  editable CodeBody over the html source in EDIT mode (the edit/ capability rides
 *  this body swap — toggleEditMode bumps content.seq + re-stamps on the way back). */
function HtmlBodyDispatch() {
    return getActiveWindow().editView.mode === "edit"
        ? React.createElement(CodeBody, null)
        : React.createElement(HtmlBody, null);
}

/** Find only has a target in EDIT mode (the editable CM over the html source); the
 *  rendered artifact has no in-page find target, so VIEW mode returns null. */
function findModel(ctx: ViewerContext): FindBarModel | null {
    if (ctx.window.editView.mode !== "edit") return null;
    return CodeViewer.findModel ? CodeViewer.findModel(ctx) : null;
}

export const HtmlViewer: Viewer = {
    type: "html",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: HtmlBodyDispatch,
    HeaderControls: DocHeaderControls,
    findModel,
    // VIEW mode: the srcdoc iframe owns its own scroll (no host scroller). EDIT mode:
    // the CM editor owns the scroll, so the snapshot/restore reads through to it.
    scrollerSelector: (ctx: ViewerContext) =>
        ctx.window.editView.mode === "edit" ? ".cm-scroller" : "",
    capabilities: { editable: true } // edit/ mode rides the html viewer
};
