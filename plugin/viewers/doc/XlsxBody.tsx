/*
 * The spreadsheet (xlsx/xls/xlsm/ods) body — the existing CSV GRID wrapped with an
 * Excel-style bottom SHEET-TAB strip.
 *
 * A workbook is many sheets; SheetJS reads them all once in XlsxViewer.load, which
 * keeps the ordered sheet names + per-sheet CSV text on the cache entry (and live
 * content.xlsx) — the same way pdf/3D/pptx persist their heavy parsed handle. This
 * body does NOT reinvent the grid: it picks the ACTIVE sheet's CSV, writes it into
 * content.code + sets the csv delimiter, and renders the very same CsvBody grid the
 * .csv/.tsv viewer uses. A row of tabs along the bottom lists every sheet; clicking
 * one re-feeds that sheet's CSV and remounts the grid (a content.seq bump → the grid
 * re-parses). The selected sheet rides the xlsx view-state and is parked on the cache
 * entry so a re-open reopens the same sheet.
 *
 * A SINGLE-sheet workbook shows no tab strip (there is nothing to switch) — it reads
 * as a plain grid, exactly like a .csv. The strip only appears for >= 2 sheets.
 *
 * The grid is keyed on content.seq (CsvBody's own contract): switching sheets bumps
 * seq so the imperative grid tears down and rebuilds against the new sheet's text.
 *
 * No module-top React.createElement / no module-top webpack access — the element
 * tree is built inside the component; the active window is read at call time.
 */

import { React } from "@vencord/types/webpack/common";

import { clearLiveController, getLiveController, requestRender, setLiveController } from "../../engine/forceRender";
import { getActiveWindow } from "../../engine/window";
import { setPendingScrollTop } from "../../engine/viewState";
import { STRINGS } from "../../strings";
import type { DockWindow, XlsxViewState } from "../../engine/types";
import { csvState, CsvBody } from "../csv/CsvBody";
import type { ChartModel } from "./XlsxCharts";
import { XlsxChartStrip } from "./XlsxChartCard";

/** A1-style column label for a 0-based column index (0 -> A, 26 -> AA). */
function colLabel(c: number): string {
    let s = "";
    let n = c;
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
}

/** The A1 address of a grid cell from its 0-based row/col (row 0 = spreadsheet row 1). */
function cellAddress(r: number, c: number): string {
    return colLabel(c) + (r + 1);
}

// The live-controller slot name + the per-window view-state key.
export const XLSX_CONTROLLER = "xlsx";

/** The window's xlsx view-state slice (selected sheet + the sheet names for the tab
 *  strip), created on demand. Mirrors pptxState's init-order back-fill: the very
 *  first window can be built before this viewer registers, so it may lack the slice. */
export function xlsxState(win: DockWindow = getActiveWindow()): XlsxViewState {
    let vs = win.viewStates[XLSX_CONTROLLER] as XlsxViewState | undefined;
    if (!vs) {
        vs = { sheet: 0, names: [] };
        win.viewStates[XLSX_CONTROLLER] = vs;
    }
    return vs;
}

/** Reset the xlsx view to its fresh-open default (first sheet, no names yet). */
export function resetXlsxView(win: DockWindow = getActiveWindow()): void {
    const vs = xlsxState(win);
    vs.sheet = 0;
    vs.names = [];
}

/** The live xlsx controller (the keyboard / future header could reach for it). */
export interface XlsxController {
    selectSheet: (index: number) => void; // 0-based
}

/** Read the live xlsx controller. */
export function xlsxController(): XlsxController | null {
    return getLiveController<XlsxController>(XLSX_CONTROLLER);
}

/** Point the live content.code at the given sheet's CSV (clamped into range) and
 *  set the csv delimiter to comma — SheetJS's sheet_to_csv always emits RFC-4180
 *  comma-delimited text, which the csv grid parses back unchanged. Writes the
 *  selected index into the xlsx view-state. Does NOT bump seq (callers decide). */
function feedSheet(win: DockWindow, index: number): void {
    const wb = win.content.xlsx;
    const vs = xlsxState(win);
    const count = wb.csv.length;
    const i = count ? Math.min(Math.max(0, index), count - 1) : 0;
    vs.sheet = i;
    win.content.code = wb.csv[i] ?? "";
    // SheetJS sheet_to_csv is always comma-delimited; the grid reads this off the
    // shared csv slice (CsvBody parses content.code with csvState().delimiter).
    const cv = csvState(win);
    cv.delimiter = ",";
    // Turn on the grid's cell-coord stamping (so a click reads the address) and hand
    // it THIS sheet's formula map for the corner hints. A plain csv/tsv never sets
    // these, so the csv viewer's grid stays coord-free.
    cv.cellCoords = true;
    const fmap = wb.formulas[i];
    cv.formulaCells = fmap ? new Set(Object.keys(fmap)) : new Set();
}

