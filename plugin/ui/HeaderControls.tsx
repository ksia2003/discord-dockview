/*
 * The second-row header dispatcher.
 *
 * The top header row (icon/name/⋯/close) is owned by DockPanel and is the same for
 * every content type. This dispatcher renders the SECOND row — the per-viewer
 * control cluster (pdf page-nav/zoom/find, image zoom, code lang/copy, the csv/tree
 * raw toggle, the markdown/html edit toggle). In the old monolith that was a fat
 * per-type if-ladder; here each viewer owns its own HeaderControls component and we
 * just look it up by content type and render it.
 *
 * A content type with no HeaderControls component (e.g. a plain image, or an idle
 * loading/empty/errored body) renders nothing here, and hasViewerControls() reports
 * false so DockPanel keeps the header single-row. Every viewer that needs a control
 * strip (pdf / code / csv / structured / pptx / the edit toggle) supplies one.
 */

import { getActiveWindow } from "../engine/window";
import { getViewer } from "../viewers/registry";

/** Render the active window's viewer second-row controls, or nothing. */
export function HeaderControls() {
    const win = getActiveWindow();
    const HC = getViewer(win.content.type)?.HeaderControls;
    return HC ? HC({}) : null;
}

/** True when the active content has a second-row controls strip (so DockPanel
 *  grows the header to two rows). A viewer with a HeaderControls component opts in;
 *  an empty / loading / errored body never shows the row. */
export function hasViewerControls(): boolean {
    const win = getActiveWindow();
    if (win.content.loading || win.content.error) return false;
    if (win.content.name == null) return false;
    return !!getViewer(win.content.type)?.HeaderControls;
}
