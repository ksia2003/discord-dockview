/*
 * The STRUCTURED (JSON / XML) viewer — type "structured".
 *
 * Two sub-views over one file: an interactive collapsible TREE (the default) and a
 * RAW text view. The raw view is NOT a second editor — it reuses the text family's
 * CodeBody over the same content.code (highlighted as json/xml), so find/copy come
 * for free. The header's tree↔raw toggle bumps content.seq; the body dispatcher
 * then remounts the other body fresh (the seq-swap StructuredBody/CodeBody key on).
 *
 *  - load(): fetch the text into content.code (so RAW is the very same code body)
 *    and DERIVE the kind (json|xml) + the hljs lang from the extension. The dual-
 *    write is verbatim: always fill the entry, only write content while the token
 *    is current.
 *  - createState/resetState: a fresh file always opens as the TREE.
 *  - snapshot/restore: park the tree/raw mode on the entry; on restore re-derive the
 *    json/xml kind from the cached name/url (the old mountFromCache did this inline;
 *    the rewrite's engine leaves it to the viewer — see the RESTORE note).
 *  - Body = the tree/raw dispatcher. HeaderControls = StructuredHeaderControls.
 *  - findModel: only in raw mode → delegate to the code find; null in tree mode.
 *  - scrollerSelector: .dockview-tree-scroll in tree, .cm-scroller in raw.
 *
 * No module-top work: only imports, function/const declarations. The dispatcher
 * reads React + the active window at call time.
 */

import { React } from "@webpack/common";

import { extOf } from "../../engine/detectType";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, FindBarModel, LoadOpts, LoadToken, TreeViewState, Viewer, ViewerContext
} from "../../engine/types";
import { CodeBody, codeState } from "../text/CodeBody";
import { CodeViewer } from "../text/CodeViewer";
import { StructuredBody, treeState } from "./StructuredBody";
import { StructuredHeaderControls } from "./StructuredHeaderControls";

/** Derive the structured kind (json|xml) from a file extension. .xml → xml; .json /
 *  .json5 (and anything else routed here) → json. */
function kindFor(name: string | null, url: string | null): "json" | "xml" {
    const ext = extOf(url) || extOf(name);
    return ext === "xml" ? "xml" : "json";
}

/** STRUCTURED loader: fetch text into content.code (so RAW is the same code body)
 *  plus derive the kind + lang from the extension. The tree is parsed lazily from
 *  content.code on mount (StructuredBody) so the cache stays text-only. */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    treeState(ctx.window).mode = "tree"; // a fresh file always opens as the tree
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = STRINGS.error.noSource.title;
        return;
    }
    const kind = kindFor(opts.name, opts.url);
    const lang = kind === "xml" ? "xml" : "json";
    treeState(ctx.window).kind = kind;
    ctx.content.codeLang = lang;
    if (entry) entry.codeLang = lang;
    ctx.content.loading = true;
    const reqUrl = opts.url;
    ctx.fetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.text();
        })
        .then(text => {
            if (entry) { entry.code = text; entry.loading = false; entry.error = null; }
            if (!token.isCurrent()) return;
            ctx.content.code = text;
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

function createState(): TreeViewState {
    return { mode: "tree", kind: "json" };
}

function resetState(vs: TreeViewState): void {
    if (!vs) return;
    vs.mode = "tree"; // a fresh file always opens as the tree
    // kind is set by the loader from the extension; leave it.
}

/** Park the tree/raw choice on the entry so a cache return reopens it as left. */
function snapshot(vs: TreeViewState, entry: CacheEntry): void {
    entry.view.treeMode = vs?.mode ?? "tree";
}

/** Restore the tree/raw choice on a cache return and RE-DERIVE the json/xml kind
 *  from the cached name/url extension (the old mountFromCache did this inline; the
 *  rewrite's engine leaves it to the viewer). Also reset the shared code find — find
 *  never persists across files, so a restored file opens with the find bar closed. */
function restore(vs: TreeViewState, entry: CacheEntry): void {
    if (!vs) return; // missing slice (init-order edge) — StructuredBody back-fills on mount
    vs.mode = entry.view.treeMode ?? "tree";
    // re-derive the kind so the tree body parses identically on a cache return.
    vs.kind = kindFor(entry.name, entry.url);
    // find never persists across files — clear the reused code find slice (restore
    // runs on the active window in showContent, so codeState() reaches the right one).
    CodeViewer.resetState(codeState());
}

/** The find model — raw mode delegates to the code find (the raw view IS a code
 *  body); tree mode has no in-page find target, so return null. */
function findModel(ctx: ViewerContext): FindBarModel | null {
    if (treeState(ctx.window).mode !== "raw") return null;
    return CodeViewer.findModel ? CodeViewer.findModel(ctx) : null;
}

/** The STRUCTURED body dispatcher: TREE (StructuredBody) by default, RAW (the shared
 *  CodeBody) when toggled. Keyed on content.seq by the panel dispatcher, so a toggle
 *  (which bumps seq) remounts the OTHER body fresh. */
function StructuredBodyDispatch() {
    return treeState().mode === "raw"
        ? React.createElement(CodeBody, null)
        : React.createElement(StructuredBody, null);
}

export const StructuredViewer: Viewer<TreeViewState> = {
    type: "structured",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: StructuredBodyDispatch,
    HeaderControls: StructuredHeaderControls,
    findModel,
    // tree owns its own scroller; raw rides CM's scroller.
    scrollerSelector: (ctx: ViewerContext) =>
        treeState(ctx.window).mode === "tree" ? ".dockview-tree-scroll" : ".cm-scroller"
};
