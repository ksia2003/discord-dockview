/*
 * The XLSX viewer — type "xlsx".
 *
 * A .xlsx/.xls is binary OOXML/BIFF, so the loader fetches it as an ArrayBuffer,
 * reads the workbook with SheetJS, serialises the FIRST sheet to CSV text, and then
 * RETYPES the file to "csv" so the existing spreadsheet GRID (the csv viewer, P6)
 * renders it — exactly the way the unknown viewer retypes a sniffed-text file to
 * "code". The KEY type stays "xlsx" (it's already keyed/fetched as xlsx|url) — only
 * the RENDER type changes; the registry tolerates key-type ≠ render-type.
 *
 * ★ NOTE FOR P5 → P6 ★ the csv viewer is built in P6. Until then, after this loader
 * retypes content.type to "csv", the dispatcher finds no "csv" viewer registered and
 * lands on the unsupported card. That is EXPECTED this phase — the retype + the
 * key-type≠render-type handling are authored faithfully here and xlsx is confirmed
 * end-to-end once P6 registers the csv grid.
 *
 * VIEW-ONLY here (the csv grid owns its own controls in P6): no HeaderControls, no
 * editable capability. The csv delimiter is set on the csv view-state slice IF it
 * exists yet (it won't until P6 registers the viewer) — defensive, like showContent's
 * closeLightbox guard.
 *
 * SheetJS (XLSX) is pulled in with a DYNAMIC import() routed through engine/lazyLib,
 * so its module top-level leaves Vencord startup and only runs on the first .xlsx
 * opened, behind a "Loading spreadsheet viewer…" dock state.
 */

import { withLibLoading } from "../../engine/lazyLib";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, CsvViewState, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { HtmlBody } from "./iframe";

/** XLSX loader: fetch as ArrayBuffer → SheetJS → first sheet as CSV → retype to
 *  "csv". The entry is retyped too, so a re-open restores it as a csv grid (its key
 *  stays "xlsx|url" from the original detectType — only the RENDER type changes). */
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
            return r.arrayBuffer();
        })
        .then(async buf => {
            const XLSX: any = await withLibLoading(ctx, STRINGS.loading.lib.xlsx, "xlsx",
                async () => await import("xlsx"));
            const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
            const firstName = wb.SheetNames[0];
            const sheet = firstName ? wb.Sheets[firstName] : null;
            // sheet_to_csv emits RFC-4180 CSV (comma delimiter, quoted as needed),
            // which the csv grid's parser reads back unchanged.
            const text = sheet ? XLSX.utils.sheet_to_csv(sheet) : "";
            if (entry) {
                entry.type = "csv";
                entry.code = text;
                entry.codeLang = "plaintext";
                entry.loading = false;
                entry.error = null;
            }
            if (!token.isCurrent()) return;
            ctx.content.type = "csv";
            ctx.content.code = text;
            ctx.content.codeLang = "plaintext";
            // The serialised sheet is comma-delimited, and a fresh xlsx always opens
            // as the grid (the old loadXlsx reset the csv view-state). Set both on the
            // csv view-state slice if the csv viewer has registered (P6).
            const csv = ctx.window.viewStates["csv"] as CsvViewState | undefined;
            if (csv) { csv.delimiter = ","; csv.mode = "grid"; }
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
    /* no per-window xlsx view-state — it renders through the csv grid post-retype */
}
function snapshot(): void {
    /* nothing format-specific to park (csv grid handles its own once P6 lands) */
}
function restore(): void {
    /* nothing format-specific to restore */
}

export const XlsxViewer: Viewer = {
    type: "xlsx",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    // Body is never actually mounted for xlsx: load() retypes content.type to "csv"
    // before the body renders, so the dispatcher routes to the csv viewer's Body
    // (P6). HtmlBody is a harmless placeholder to satisfy the contract (the iframe
    // shell needs no xlsx-specific state). No HeaderControls / editable.
    Body: HtmlBody,
};
