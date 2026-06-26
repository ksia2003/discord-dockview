/*
 * The CODE / TEXT viewer — the Viewer contract over CodeMirror.
 *
 * This is the FIRST real viewer and the backbone the later text-family viewers
 * (csv-raw, structured-raw, markdown-edit, html-edit) reuse: they all render
 * through CodeBody / the CM text engine. Getting the load + view-state + find
 * wiring right here de-risks those phases.
 *
 *  - load(): fetch the file's text (ctx.fetch), write the resolved text into BOTH
 *    the cache entry (always) and the live content (only while the load token is
 *    current) — the verbatim dual-write that keeps a superseded load from leaking
 *    or clobbering.
 *  - createState/resetState: the per-window CodeViewState (find state).
 *  - snapshot/restore: park/restore the find state on the cache entry's view (the
 *    shared scrollTop is handled generically by engine/viewState through
 *    scrollerSelector → .cm-scroller).
 *  - Body/HeaderControls/findModel: the CM body, the row-2 controls, and the find
 *    bar model (only while the find bar is open for a code body).
 *
 * capabilities.editable is declared for the P8 edit/ layer; this phase renders
 * read-only.
 */

import { codeLangFor, extOf } from "../../engine/detectType";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, CodeViewState, FindBarModel, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { CodeBody, codeController, codeState } from "./CodeBody";
import { CodeHeaderControls, toggleCodeFind } from "./CodeHeaderControls";

/** Fetch the file's text and publish it. The dual-write is verbatim: the cache
 *  entry is ALWAYS filled (even if superseded, so a later return is a hit), but the
 *  live content is written ONLY while the token is current (a newer load wins). */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = STRINGS.error.noSource.title;
        return;
    }
    const lang = codeLangFor(extOf(opts.url) || extOf(opts.name));
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

function createState(): CodeViewState {
    return { findOpen: false, findQuery: "", findMatches: 0, findActive: 0, findCase: false };
}

function resetState(vs: CodeViewState): void {
    if (!vs) return;
    vs.findOpen = false;
    vs.findQuery = "";
    vs.findMatches = 0;
    vs.findActive = 0;
    vs.findCase = false;
}

/** Park the find state on the entry so a cache return reopens it as left. (The
 *  shared scrollTop is saved by engine/viewState through scrollerSelector.) The vs
 *  can be missing on the init-order edge window; treat that as the default state. */
function snapshot(vs: CodeViewState, entry: CacheEntry): void {
    entry.view.codeFindOpen = vs?.findOpen ?? false;
    entry.view.codeFindQuery = vs?.findQuery ?? "";
    entry.view.codeFindCase = vs?.findCase ?? false;
}

/** Restore the find state from the entry on a cache return. Match counts/active
 *  are recomputed by CodeBody's rebuildFind once the editor mounts, so we only
 *  carry the query + the toggles. */
function restore(vs: CodeViewState, entry: CacheEntry): void {
    if (!vs) return; // missing slice (init-order edge) — CodeBody back-fills on mount
    vs.findOpen = entry.view.codeFindOpen ?? false;
    vs.findQuery = entry.view.codeFindQuery ?? "";
    vs.findCase = entry.view.codeFindCase ?? false;
    vs.findMatches = 0;
    vs.findActive = 0;
}

/** The find model — a FindBarModel wired to the live "code" controller. Returns
 *  null unless the code find bar is open (so the panel only mounts the bar then). */
function findModel(ctx: ViewerContext): FindBarModel | null {
    const cv = codeState(ctx.window);
    if (!cv.findOpen) return null;
    return {
        query: cv.findQuery,
        matches: cv.findMatches,
        active: cv.findActive,
        caseSensitive: cv.findCase,
        placeholder: STRINGS.find.placeholder,
        setQuery: (q: string) => { cv.findQuery = q; codeController()?.rebuildFind(q); },
        next: () => {
            if (!cv.findMatches) return;
            codeController()?.focusMatch(cv.findActive % cv.findMatches);
        },
        prev: () => {
            if (!cv.findMatches) return;
            codeController()?.focusMatch((cv.findActive - 2 + cv.findMatches) % cv.findMatches);
        },
        toggleCase: () => {
            cv.findCase = !cv.findCase;
            codeController()?.rebuildFind(cv.findQuery);
            ctx.requestRender();
        },
        close: () => toggleCodeFind()
    };
}

export const CodeViewer: Viewer<CodeViewState> = {
    type: "code",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: CodeBody,
    HeaderControls: CodeHeaderControls,
    findModel,
    // CM owns its own scroller, so the scroll snapshot/restore reads through to it.
    scrollerSelector: () => ".cm-scroller",
    capabilities: { editable: true } // edit/ mode (P8) rides the text family
};
