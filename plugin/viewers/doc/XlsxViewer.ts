/*
 * The spreadsheet viewer — type "xlsx" (xlsx/xls/xlsm/ods).
 *
 * A .xlsx/.xls/.xlsm/.ods is a binary/zipped workbook of MANY sheets. The loader
 * fetches it as an ArrayBuffer, reads the workbook with SheetJS ONCE, and serialises
 * EVERY sheet to RFC-4180 CSV text — keeping the ordered sheet names + per-sheet CSV
 * on the cache entry (entry.xlsxWorkbook) and the live content (content.xlsx), the
 * same way pdf/3D/pptx persist their heavy parsed handle. The body (XlsxBody) then
 * feeds the ACTIVE sheet's CSV into the existing csv GRID and renders an Excel-style
 * bottom sheet-tab strip; switching sheets re-feeds that sheet's text — no re-fetch,
 * no re-parse.
 *
 * This is a real surface (the render type STAYS "xlsx"), NOT the old retype-to-"csv"
 * trick — a workbook has sheets, a plain .csv/.tsv does not, so the two diverge: the
 * csv viewer keeps its single-sheet grid↔raw toggle; the xlsx viewer adds the sheet
 * switcher around the SAME grid (it reuses CsvBody, it does not reinvent it).
 *
 * SheetJS (XLSX) is pulled in with a DYNAMIC import() routed through engine/lazyLib,
 * so its module top-level leaves Vencord startup and only runs on the first workbook
 * opened, behind a "Loading spreadsheet viewer…" dock state. NEVER add a static
 * `import … from "xlsx"` here or in XlsxBody.
 */

import { getCacheEntry } from "../../engine/cache";
import { loadLib, withLibLoading } from "../../engine/lazyLib";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext, XlsxViewState
} from "../../engine/types";
import { parseDelimited } from "../csv/parse";
import { XlsxBody, resetXlsxView, xlsxState } from "./XlsxBody";
import { extractCharts, hasCharts, type SheetCharts } from "./XlsxCharts";
import { XlsxHeaderControls } from "./XlsxHeaderControls";

