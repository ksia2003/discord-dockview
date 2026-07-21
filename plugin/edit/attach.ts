/*
 * Attach — stage the file CURRENTLY shown in the dock as a pending upload on the
 * channel composer (the native attachment chip → review-before-send). When the
 * editable buffer has edits, the EDITED buffer is staged (edits included)
 * — the original Discord message is never touched.
 *
 * Three pieces live here (the cross-cutting attach surface):
 *  - attachActiveFile() — the 4-way byte-source branch → a File → UploadHandler.
 *  - the attach filename bar state + attachToolbar() — the second header row shown
 *    when the user picks "Attach to message" (the deferred AttachBar): a native
 *    filename input (original name as placeholder, grammar rule 6) + a blurple
 *    confirm + a ghost cancel.
 *  - EditTextHeaderControls — the row-2 controls shared by the doc viewers
 *    (markdown / html): a find toggle (edit-only), copy-source, and the edit pencil.
 *
 * No module-top work: React + @webpack/common are read inside the components/funcs;
 * the channel stores are resolved at call time, never at module eval.
 */

import { getCurrentChannel } from "@utils/discord";
import { Button, ChannelStore, DraftType, React, SelectedChannelStore, UploadHandler } from "@webpack/common";

import { dvFetch, fallbackCopy } from "../engine/fetch";
import { requestRender } from "../engine/forceRender";
import { getActiveWindow } from "../engine/window";
import { STRINGS } from "../strings";
import { copyBtn, toolBtn } from "../ui/toolbar";
import type { DockWindow } from "../engine/types";
import { editBufferText, toggleEditMode } from "./editMode";
import { codeState } from "../viewers/text/CodeBody";
import { toggleCodeFind } from "../viewers/text/CodeHeaderControls";

// Magnifier (find) glyph (shared with the code/csv/tree controls).
const FIND_PATH = "M10 4a6 6 0 1 0 3.71 10.71l4.29 4.3a1 1 0 0 0 1.42-1.42l-4.3-4.29A6 6 0 0 0 10 4Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z";
// The pencil glyph used by every edit toggle (code / markdown / artifact) — the
// state-colour toggle (highlights when editing). Shared by CodeHeaderControls.
export const EDIT_PENCIL_PATH = "M19.3 8.9 15.1 4.7l1.4-1.4a2 2 0 0 1 2.8 0l1.4 1.4a2 2 0 0 1 0 2.8l-1.4 1.4ZM13.7 6.1l4.2 4.2L8.6 19.6 3 21l1.4-5.6 9.3-9.3Z";

/** ⋯-menu "Attach to message": stage the file CURRENTLY shown in the panel as a
 *  pending upload on the active channel. The bytes come from what's ALREADY loaded
 *  — never an external fetch unless the file is url-only (a re-fetch of the file's
 *  OWN url, which the loaders already do):
 *    1) editable text family WITH edits (code / csv / structured / markdown): the
 *       edited buffer; no edits → content.code (the original text).
 *    2) inline artifact (html with no url): content.html (or the edited buffer).
 *    3) text family edited from a url (markdown/html-from-url): the buffer.
 *    4) everything else with a url (pdf / image / unedited markdown/html-from-url):
 *       fetch the url and attach the blob.
 *  `nameOverride` (from the attach filename input) renames the staged file; blank →
 *  the file's own name. Best-effort: any failure is a silent no-op. */
