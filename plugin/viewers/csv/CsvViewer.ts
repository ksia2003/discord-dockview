/*
 * The CSV / TSV viewer — type "csv".
 *
 * Two sub-views over one file: a spreadsheet GRID (the default) and a RAW text
 * view. The raw view is NOT a second editor — it reuses the text family's CodeBody
 * over the same content.code, so find/highlight/copy come for free. The header's
 * grid↔raw toggle bumps content.seq; the body dispatcher below then remounts the
 * other body fresh (the seq-swap CsvBody/CodeBody key on).
 *
 *  - load(): fetch the text into content.code (so the raw view is the very same
 *    code body) and DECIDE the delimiter. xlsx-origin content arrives already
 *    retyped to "csv" with the text in content.code (XlsxViewer did the work), so
 *    this loader's url path also handles the plain .csv/.tsv case. The dual-write is
 *    verbatim: always fill the entry, only write content while the token is current.
 *  - createState/resetState: a fresh CSV always opens as the GRID.
 *  - snapshot/restore: park the grid/raw mode on the entry; on restore re-derive the
 *    delimiter from the cached name/url/text (the old mountFromCache did this inline;
 *    the rewrite's engine leaves it to the viewer — see the RESTORE note).
 *  - Body = the grid/raw dispatcher. HeaderControls = CsvHeaderControls.
 *  - findModel: only in raw mode → delegate to the code find; null in grid mode.
 *  - scrollerSelector: .dockview-csv-scroll in grid, .cm-scroller in raw.
 *
 * No module-top work: only imports, function/const declarations. The dispatcher
 * reads React + the active window at call time.
 */

import { React } from "@webpack/common";

import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, CsvViewState, FindBarModel, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { resetEditView, restoreEditState, snapshotEditState } from "../../edit/editMode";
import { CodeBody, codeState } from "../text/CodeBody";
import { CodeViewer } from "../text/CodeViewer";
import { CsvBody, csvState } from "./CsvBody";
import { CsvHeaderControls } from "./CsvHeaderControls";
import { csvDelimiterFor } from "./parse";

/** CSV / TSV loader: fetch text into content.code (so RAW is the same code body)
 *  plus decide the delimiter. The grid is parsed lazily from content.code on mount
 *  (CsvBody) so the cache stays text-only. The raw view is plaintext (no hljs lang). */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    const cv = csvState(ctx.window);
    cv.mode = "grid"; // a fresh CSV always opens as a grid
    // A plain .csv/.tsv has no cell addresses/formulas — clear any leftover xlsx grid
    // flags on this reused slice so the csv grid stays coord-free.
    cv.cellCoords = false;
    cv.formulaCells = undefined;
    resetEditView(ctx.window); // a fresh CSV opens unedited (the raw view shares the buffer)
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = STRINGS.error.noSource.title;
        return;
    }
    ctx.content.codeLang = "plaintext"; // the raw view is plaintext (no hljs lang)
    if (entry) entry.codeLang = "plaintext";
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
            csvState(ctx.window).delimiter = csvDelimiterFor(opts.name, reqUrl, text);
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

function createState(): CsvViewState {
    return { mode: "grid", delimiter: "," };
}

function resetState(vs: CsvViewState): void {
    if (!vs) return;
    vs.mode = "grid"; // a fresh CSV always opens as a grid (per-file default)
    vs.delimiter = ",";
    vs.cellCoords = false; // csv has no cell coords/formulas (xlsx-only)
    vs.formulaCells = undefined;
}

/** Park the grid/raw choice on the entry so a cache return reopens it as left, plus
 *  the cross-cutting edit buffer (the raw view shares the edit buffer). The delimiter
 *  isn't persisted (cheap to re-derive); the shared scrollTop is saved by
 *  engine/viewState through scrollerSelector. */
function snapshot(vs: CsvViewState, entry: CacheEntry, ctx: ViewerContext): void {
    entry.view.csvMode = vs?.mode ?? "grid";
    snapshotEditState(ctx.window, entry);
}

/** Restore the grid/raw choice on a cache return and RE-DERIVE the delimiter from
 *  the cached name/url/text (the old mountFromCache did this inline; the rewrite's
 *  engine leaves it to the viewer). Also reset the shared code find — find never
 *  persists across files, so a restored CSV opens with the find bar closed. */
function restore(vs: CsvViewState, entry: CacheEntry): void {
    if (!vs) return; // missing slice (init-order edge) — CsvBody back-fills on mount
    vs.mode = entry.view.csvMode ?? "grid";
    // re-sniff the delimiter from the restored text so the grid parses identically.
    vs.delimiter = csvDelimiterFor(entry.name, entry.url, entry.code ?? "");
    // find never persists across files — clear the reused code find slice (restore
    // runs on the active window in showContent, so codeState() reaches the right one).
    CodeViewer.resetState(codeState());
    // restore the edit buffer (raw editing shares it); the mode is forced to view
    // for csv (the grid/raw choice rides csvMode above) inside restoreEditState.
    restoreEditState(getActiveWindow(), entry);
}

/** The find model — raw mode delegates to the code find (the raw view IS a code
 *  body); grid mode has no in-page find target, so return null. */
function findModel(ctx: ViewerContext): FindBarModel | null {
    if (csvState(ctx.window).mode !== "raw") return null;
    return CodeViewer.findModel ? CodeViewer.findModel(ctx) : null;
}

/** The CSV body dispatcher: GRID (CsvBody) by default, RAW (the shared CodeBody)
 *  when toggled. Keyed on content.seq by the panel dispatcher, so a toggle (which
 *  bumps seq) remounts the OTHER body fresh. */
function CsvBodyDispatch() {
    return csvState().mode === "raw"
        ? React.createElement(CodeBody, null)
        : React.createElement(CsvBody, null);
}

export const CsvViewer: Viewer<CsvViewState> = {
    type: "csv",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: CsvBodyDispatch,
    HeaderControls: CsvHeaderControls,
    findModel,
    // grid owns its own horizontal scroller; raw rides CM's scroller.
    scrollerSelector: (ctx: ViewerContext) =>
        csvState(ctx.window).mode === "grid" ? ".dockview-csv-scroll" : ".cm-scroller"
};