/** Spreadsheet loader: fetch as ArrayBuffer → SheetJS reads the whole workbook →
 *  serialise EVERY sheet to CSV → keep names + per-sheet CSV on the entry + live
 *  content. The body renders the active sheet through the csv grid. */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    // Reset the live workbook BEFORE the fetch (mirrors pptx/3D): clear the previous
    // sheets and BUMP renderToken so the body drops the stale workbook.
    ctx.content.xlsx = { names: [], csv: [], formulas: [], charts: [], renderToken: ctx.content.xlsx.renderToken + 1 };
    resetXlsxView(ctx.window);
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
        .then(async buf => {
            // Keep the raw workbook bytes so the charts (which SheetJS drops) can be
            // extracted from the zip AFTER the grid is up — the bytes ride on the return
            // value and are handed to extractCharts in a follow-up microtask.
            const bytes = new Uint8Array(buf);
            const XLSX: any = await withLibLoading(ctx, STRINGS.loading.lib.xlsx, "xlsx",
                async () => await import("xlsx"));
            // cellFormula:true keeps each cell's .f (its formula text) so the body's
            // formula bar can read it; without it SheetJS drops formulas and only the
            // cached value survives. Everything else (the CSV serialisation below) is
            // unchanged — the value view is identical.
            const wb = XLSX.read(bytes, { type: "array", cellFormula: true });
            const names: string[] = Array.isArray(wb.SheetNames) ? wb.SheetNames : [];
            // sheet_to_csv emits RFC-4180 CSV (comma delimiter, quoted as needed),
            // which the csv grid's parser reads back unchanged. One pass over every
            // sheet so the body can switch with no re-parse.
            const csv: string[] = names.map(n => {
                const sheet = wb.Sheets[n];
                return sheet ? XLSX.utils.sheet_to_csv(sheet) : "";
            });
            // A SPARSE formula map per sheet: "row,col" (0-based, matching the csv
            // grid's cell coords — row 0 is the CSV's first line, which is the sheet's
            // first row) -> the cell's formula text. Only cells that carry a formula
            // land here, so even a huge sheet keeps a small map. A sheet with no
            // formulas (or a csv-origin workbook) yields {}.
            const formulas: Record<string, string>[] = names.map(n => {
                const sheet = wb.Sheets[n];
                const map: Record<string, string> = {};
                const ref = sheet && sheet["!ref"];
                if (!sheet || !ref) return map;
                const range = XLSX.utils.decode_range(ref);
                for (let R = range.s.r; R <= range.e.r; R++) {
                    for (let C = range.s.c; C <= range.e.c; C++) {
                        const cell = sheet[XLSX.utils.encode_cell({ r: R, c: C })];
                        if (cell && typeof cell.f === "string" && cell.f.length) {
                            // grid coords are relative to the CSV's first row/col (0-based
                            // from the sheet's own origin), which decode_range gives via s.
                            map[(R - range.s.r) + "," + (C - range.s.c)] = cell.f;
                        }
                    }
                }
                return map;
            });
            // A workbook with no sheets at all is degenerate — show the empty grid
            // rather than erroring (matches the old first-sheet "" fallback).
            return {
                names: names.length ? names : [""],
                csv: csv.length ? csv : [""],
                formulas: formulas.length ? formulas : [{}],
                bytes
            };
        })
        .then((book: { names: string[]; csv: string[]; formulas: Record<string, string>[]; bytes: Uint8Array }) => {
            // Charts start empty; extractWorkbookCharts fills them after the grid paints
            // (a chart-free workbook stays at []). The parallel array is sized to sheets.
            const charts: any[][] = book.names.map(() => []);
            // Only keep the workbook on `entry` if it is STILL the cache's live entry
            // for its key (a rapid re-click could have replaced it). Plain text, no
            // teardown — no leak to guard against.
            const live = entry != null && getCacheEntry(entry.key) === entry;
            if (live) {
                entry!.xlsxWorkbook = { names: book.names, csv: book.csv, formulas: book.formulas, charts };
                entry!.loading = false;
                entry!.error = null;
            }
            if (!token.isCurrent()) return; // superseded — don't touch content
            ctx.content.xlsx.names = book.names;
            ctx.content.xlsx.csv = book.csv;
            ctx.content.xlsx.formulas = book.formulas;
            ctx.content.xlsx.charts = charts;
            ctx.content.xlsx.renderToken += 1; // a fresh workbook is ready
            // Fill the sheet names on the view-state now (the tab strip can render),
            // and clamp the (possibly cache-restored) selected sheet into range.
            const vs = xlsxState(ctx.window);
            vs.names = book.names;
            vs.sheet = Math.min(Math.max(0, vs.sheet || 0), book.names.length - 1);
            ctx.content.loading = false;
            ctx.content.loadingLabel = null;
            ctx.content.error = null;
            ctx.requestRender();
            // Extract the embedded charts AFTER the grid is up so a big workbook never
            // regresses open time. The bytes are dropped once parsed (no long-lived
            // ArrayBuffer). Failures are swallowed — charts are additive, never fatal.
            extractWorkbookCharts(ctx, token, entry, book.names, book.csv, book.bytes);
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (!token.isCurrent()) return;
            ctx.content.loading = false;
            ctx.content.loadingLabel = null;
            ctx.content.error = String(e?.message || e);
            ctx.requestRender();
        });
}

/**
 * Extract the workbook's embedded charts (which SheetJS ignores) from the raw zip bytes,
 * off the open path so a big workbook never pays for it before the grid paints. Uses
 * fflate to unzip ONLY the small chart/drawing/rels/workbook XML parts (a filter skips
 * decompressing the big sheet/sharedStrings data SheetJS already parsed), so a chart-free
 * workbook pays only a central-directory scan. Parsed charts land on the live content +
 * the cache entry; a superseded load is ignored. Never throws into the caller.
 */
