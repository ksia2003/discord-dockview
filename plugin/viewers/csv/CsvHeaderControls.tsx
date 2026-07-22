/*
 * CSV row-2 controls: a find trigger (raw only), the grid↔raw toggle, and copy.
 *
 * The Raw control is a single STATE-COLOUR toggle (Discord member-list grammar):
 * off = grid, highlighted = raw text. Find runs over the RAW code body (the raw
 * view IS a CodeBody over content.code), so the find trigger is only ACTIVE in raw
 * mode; in grid mode it stays in its slot but DISABLED (grammar rule 9 — a control
 * never appears/disappears by mode). Copy copies the table's source text.
 *
 * The toggle bumps content.seq so the body dispatcher remounts the OTHER body fresh
 * (grid → CsvBody, raw → CodeBody) — the same seq-swap CodeBody/CsvBody key on.
 *
 * No module-top work: React is read inside the component; the toggle reads the
 * active window at call time.
 */

import { React } from "@vencord/types/webpack/common";

import { fallbackCopy } from "../../engine/fetch";
import { requestRender } from "../../engine/forceRender";
import { getActiveWindow } from "../../engine/window";
import { setPendingScrollTop } from "../../engine/viewState";
import { STRINGS } from "../../strings";
import { copyBtn, toolBtn } from "../../ui/toolbar";
import { codeState } from "../text/CodeBody";
import { toggleCodeFind } from "../text/CodeHeaderControls";
import { csvState } from "./CsvBody";

// Magnifier (find) + the "</>" code glyph for the raw toggle (shared with the tree).
const FIND_PATH = "M10 4a6 6 0 1 0 3.71 10.71l4.29 4.3a1 1 0 0 0 1.42-1.42l-4.3-4.29A6 6 0 0 0 10 4Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z";
const RAW_PATH = "M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4Zm5.2 0L19.2 12l-4.6-4.6L16 6l6 6-6 6-1.4-1.4Z";

/** Flip a CSV between the grid and the raw text view. Raw reuses the code body over
 *  the same content.code; Grid re-parses on remount. Each view re-mounts fresh (a
 *  new content.seq) and opens at its own top. */
export function toggleCsvMode(): void {
    const win = getActiveWindow();
    if (win.content.type !== "csv") return;
    const cv = csvState(win);
    cv.mode = cv.mode === "grid" ? "raw" : "grid";
    // leaving the raw view: close its find bar so it doesn't linger over the grid.
    if (cv.mode === "grid" && codeState(win).findOpen) toggleCodeFind();
    win.content.seq += 1; // new body identity -> CodeBody/CsvBody remount fresh
    setPendingScrollTop(null); // each view opens at its own top (no cross-bleed)
    requestRender();
}

/** CSV row-2 controls: find (raw-active), the grid↔raw toggle, copy. */
export function CsvHeaderControls() {
    const { useState } = React;
    const [copied, setCopied] = useState(false);
    const win = getActiveWindow();
    if (win.content.loading || win.content.error || win.content.code == null) return null;
    const raw = csvState(win).mode === "raw";

    const copy = () => {
        const text = win.content.code ?? "";
        const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
        try {
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
            } else { fallbackCopy(text, done); }
        } catch { fallbackCopy(text, done); }
    };

    const children: any[] = [];
    // Find trigger. Find runs over the raw CM body, so it is only ACTIVE in Raw
    // mode; in Grid mode it stays in its slot but DISABLED (dimmed) rather than
    // vanishing (grammar rule 9 — never appear/disappear by mode).
    children.push(React.createElement(
        "div",
        { key: "csv-find-grp", className: "dockview-tool-group dockview-collapse-mid" },
        toolBtn("csv-find", STRINGS.code.find, FIND_PATH,
            () => toggleCodeFind(), codeState(win).findOpen, !raw)
    ));
    // Always: the Raw state-colour toggle (icon highlights when active) + copy.
    children.push(React.createElement(
        "div",
        { key: "csv-toggle-grp", className: "dockview-tool-group" },
        // Raw toggle = one button that changes COLOUR by state (off = grid view,
        // highlighted = raw text). The "</>" code glyph reads as "show the raw text".
        toolBtn("csv-raw", STRINGS.csv.rawHint, RAW_PATH, () => toggleCsvMode(), raw),
        copyBtn("csv-copy", STRINGS.csv.copyHint, copied, copy)
    ));
    return React.createElement(React.Fragment, null, ...children);
}
