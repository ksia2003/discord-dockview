/*
 * xlsx (spreadsheet) row-2 controls: copy the active sheet's data.
 *
 * The SHEET SWITCHER itself is the Excel-style tab strip along the BOTTOM of the body
 * (XlsxBody) — that is where Box/Excel put it and where a user expects it — so the
 * header row keeps just the copy action: it copies the CURRENTLY-SELECTED sheet's CSV
 * (content.code, which XlsxBody keeps pointed at the active sheet). The copy glyph
 * flips to a checkmark while copied, the shared dock copy-button grammar.
 *
 * No module-top React.createElement / no module-top webpack access — the element
 * tree is built inside the component; the active window is read at call time.
 */

import { React } from "@vencord/types/webpack/common";

import { fallbackCopy } from "../../engine/fetch";
import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import { copyBtn } from "../../ui/toolbar";

/** xlsx header controls: copy the active sheet's CSV data. */
export function XlsxHeaderControls() {
    const { useState } = React;
    const [copied, setCopied] = useState(false);
    const win = getActiveWindow();
    if (win.content.loading || win.content.error || win.content.xlsx.csv.length === 0) return null;

    const copy = () => {
        const text = win.content.code ?? "";
        const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
        try {
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
            } else { fallbackCopy(text, done); }
        } catch { fallbackCopy(text, done); }
    };

    return React.createElement(
        "div",
        { className: "dockview-tool-group" },
        copyBtn("xlsx-copy", STRINGS.xlsx.copyHint, copied, copy)
    );
}