function extractWorkbookCharts(
    ctx: ViewerContext, token: LoadToken, entry: CacheEntry | null,
    names: string[], csv: string[], bytes: Uint8Array
): void {
    // Run after the current microtask so the grid render lands first.
    Promise.resolve().then(async () => {
        try {
            const fflate: any = await loadLib("fflate", async () => await import("fflate"));
            // Only decompress the parts the chart chain needs: the workbook + its rels,
            // every sheet + its rels, all drawings + their rels, and the chart XML. The
            // big data parts (sharedStrings, sheetN data cells) are NOT decompressed.
            const files: Record<string, Uint8Array> = fflate.unzipSync(bytes, {
                filter: (file: { name: string }) => {
                    const n = file.name;
                    return n === "xl/workbook.xml"
                        || n === "xl/_rels/workbook.xml.rels"
                        || /^xl\/worksheets\/(_rels\/)?sheet\d+\.xml(\.rels)?$/.test(n)
                        || /^xl\/drawings\/(_rels\/)?drawing\d+\.xml(\.rels)?$/.test(n)
                        || /^xl\/charts\/chart\d+\.xml$/.test(n);
                }
            });
            if (!hasCharts(files)) return; // chart-free workbook → nothing to do
            const strFromU8: (u: Uint8Array) => string = fflate.strFromU8;
            // Parse each sheet's CSV to a matrix so extractCharts can resolve a chart
            // range whose embedded cache is missing (DrawingML usually writes caches, so
            // this is a fallback). parseDelimited is cheap; only runs once per workbook.
            const matrices: (string[][] | null)[] = csv.map(text => text != null ? parseDelimited(text, ",") : null);
            const charts: SheetCharts[] = extractCharts(files, strFromU8, names.length, matrices, names);

            const anyChart = charts.some(c => c.length);
            if (!anyChart) return;

            // Persist on the cache entry (if still live) so a re-open is instant.
            if (entry != null && getCacheEntry(entry.key) === entry && entry.xlsxWorkbook) {
                entry.xlsxWorkbook.charts = charts;
            }
            if (!token.isCurrent()) return; // superseded — don't touch content
            ctx.content.xlsx.charts = charts;
            ctx.content.xlsx.renderToken += 1; // signal the body to pick up the charts
            ctx.requestRender();
        } catch {
            // Charts are additive; a parse failure leaves the grid untouched.
        }
    });
}

function createState(): XlsxViewState {
    return { sheet: 0, names: [] };
}

function resetState(vs: XlsxViewState): void {
    if (!vs) return;
    vs.sheet = 0;
    vs.names = [];
}

/** Park the selected sheet + charts-strip state on the entry so a cache return reopens
 *  the workbook where it was left. */
function snapshot(vs: XlsxViewState, entry: CacheEntry): void {
    entry.view.xlsxSheet = vs?.sheet ?? 0;
    entry.view.xlsxChartsCollapsed = vs?.chartsCollapsed ?? false;
}

/** Restore the saved sheet on a cache return. The sheet names are re-derived from the
 *  cached workbook so the tab strip is right before the body mounts; the sheet index
 *  is clamped into range. */
function restore(vs: XlsxViewState, entry: CacheEntry): void {
    if (!vs) return;
    const names = entry.xlsxWorkbook?.names ?? [];
    vs.names = names;
    vs.sheet = entry.view.xlsxSheet ?? 0;
    if (names.length) vs.sheet = Math.min(Math.max(0, vs.sheet), names.length - 1);
    vs.chartsCollapsed = entry.view.xlsxChartsCollapsed ?? false;
}

export const XlsxViewer: Viewer<XlsxViewState> = {
    type: "xlsx",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: XlsxBody,
    HeaderControls: XlsxHeaderControls,
    // The grid owns its own vertical+horizontal scroll inside .dockview-csv-scroll,
    // so scroll-restore must target that element (same as the csv viewer).
    scrollerSelector: () => ".dockview-csv-scroll"
    // No dispose: the parsed workbook on the entry is plain text (freed with the entry
    // by GC); there is no live GPU/worker handle to release.
};