export function attachActiveFile(nameOverride?: string | null, w: DockWindow = getActiveWindow()): void {
    // A non-active tab's ⋯ attaches THAT window's file. Resolve the target channel
    // from the window's own new-file target (if any) before falling back to the
    // current channel, so a pinned tab attaches to where you are now.
    const channel = w.newFileChannel || getCurrentChannel() || ChannelStore.getChannel(SelectedChannelStore.getChannelId());
    if (!channel) return;
    const baseName = (w.content.name as string | null) || "file";
    const name = (nameOverride && nameOverride.trim()) ? nameOverride.trim() : baseName;

    const stage = (file: File) => {
        try { UploadHandler.promptToUpload([file], channel, DraftType.ChannelMessage); } catch { /* ignore */ }
        // a new-file session ends once attached (the editor was for that file).
        if (w.isNewFile) { w.isNewFile = false; w.newFileChannel = null; }
    };

    const hasEdits = w.editView.editBuffer != null;

    // 1) Editable text family — attach the EDITED buffer (or the original text if
    //    unedited). Covers code / csv / structured / unknown-as-text (content.code)
    //    AND a NEW file (empty content.code, the buffer holds the written text).
    if (w.content.code != null && (w.content.type === "code" || w.content.type === "csv" || w.content.type === "structured" || w.content.type === "unknown")) {
        const text = hasEdits ? editBufferText(w) : w.content.code;
        stage(new File([text], name, { type: "text/plain" }));
        return;
    }
    // 2) Markdown — the raw md source lives in content.code; attach the edited buffer
    //    when edited, else the original source. (A new markdown file also lands here:
    //    content.code = "" + the buffer holds the written markdown.)
    if (w.content.type === "markdown" && w.content.code != null) {
        const text = hasEdits ? editBufferText(w) : w.content.code;
        stage(new File([text], name, { type: "text/markdown" }));
        return;
    }
    // 3) Inline artifact (no url) — the html source is in memory; attach the edited
    //    buffer when edited, else the original html.
    if (w.content.type === "html" && w.content.html != null && !w.content.url) {
        const text = hasEdits ? editBufferText(w) : w.content.html;
        const base = /\.html?$/i.test(name) ? name : name + ".html";
        stage(new File([text], base, { type: "text/html" }));
        return;
    }
    // 4) Has a url (pdf / image / markdown-from-url / artifact-from-url): if the text
    //    family was edited (markdown/html have a buffer), attach the buffer; else
    //    attach the source blob from the file's OWN url.
    if (hasEdits && (w.content.type === "markdown" || w.content.type === "html")) {
        const mime = w.content.type === "markdown" ? "text/markdown" : "text/html";
        stage(new File([editBufferText(w)], name, { type: mime }));
        return;
    }
    if (w.content.url) {
        const reqUrl = w.content.url;
        dvFetch(reqUrl)
            .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
            .then(blob => { stage(new File([blob], name, { type: blob.type || "application/octet-stream" })); })
            .catch(() => { /* fetch blocked / failed — silent no-op */ });
    }
}

// --- the attach filename bar (the deferred AttachBar, second header row) -----
// Discord grammar rule 6 (the "new thread name" pattern): the original filename is
// the input's PLACEHOLDER, so leaving it blank reuses that name; typing renames the
// staged file. A brand-new file (no original name) uses `message.md`. The field is
// UNCONTROLLED (defaultValue + onChange) so typing it never re-renders — IME-safe —
// and keeps the onKeyDown stopPropagation so the panel's single-key shortcuts never
// eat a keystroke. `attachBarName` mirrors the typed value; Enter confirms, Esc
// cancels.
let attachBarOpen = false;
let attachBarName = "";

/** Is the attach filename bar shown as the second header row? */
export function isAttachBarOpen(): boolean { return attachBarOpen; }
/** Set the staged filename (the CDP harness drives this before confirming). */
export function setAttachBarName(v: string): void { attachBarName = v; }

/** Open the attach filename bar for the currently-shown file. */
export function openAttachBar(): void {
    attachBarOpen = true;
    attachBarName = "";
    requestRender();
}
export function closeAttachBar(): void {
    attachBarOpen = false;
    attachBarName = "";
    requestRender();
}
/** Confirm the attach bar: stage the (possibly edited) buffer under the chosen name
 *  (blank → the file's own name), then close the bar. */
export function confirmAttachBar(): void {
    attachActiveFile(attachBarName);
    closeAttachBar();
}

/** The placeholder for the attach filename input: the file's own name, or the
 *  new-file default (`message.md`) when there is none. */
