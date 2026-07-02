/*
 * Code row-2 controls: language label, find toggle, word-wrap toggle, copy, and the
 * edit pencil (read↔edit).
 *
 * Reads/drives the live "code" controller (CodeBody publishes it) plus the active
 * window's CodeViewState for the find-open flag. Own component so the copy button
 * can flash "Copied" from local React state. The edit toggle delegates to the cross-
 * cutting edit/ layer (toggleEditMode flips the CM read↔edit compartment in place).
 */

import { React } from "@webpack/common";

import { requestRender } from "../../engine/forceRender";
import { fallbackCopy } from "../../engine/fetch";
import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import { copyBtn, toolBtn } from "../../ui/toolbar";
import { EDIT_PENCIL_PATH } from "../../edit/attach";
import { toggleEditMode } from "../../edit/editMode";
import { codeController, codeState } from "./CodeBody";

// Magnifier glyph (find) — matches the PDF/code find trigger.
const FIND_PATH = "M10 4a6 6 0 1 0 3.71 10.71l4.29 4.3a1 1 0 0 0 1.42-1.42l-4.3-4.29A6 6 0 0 0 10 4Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z";
// Word-wrap glyph (a return-arrow over two text rules) — toggled state-colour.
const WRAP_PATH = "M4 6h16v1.5H4V6Zm0 4.5h11a3 3 0 0 1 0 6h-2.6l1.3 1.3-1.06 1.06L9.88 16.1l2.76-2.76 1.06 1.06-1.3 1.3H15a1.5 1.5 0 0 0 0-3H4v-2.2Zm0 7.5h6v1.5H4V18Z";
// Link glyph (copy line reference) — a chain link, the "reference to a location".
const LINK_PATH = "M9.88 13.36a3 3 0 0 0 4.24 0l3-3a3 3 0 0 0-4.24-4.24l-1.06 1.06 1.06 1.06 1.06-1.06a1.5 1.5 0 1 1 2.12 2.12l-3 3a1.5 1.5 0 0 1-2.12 0 1 1 0 0 0-1.06 1Zm4.24-2.72a3 3 0 0 0-4.24 0l-3 3a3 3 0 0 0 4.24 4.24l1.06-1.06-1.06-1.06-1.06 1.06a1.5 1.5 0 0 1-2.12-2.12l3-3a1.5 1.5 0 0 1 2.12 0 1 1 0 0 0 1.06-1Z";

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

/** Code row-2 controls: language label, find, word wrap, copy, copy-reference. */
export function CodeHeaderControls() {
    const { useState } = React;
    const [copied, setCopied] = useState(false);
    const [copiedRef, setCopiedRef] = useState(false);
    const win = getActiveWindow();
    if (win.content.loading || win.content.error || win.content.code == null) return null;
    const cv = codeState(win);
    const ctrl = codeController();
    const wrapped = ctrl ? ctrl.wrap : true;
    const editing = win.editView.mode === "edit";
    // The copy-reference button enables once a line is selected in the gutter.
    const reference = ctrl ? ctrl.selReference() : null;

    // Shared clipboard write with a "flip to check for a beat" ack.
    const clip = (text: string, done: () => void) => {
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

    const copy = () => {
        // copy what's SHOWN — the live document text (== the source in view mode).
        const text = ctrl ? ctrl.text() : (win.content.code ?? "");
        clip(text, () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        });
    };

    const copyRef = () => {
        const ref = ctrl?.selReference();
        if (!ref) return;
        clip(ref, () => {
            setCopiedRef(true);
            setTimeout(() => setCopiedRef(false), 1200);
        });
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
        copyBtn("code-copy", STRINGS.code.copy, copied, copy),
        // Copy-reference: copies "name L12" / "name L12-L20" for the gutter-selected
        // line(s). Stays in its slot but disabled until a line is picked (grammar
        // rule 9); flashes a check on copy. Built inline (copyBtn has no disabled
        // state) but wears the same copy/check glyph swap as the plain copy button.
        React.createElement(
            "button",
            {
                key: "code-copy-ref",
                type: "button",
                className: "dockview-tool-btn dockview-tool-copy"
                    + (copiedRef ? " dockview-tool-copied" : "")
                    + (reference ? "" : " dockview-tool-btn-disabled"),
                "aria-label": reference ? STRINGS.code.copyRef : STRINGS.code.copyRefEmpty,
                title: reference ? STRINGS.code.copyRef : STRINGS.code.copyRefEmpty,
                "aria-disabled": reference ? undefined : true,
                disabled: !reference,
                onClick: reference ? copyRef : undefined
            },
            React.createElement(
                "svg",
                { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                copiedRef
                    ? React.createElement("path", { fill: "currentColor", d: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" })
                    : React.createElement("path", { fill: "currentColor", d: LINK_PATH })
            )
        ),
        // Edit toggle: one pencil button that highlights when EDIT is on (member-list
        // state-colour grammar). Read = CM read-only, Edit = CM editable over the
        // temporary buffer (+ the inline merge diff vs the original baseline). The
        // read↔edit flip is a live compartment reconfigure — no remount.
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            toolBtn("code-edit", editing ? STRINGS.edit.exitEditCode : STRINGS.edit.enterEditCode,
                EDIT_PENCIL_PATH, () => toggleEditMode(), editing)
        )
    );
}
