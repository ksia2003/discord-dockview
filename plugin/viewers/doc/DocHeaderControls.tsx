/*
 * The DOC-family row-2 controls (markdown / html) — VIEW-ONLY this phase.
 *
 * The monolith's markdown/html header row (EditTextHeaderControls) carried three
 * things: a find toggle, a copy-source button, and the rendered↔edit-source pencil.
 * Find only has a target in EDIT mode (the rendered iframe is read-only, no in-page
 * find), and the edit toggle + the CM edit surface are the P8 cross-cutting edit/
 * concern. So this phase ships ONLY the copy-source button — it copies the raw
 * markdown/html source (content.code), which is meaningful in view mode and never
 * depends on an editor existing.
 *
 * P8 TODO: re-add the find toggle (disabled until edit mode) and the edit-source
 * pencil here when the edit/ layer lands; both already have strings (STRINGS.code.find,
 * STRINGS.edit.*). Keeping the view path clean + testable now.
 *
 * No module-top React access — the proxy is only invoked inside the component.
 */

import { React } from "@webpack/common";

import { fallbackCopy } from "../../engine/fetch";
import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import { copyBtn } from "../../ui/toolbar";

/** View-only doc controls: a single copy-source button (markdown/html). Returns
 *  null while loading/errored or before a source exists, like the code row. */
export function DocHeaderControls() {
    const { useState } = React;
    const [copied, setCopied] = useState(false);
    const win = getActiveWindow();
    if (win.content.loading || win.content.error || win.content.code == null) return null;

    const copy = () => {
        const text = win.content.code ?? "";
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
        copyBtn("doc-copy", STRINGS.code.copy, copied, copy)
    );
}
