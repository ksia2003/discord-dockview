/*
 * The DOC-family row-2 controls (markdown / html) — the markdown TOC toggle plus
 * the shared edit controls (find (edit-only) + copy-source + the rendered↔edit-source
 * pencil).
 *
 * The find toggle, copy-source and edit pencil all belong to the cross-cutting edit/
 * layer (the rendered iframe is read-only, so find only has a target in EDIT mode),
 * so this dispatcher forwards to edit/'s EditTextHeaderControls, switching `mdMode`
 * off content.type (markdown vs html) so the toggle's tooltip copy is right.
 *
 * Markdown additionally leads with a table-of-contents toggle: a state-colour button
 * (highlighted when the outline is open) that stays in its slot but DISABLED when the
 * document has no headings (grammar rule 9). The outline itself lives inside the
 * rendered srcdoc iframe — the toggle flips the view-state + posts the state in.
 *
 * No module-top React access — the proxy is only invoked inside the component.
 */

import { React } from "@webpack/common";

import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import { toolBtn } from "../../ui/toolbar";
import { EditTextHeaderControls } from "../../edit/attach";
import { markdownHasToc, mdState, toggleMarkdownToc } from "./MarkdownViewer";

// A bulleted-list glyph for the table-of-contents toggle (three rows, each a dot + rule).
const TOC_PATH = "M4 6.5a1 1 0 1 1 2 0 1 1 0 0 1-2 0Zm4 0h12V8H8V6.5Zm-4 5.5a1 1 0 1 1 2 0 1 1 0 0 1-2 0Zm4 0h12v1.5H8V12Zm-4 5.5a1 1 0 1 1 2 0 1 1 0 0 1-2 0Zm4 0h12V19H8v-1.5Z";

/** Doc-family row-2 controls: the markdown TOC toggle (markdown only) followed by the
 *  shared edit controls with the right mdMode (markdown source vs html). */
export function DocHeaderControls() {
    const win = getActiveWindow();
    const isMarkdown = win.content.type === "markdown";
    if (!isMarkdown) return React.createElement(EditTextHeaderControls, { mdMode: false });
    // Markdown: lead with the TOC toggle, disabled when the doc has no headings.
    const hasToc = markdownHasToc(win);
    return React.createElement(
        React.Fragment,
        null,
        React.createElement(
            "div",
            { key: "md-toc-grp", className: "dockview-tool-group" },
            toolBtn("md-toc", STRINGS.markdown.toc, TOC_PATH,
                () => toggleMarkdownToc(), hasToc && mdState(win).tocOpen, !hasToc)
        ),
        React.createElement(EditTextHeaderControls, { mdMode: true })
    );
}
