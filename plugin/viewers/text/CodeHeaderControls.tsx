/*
 * Code row-2 controls: language label, find toggle, word-wrap toggle, copy.
 *
 * Reads/drives the live "code" controller (CodeBody publishes it) plus the active
 * window's CodeViewState for the find-open flag. Own component so the copy button
 * can flash "Copied" from local React state. (The edit-mode pencil is a P8 cross-
 * cutting concern and is intentionally absent this phase.)
 */

import { React } from "@webpack/common";

import { requestRender } from "../../engine/forceRender";
import { fallbackCopy } from "../../engine/fetch";
import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import { copyBtn, toolBtn } from "../../ui/toolbar";
import { codeController, codeState } from "./CodeBody";

// Magnifier glyph (find) — matches the PDF/code find trigger.
const FIND_PATH = "M10 4a6 6 0 1 0 3.71 10.71l4.29 4.3a1 1 0 0 0 1.42-1.42l-4.3-4.29A6 6 0 0 0 10 4Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z";
// Word-wrap glyph (a return-arrow over two text rules) — toggled state-colour.
const WRAP_PATH = "M4 6h16v1.5H4V6Zm0 4.5h11a3 3 0 0 1 0 6h-2.6l1.3 1.3-1.06 1.06L9.88 16.1l2.76-2.76 1.06 1.06-1.3 1.3H15a1.5 1.5 0 0 0 0-3H4v-2.2Zm0 7.5h6v1.5H4V18Z";

/** Toggle the code find bar. Closing clears the query + highlights. */
export function toggleCodeFind(): void {
    const cv = codeState(getActiveWindow());
    cv.findOpen = !cv.findOpen;
    if (!cv.findOpen) {
        cv.findQuery = "";
        cv.findMatches = 0;
        cv.findActive = 0;
        const ctrl = codeController();
        if (ctrl) { ctrl.matches = []; ctrl.rebuildFind(""); }
    }
    requestRender();
}

/** Code row-2 controls: language label, find, word wrap, copy. */
export function CodeHeaderControls() {
    const { useState } = React;
    const [copied, setCopied] = useState(false);
    const win = getActiveWindow();
    if (win.content.loading || win.content.error || win.content.code == null) return null;
    const cv = codeState(win);
    const ctrl = codeController();
    const wrapped = ctrl ? ctrl.wrap : true;

    const copy = () => {
        // copy what's SHOWN — the live document text (== the source in view mode).
        const text = ctrl ? ctrl.text() : (win.content.code ?? "");
        const done = () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        };
        try {
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
            } else {
                fallbackCopy(text, done);
            }
        } catch {
            fallbackCopy(text, done);
        }
    };

    return React.createElement(
        React.Fragment,
        null,
        // language label = lowest priority (informational); collapses first.
        React.createElement("span", {
            className: "dockview-tool-lang dockview-collapse-low",
            title: STRINGS.code.detectedLanguage
        }, win.content.codeLang),
        // find toggle (mirrors PDF). Mid priority: collapses before wrap/copy.
        React.createElement(
            "div",
            { className: "dockview-tool-group dockview-collapse-mid" },
            toolBtn("code-find", STRINGS.code.find, FIND_PATH, () => toggleCodeFind(), cv.findOpen)
        ),
        // word-wrap toggle (state-colour, member-list grammar): highlighted = wrap on.
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            toolBtn("code-wrap", STRINGS.code.wrap, WRAP_PATH, () => ctrl?.toggleWrap(), wrapped)
        ),
        copyBtn("code-copy", STRINGS.code.copy, copied, copy)
    );
}
