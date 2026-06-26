/*
 * Structured (JSON/XML) row-2 controls: a find trigger (raw only), the tree↔raw
 * toggle, and copy. Mirrors CsvHeaderControls exactly.
 *
 * The Raw control is a single STATE-COLOUR toggle (off = tree, highlighted = raw
 * text). Find runs over the RAW code body (the raw view IS a CodeBody over
 * content.code), so the find trigger is only ACTIVE in raw mode; in tree mode it
 * stays in its slot but DISABLED (grammar rule 9 — never appear/disappear by mode).
 *
 * The toggle bumps content.seq so the body dispatcher remounts the OTHER body fresh
 * (tree → StructuredBody, raw → CodeBody).
 *
 * No module-top work: React is read inside the component; the toggle reads the
 * active window at call time.
 */

import { React } from "@webpack/common";

import { fallbackCopy } from "../../engine/fetch";
import { requestRender } from "../../engine/forceRender";
import { getActiveWindow } from "../../engine/window";
import { setPendingScrollTop } from "../../engine/viewState";
import { STRINGS } from "../../strings";
import { copyBtn, toolBtn } from "../../ui/toolbar";
import { codeState } from "../text/CodeBody";
import { toggleCodeFind } from "../text/CodeHeaderControls";
import { treeState } from "./StructuredBody";

const FIND_PATH = "M10 4a6 6 0 1 0 3.71 10.71l4.29 4.3a1 1 0 0 0 1.42-1.42l-4.3-4.29A6 6 0 0 0 10 4Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z";
const RAW_PATH = "M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4Zm5.2 0L19.2 12l-4.6-4.6L16 6l6 6-6 6-1.4-1.4Z";

/** Flip a structured file between the tree and the raw text view. Raw reuses the
 *  code body over the same content.code; Tree re-parses on remount. Each view
 *  re-mounts fresh (a new content.seq) and opens at its own top. */
export function toggleStructuredMode(): void {
    const win = getActiveWindow();
    if (win.content.type !== "structured") return;
    const tv = treeState(win);
    tv.mode = tv.mode === "tree" ? "raw" : "tree";
    // leaving the raw view: close its find bar so it doesn't linger over the tree.
    if (tv.mode === "tree" && codeState(win).findOpen) toggleCodeFind();
    win.content.seq += 1; // new body identity -> CodeBody/StructuredBody remount fresh
    setPendingScrollTop(null);
    requestRender();
}

/** Structured row-2 controls: find (raw-active), the tree↔raw toggle, copy. */
export function StructuredHeaderControls() {
    const { useState } = React;
    const [copied, setCopied] = useState(false);
    const win = getActiveWindow();
    if (win.content.loading || win.content.error || win.content.code == null) return null;
    const raw = treeState(win).mode === "raw";

    const copy = () => {
        const text = win.content.code || "";
        const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
        try {
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
            } else { fallbackCopy(text, done); }
        } catch { fallbackCopy(text, done); }
    };

    const children: any[] = [];
    // Find runs over the raw CM body, so it's only ACTIVE in Raw mode; in Tree mode
    // it stays in its slot but DISABLED (grammar rule 9 — never appear/disappear).
    children.push(React.createElement(
        "div",
        { key: "tree-find-grp", className: "dockview-tool-group dockview-collapse-mid" },
        toolBtn("tree-find", STRINGS.code.find, FIND_PATH,
            () => toggleCodeFind(), codeState(win).findOpen, !raw)
    ));
    children.push(React.createElement(
        "div",
        { key: "tree-toggle-grp", className: "dockview-tool-group" },
        toolBtn("tree-raw", STRINGS.tree.rawHint, RAW_PATH, () => toggleStructuredMode(), raw),
        copyBtn("tree-copy", STRINGS.tree.copyHint, copied, copy)
    ));
    return React.createElement(React.Fragment, null, ...children);
}
