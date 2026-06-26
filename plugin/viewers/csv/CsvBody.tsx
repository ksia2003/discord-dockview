/*
 * The CSV GRID body — an imperatively-built, rAF-streamed <table>.
 *
 * A few-thousand-row React table would be pathological, so the grid is built
 * straight into the DOM: a sticky header row plus body rows appended in batches
 * across requestAnimationFrame ticks (the first screenful synchronously for an
 * instant top, the rest streamed). React mounts only the empty scroll wrap; the
 * effect runs buildCsvController to fill it and is keyed on content.seq so a new
 * file — OR a raw→grid toggle (the toggle bumps seq) — remounts it fresh.
 *
 * The grid parses content.code lazily on mount with parseDelimited, so the cache
 * stays text-only (no parsed matrix to keep alive). The delimiter comes off the
 * csv view-state slice (set by the loader / re-derived on a cache restore).
 *
 * No module-top work: only imports + the helper/component declarations. React and
 * the active window are read at call time inside the component; the controller is
 * built inside the effect.
 */

import { React } from "@webpack/common";

import { escapeAttr, escapeHtml } from "../../engine/html";
import { consumePendingScroll } from "../../engine/viewState";
import { getActiveWindow } from "../../engine/window";
import type { CsvViewState, DockWindow } from "../../engine/types";
import { parseDelimited } from "./parse";

// Streaming knobs (carried verbatim — tuned for a 0-long-task profile on big files).
const CSV_FIRST_BATCH = 120;   // body rows appended synchronously on mount (a screenful+)
const CSV_ROW_BATCH = 800;     // body rows appended per scheduled rAF tick
const CSV_MAX_COLS = 512;      // hard column cap (a pathological wide row can't blow up the DOM)

/** The window's csv view-state slice, created on demand. The FIRST window built at
 *  engine init can predate this viewer's registration (the registry import order),
 *  so the slice may be missing on that one window; this back-fills it. */
export function csvState(win: DockWindow = getActiveWindow()): CsvViewState {
    let cv = win.viewStates["csv"] as CsvViewState | undefined;
    if (!cv) {
        cv = { mode: "grid", delimiter: "," };
        win.viewStates["csv"] = cv;
    }
    return cv;
}

/** The imperative grid controller — only a teardown handle for the rAF pump (the
 *  header reaches for csvView.mode, not this). */
interface CsvController {
    seq: number;
    cancelled: boolean;
    rafId: number;
    rowsBuilt: number;
    teardown: () => void;
}
let csvCtrl: CsvController | null = null;

/** Build the grid DOM into `mount` and stream the body rows in. Returns the
 *  controller (also stored in csvCtrl). One call per CSV grid mount. */