/** Switch to a different sheet: re-feed its CSV, bump content.seq so the imperative
 *  grid remounts fresh against the new text, and open the new sheet at its own top. */
export function selectSheet(index: number): void {
    const win = getActiveWindow();
    if (win.content.type !== "xlsx") return;
    const vs = xlsxState(win);
    const wb = win.content.xlsx;
    const count = wb.csv.length;
    if (!count) return;
    const i = Math.min(Math.max(0, index), count - 1);
    if (i === vs.sheet) return; // already on this sheet
    feedSheet(win, i);
    win.content.seq += 1; // new grid identity → CsvBody remounts + re-parses
    setPendingScrollTop(null); // each sheet opens at its own top (no cross-bleed)
    requestRender();
}

/** Toggle the per-sheet Charts strip collapsed/expanded (remembered on the view-state,
 *  parked on the cache entry by snapshot). A plain state flip + repaint — the grid never
 *  remounts (no seq bump), so collapsing the charts leaves the grid scroll untouched. */
export function toggleXlsxCharts(): void {
    const win = getActiveWindow();
    if (win.content.type !== "xlsx") return;
    const vs = xlsxState(win);
    vs.chartsCollapsed = !vs.chartsCollapsed;
    requestRender();
}

/** The formula readout bar — an Excel-style fx bar above the grid. A click anywhere in
 *  the grid selects that cell: the bar shows its A1 ADDRESS + either its FORMULA (if the
 *  cell carries one, with the fx marker) or its RAW VALUE. Nothing selected yet → a quiet
 *  hint. The click is delegated on the shell (one listener, not per-cell) and the picked
 *  cell gets a -selected outline, so a big sheet stays cheap. The selection resets on a
 *  sheet switch / new file (seq + renderToken).
 *
 *  The bar owns its own selection state, so a click never re-renders (or re-streams) the
 *  grid — it only repaints this small bar + toggles one class on the DOM cell. It hangs
 *  its listener on the SHELL node (shellRef) so one handler covers the whole grid. */
function FormulaBar({ shellRef }: { shellRef: { current: HTMLElement | null } }) {
    const { useState, useEffect, useRef } = React;
    const win = getActiveWindow();
    const wb = win.content.xlsx;
    // selection: { addr, value, formula } | null. formula is "" for a value cell.
    const [sel, setSel] = useState(null as null | { addr: string; value: string; formula: string });
    // Track the currently-outlined cell so a new pick clears the old outline.
    const lastCell = useRef(null as HTMLElement | null);

    useEffect(() => {
        const shell = shellRef.current;
        if (!shell) return;
        // Re-read the active sheet's formula map on each (re)bind — the effect re-runs
        // when seq/renderToken change (a sheet switch or a new workbook).
        const fmap = win.content.xlsx.formulas[xlsxState(win).sheet] || {};
        // A sheet switch / new file invalidates any prior selection.
        setSel(null);
        lastCell.current = null;
        const onClick = (e: MouseEvent) => {
            const t = e.target as HTMLElement | null;
            const cell = t && t.closest ? (t.closest("[data-r]") as HTMLElement | null) : null;
            if (!cell || !shell.contains(cell)) return;
            const r = Number(cell.dataset.r);
            const c = Number(cell.dataset.c);
            if (!Number.isFinite(r) || !Number.isFinite(c)) return;
            if (lastCell.current) lastCell.current.classList.remove("dockview-csv-selected");
            cell.classList.add("dockview-csv-selected");
            lastCell.current = cell;
            setSel({ addr: cellAddress(r, c), value: cell.textContent || "", formula: fmap[r + "," + c] || "" });
        };
        shell.addEventListener("click", onClick);
        return () => shell.removeEventListener("click", onClick);
    }, [win.content.seq, wb.renderToken]);

    const hasFormula = sel != null && sel.formula.length > 0;
    return React.createElement(
        "div",
        { className: "dockview-xlsx-fx", role: "status", "aria-live": "polite" },
        React.createElement(
            "span",
            { className: "dockview-xlsx-fx-addr" + (sel ? "" : " dockview-xlsx-fx-empty") },
            sel ? sel.addr : STRINGS.xlsx.fxLabel
        ),
        React.createElement(
            "span",
            {
                className: "dockview-xlsx-fx-val"
                    + (hasFormula ? " dockview-xlsx-fx-formula" : "")
                    + (sel ? "" : " dockview-xlsx-fx-empty"),
                title: sel ? (hasFormula ? "=" + sel.formula : sel.value) : ""
            },
            sel ? (hasFormula ? "=" + sel.formula : sel.value) : STRINGS.xlsx.fxHint
        )
    );
}