function attachPlaceholderName(): string {
    return (getActiveWindow().content.name as string | null) || STRINGS.attach.defaultNewName;
}

/** The attach filename sub-toolbar (second header row): a native filename input
 *  (original name as placeholder) + a blurple Attach confirm + a ghost Cancel. */
export function attachToolbar() {
    const placeholder = attachPlaceholderName();
    return React.createElement(
        "div",
        { className: "dockview-attach-toolbar" },
        React.createElement("input", {
            key: "attach-name-" + getActiveWindow().content.seq,
            className: "dockview-attach-name",
            type: "text",
            placeholder,
            "aria-label": STRINGS.attach.hint,
            // autoFocus so the rename field is ready the instant the bar opens.
            autoFocus: true,
            defaultValue: "",
            spellCheck: false,
            onChange: (e: any) => { attachBarName = e.target.value; },
            onKeyDown: (e: any) => {
                e.stopPropagation();
                if (e.key === "Enter") { e.preventDefault(); confirmAttachBar(); }
                else if (e.key === "Escape") { e.preventDefault(); closeAttachBar(); }
            }
        }),
        // Cancel: a ghost text button (grammar rule 4).
        React.createElement(
            "button",
            {
                key: "attach-cancel",
                type: "button",
                className: "dockview-attach-cancel",
                onClick: () => closeAttachBar()
            },
            STRINGS.attach.cancel
        ),
        // Attach: Discord's real primary (BRAND/blurple) button (grammar rule 3).
        React.createElement(
            Button,
            {
                className: "dockview-attach-confirm",
                color: Button.Colors.BRAND,
                size: Button.Sizes.SMALL,
                "aria-label": STRINGS.attach.hint,
                onClick: () => confirmAttachBar()
            },
            STRINGS.attach.confirm
        )
    );
}

/** The doc-family (markdown / html) row-2 controls: a find toggle (edit-only), a
 *  copy-source button, and the edit pencil. `mdMode` switches the toggle's tooltip
 *  copy (markdown source vs html). The text viewers opt into this via
 *  capabilities.editable; csv/structured carry their own raw toggle instead. */
export function EditTextHeaderControls(props: { mdMode: boolean }) {
    const { useState } = React;
    const [copied, setCopied] = useState(false);
    const win = getActiveWindow();
    if (win.content.loading || win.content.error || win.content.code == null) return null;
    const editing = win.editView.mode === "edit";
    const copy = () => {
        const text = editBufferText(win);
        const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
        try {
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
            } else { fallbackCopy(text, done); }
        } catch { fallbackCopy(text, done); }
    };
    const children: any[] = [];
    // Find runs over the editable CM body, which only exists in EDIT mode; in
    // RENDERED mode the body is the read-only iframe (no find target), so find stays
    // in its slot DISABLED (dimmed) rather than vanishing (grammar rule 9).
    children.push(React.createElement(
        "div",
        { key: "edit-find-grp", className: "dockview-tool-group dockview-collapse-mid" },
        toolBtn("edit-find", STRINGS.code.find, FIND_PATH,
            () => toggleCodeFind(), codeState(win).findOpen, !editing)
    ));
    // Copy stays in its slot in both modes (it copies the source/buffer either way).
    children.push(copyBtn("edit-copy", STRINGS.code.copy, copied, copy));
    // Always: the edit state-colour toggle (pencil highlights when editing).
    const enter = props.mdMode ? STRINGS.edit.enterEditMarkdown : STRINGS.edit.enterEditArtifact;
    const exit = props.mdMode ? STRINGS.edit.exitEditMarkdown : STRINGS.edit.exitEditArtifact;
    children.push(React.createElement(
        "div",
        { key: "edit-toggle-grp", className: "dockview-tool-group" },
        toolBtn("edit-toggle", editing ? exit : enter, EDIT_PENCIL_PATH,
            () => toggleEditMode(), editing)
    ));
    return React.createElement(React.Fragment, null, ...children);
}