function buildCsvController(mount: HTMLElement): CsvController {
    const win = getActiveWindow();
    // Parse the source text (read-only this phase — the P8 edit buffer rides here
    // later). The delimiter lives on the csv view-state slice already.
    const rows = parseDelimited(win.content.code ?? "", csvState(win).delimiter);
    const header = rows.length ? rows[0] : [];
    // Column count = the widest of the header / a sample of data rows, so ragged
    // rows still get enough columns; capped so a runaway row can't explode the DOM.
    let cols = header.length;
    const sample = Math.min(rows.length, 200);
    for (let i = 1; i < sample; i++) if (rows[i].length > cols) cols = rows[i].length;
    cols = Math.max(1, Math.min(cols, CSV_MAX_COLS));
    const dataCount = Math.max(0, rows.length - 1);

    const table = document.createElement("table");
    table.className = "dockview-csv-table";

    // --- sticky header row (file row 0). A header cell may be empty; show its
    //     1-based column index as a faded fallback so the column is still clickable
    //     /readable. The whole thead is position:sticky via CSS. -----------------
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    for (let c = 0; c < cols; c++) {
        const th = document.createElement("th");
        th.className = "dockview-csv-th";
        const v = header[c] ?? "";
        if (v.length) th.textContent = v;
        else { th.textContent = ""; th.classList.add("dockview-csv-empty"); }
        th.title = v; // full value on hover (cells truncate with ellipsis)
        htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    mount.appendChild(table);

    const ctrl: CsvController = {
        seq: win.content.seq,
        cancelled: false,
        rafId: 0,
        rowsBuilt: 0,
        teardown: () => { /* set below */ }
    };

    // Append data rows [from,to) (file rows from+1 .. to). Built off-DOM as an
    // HTML string parsed in one template, then attached in a single reflow per
    // batch — same cheap-bulk-append trick the code viewer uses. Short rows are
    // padded with empty cells, extra cells past `cols` are dropped, so the grid
    // is always exactly `cols` wide and stays aligned.
    const appendRows = (from: number, to: number) => {
        let s = "";
        for (let i = from; i < to; i++) {
            const r = rows[i + 1]; // +1: skip the header row
            s += "<tr class=\"dockview-csv-row\">";
            for (let c = 0; c < cols; c++) {
                const v = (r && c < r.length) ? r[c] : "";
                // attribute-escape for the title, body-escape for the text.
                s += "<td class=\"dockview-csv-td\" title=\"" + escapeAttr(v) + "\">" + escapeHtml(v) + "</td>";
            }
            s += "</tr>";
        }
        const tmp = document.createElement("template");
        tmp.innerHTML = s;
        tbody.appendChild(tmp.content);
        ctrl.rowsBuilt = to;
    };

    const pump = () => {
        ctrl.rafId = 0;
        if (ctrl.cancelled) return;
        if (ctrl.rowsBuilt < dataCount) {
            appendRows(ctrl.rowsBuilt, Math.min(dataCount, ctrl.rowsBuilt + CSV_ROW_BATCH));
            if (ctrl.rowsBuilt < dataCount) {
                ctrl.rafId = (window.requestAnimationFrame || window.setTimeout)(pump) as unknown as number;
            }
        }
    };

    ctrl.teardown = () => {
        ctrl.cancelled = true;
        if (ctrl.rafId) {
            try { (window.cancelAnimationFrame || window.clearTimeout)(ctrl.rafId); } catch { /* ignore */ }
            ctrl.rafId = 0;
        }
    };

    // First batch synchronous (instant top), the rest stream across rAF ticks.
    appendRows(0, Math.min(dataCount, CSV_FIRST_BATCH));
    if (ctrl.rowsBuilt < dataCount) {
        ctrl.rafId = (window.requestAnimationFrame || window.setTimeout)(pump) as unknown as number;
    }

    csvCtrl = ctrl;
    return ctrl;
}

/** The CSV GRID body: an imperatively-built <table> inside a horizontally-
 *  scrollable column, keyed on content.seq so a new file (or a raw->grid toggle)
 *  remounts it fresh. React mounts the empty scroll wrap; buildCsvController fills
 *  it and streams the rows. */
export function CsvBody() {
    const { useRef, useEffect } = React;
    const mountRef = useRef(null as HTMLElement | null);
    const seq = getActiveWindow().content.seq;
    useEffect(() => {
        const m = mountRef.current;
        if (!m) return;
        const ctrl = buildCsvController(m);
        // restore the saved scroll once the (first) rows exist.
        consumePendingScroll(getActiveWindow());
        return () => {
            ctrl.teardown();
            // UNMOUNT GUARD: only clear the slot if it's still ours (a remount may
            // have already published a new controller).
            if (csvCtrl === ctrl) csvCtrl = null;
        };
    }, [seq]);
    return React.createElement(
        "div",
        {
            key: seq,
            className: "dockview-csv-scroll",
            // focusable so a click into the grid gives the panel keyboard focus.
            tabIndex: 0
        },
        React.createElement("div", { ref: mountRef, className: "dockview-csv-mount" })
    );
}