/** The xlsx body: feed the active sheet into the csv grid, render that grid with a
 *  formula (fx) readout bar above it, and (for a multi-sheet workbook) a bottom
 *  sheet-tab strip. */
export function XlsxBody() {
    const { useEffect, useRef } = React;
    const win = getActiveWindow();
    const seq = win.content.seq;
    const wb = win.content.xlsx;
    const vs = xlsxState(win);
    const shellRef = useRef(null as HTMLElement | null);

    // Feed the active sheet's CSV into content.code BEFORE the grid mounts so CsvBody
    // (which reads content.code on mount) sees this sheet's text. This runs every
    // render but is cheap (just re-points code + delimiter); the grid only rebuilds
    // when seq changes. Clamp the (possibly cache-restored) sheet into range.
    if (wb.csv.length) feedSheet(win, vs.sheet);

    // Publish/clear the live controller so the keyboard (and any future header) can
    // drive sheet selection. Keyed on the workbook identity (renderToken) so a new
    // file re-publishes a controller bound to the right window.
    useEffect(() => {
        const ctrl: XlsxController = { selectSheet: (n: number) => selectSheet(n) };
        setLiveController(XLSX_CONTROLLER, ctrl);
        return () => clearLiveController(XLSX_CONTROLLER, ctrl);
    }, [win.content.xlsx.renderToken]);

    const names = wb.names.length ? wb.names : vs.names;
    const multi = names.length > 1;

    // The active sheet's embedded charts (extracted after the grid painted; empty until
    // then / for a chart-free sheet). A sheet with charts gets the collapsible strip
    // above the fx bar; a sheet without gets nothing new.
    const sheetCharts = (wb.charts[vs.sheet] as ChartModel[] | undefined) ?? [];
    const chartStrip = sheetCharts.length
        ? React.createElement(XlsxChartStrip, {
            key: "charts",
            charts: sheetCharts,
            collapsed: vs.chartsCollapsed === true,
            onToggle: toggleXlsxCharts
        })
        : null;

    // The grid: the SAME CsvBody the csv viewer uses, keyed on seq so a sheet switch
    // (which bumps seq) remounts it fresh against the new sheet's text.
    const grid = React.createElement(CsvBody, { key: seq });
    // The fx bar hangs its cell-click listener on the shell node (shellRef).
    const fxBar = React.createElement(FormulaBar, { key: "fx", shellRef });

    if (!multi) {
        // Single-sheet workbook → the (optional) charts strip + fx bar + grid.
        return React.createElement(
            "div",
            { className: "dockview-xlsx-shell", ref: shellRef },
            chartStrip,
            fxBar,
            React.createElement("div", { className: "dockview-xlsx-grid" }, grid)
        );
    }

    // Multi-sheet → grid + an Excel-style bottom tab strip. Each tab is a button;
    // the active one carries the -active class (state-colour, like the dock toggles).
    const tabs = names.map((nm, i) =>
        React.createElement(
            "button",
            {
                key: "xlsx-tab-" + i,
                type: "button",
                className: "dockview-xlsx-tab" + (i === vs.sheet ? " dockview-xlsx-tab-active" : ""),
                title: nm,
                "aria-label": nm,
                "aria-pressed": i === vs.sheet || undefined,
                onClick: () => selectSheet(i)
            },
            // the sheet name; empty names (rare) fall back to "Sheet N".
            nm && nm.length ? nm : "Sheet " + (i + 1)
        )
    );

    return React.createElement(
        "div",
        { className: "dockview-xlsx-shell dockview-xlsx-shell-tabbed", ref: shellRef },
        // the (optional) charts strip sits at the very top, above the fx bar.
        chartStrip,
        // the fx readout bar sits above the grid.
        fxBar,
        // the grid fills the area between the fx bar and the tab strip.
        React.createElement("div", { className: "dockview-xlsx-grid" }, grid),
        // the sheet-tab strip pinned along the bottom.
        React.createElement(
            "div",
            { className: "dockview-xlsx-tabs", role: "tablist", "aria-label": "Sheets" },
            ...tabs
        )
    );
}
