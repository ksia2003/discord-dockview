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

import { React } from "@webpack/common";

import { clearLiveController, getLiveController, requestRender, setLiveController } from "../../engine/forceRender";
import { getActiveWindow } from "../../engine/window";
import { setPendingScrollTop } from "../../engine/viewState";
import type { DockWindow, XlsxViewState } from "../../engine/types";
import { csvState, CsvBody } from "../csv/CsvBody";

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
    csvState(win).delimiter = ",";
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

/** The xlsx body: feed the active sheet into the csv grid, render that grid, and
 *  (for a multi-sheet workbook) a bottom sheet-tab strip. */
export function XlsxBody() {
    const { useEffect } = React;
    const win = getActiveWindow();
    const seq = win.content.seq;
    const wb = win.content.xlsx;
    const vs = xlsxState(win);

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

    // The grid: the SAME CsvBody the csv viewer uses, keyed on seq so a sheet switch
    // (which bumps seq) remounts it fresh against the new sheet's text.
    const grid = React.createElement(CsvBody, { key: seq });

    if (!multi) {
        // Single-sheet workbook → just the grid, no redundant switcher.
        return React.createElement(
            "div",
            { className: "dockview-xlsx-shell" },
            grid
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
        { className: "dockview-xlsx-shell dockview-xlsx-shell-tabbed" },
        // the grid fills the area above the strip.
        React.createElement("div", { className: "dockview-xlsx-grid" }, grid),
        // the sheet-tab strip pinned along the bottom.
        React.createElement(
            "div",
            { className: "dockview-xlsx-tabs", role: "tablist", "aria-label": "Sheets" },
            ...tabs
        )
    );
}
