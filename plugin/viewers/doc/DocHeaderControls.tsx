/*
 * The DOC-family row-2 controls (markdown / html) — find (edit-only) + copy-source
 * + the rendered↔edit-source pencil.
 *
 * The three controls (find toggle, copy-source, edit pencil) all belong to the
 * cross-cutting edit/ layer — the rendered iframe is read-only (no in-page find),
 * so find only has a target in EDIT mode, and the edit toggle + the CM edit surface
 * are the edit/ capability. So this dispatcher just forwards to edit/'s
 * EditTextHeaderControls, switching `mdMode` off content.type (markdown vs html) so
 * the toggle's tooltip copy is right (Edit source vs Edit HTML).
 *
 * No module-top React access — the proxy is only invoked inside the component.
 */

import { React } from "@webpack/common";

import { getActiveWindow } from "../../engine/window";
import { EditTextHeaderControls } from "../../edit/attach";

/** Doc-family row-2 controls: forward to the shared edit controls with the right
 *  mdMode (markdown source vs html). */
export function DocHeaderControls() {
    const mdMode = getActiveWindow().content.type === "markdown";
    return React.createElement(EditTextHeaderControls, { mdMode });
}
