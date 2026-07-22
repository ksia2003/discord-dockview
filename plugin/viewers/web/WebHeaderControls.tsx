/*
 * Web tab row-2 controls — the MINIMAL chrome for an in-dock web page (scope A: no
 * address bar / no free typing). It offers exactly:
 *   - back        → the webview's canGoBack()/goBack()
 *   - reload      → the webview's reload()
 *   - open in browser → the existing openExternalLink escape hatch (important because ALL
 *     web links default into the dock, so the user needs a way out to a real browser)
 *   - a READ-ONLY current-url readout that updates as the page navigates (did-navigate /
 *     did-navigate-in-page), in the same muted .dockview-tool-lang style the code viewer
 *     uses for its language label — informational, lowest priority.
 *
 * In-page navigation is handled by the <webview> itself; there is no forward button and
 * no editable url (out of scope A).
 *
 * No module-top React.createElement — the element tree is built inside the component.
 */

import { React } from "@vencord/types/webpack/common";

import { getActiveWindow } from "../../engine/window";
import { openExternalLink } from "../../external/openExternal";
import { STRINGS } from "../../strings";
import { toolBtn } from "../../ui/toolbar";
import { subscribeWebUrl, webController, webCurrentUrl } from "./WebBody";

// Back chevron (shared grammar with the image prev glyph) and a refresh/reload arrow.
const BACK_PATH = "M15.3 18.7a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 1 1 1.4 1.4L10 12l5.3 5.3a1 1 0 0 1 0 1.4Z";
const RELOAD_PATH = "M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5 1 1 0 1 0-2 0 7 7 0 1 0 7-7Z";
// Open-in-external (a box with an out-arrow).
const EXTERNAL_PATH = "M14 4a1 1 0 0 1 1-1h5v5a1 1 0 1 1-2 0V6.4l-6.3 6.3a1 1 0 0 1-1.4-1.4L16.6 5H15a1 1 0 0 1-1-1ZM5 7a2 2 0 0 1 2-2h4a1 1 0 1 1 0 2H7v10h10v-4a1 1 0 1 1 2 0v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7Z";

/** Web header controls: back / reload / open-external + a read-only url readout. */
export function WebHeaderControls() {
    const { useEffect, useState } = React;
    const [, bump] = useState(0);
    const win = getActiveWindow();

    // Re-render on navigation so the url readout + back-button disabled state stay live.
    useEffect(() => subscribeWebUrl(() => bump(n => n + 1)), []);

    const idle = win.content.loading || win.content.error || !win.content.url;
    if (idle) return null;

    const ctl = webController(win);
    const url = webCurrentUrl(win);
    const canBack = ctl ? ctl.canGoBack() : false;

    return React.createElement(
        React.Fragment,
        null,
        // read-only current-url readout — informational, collapses first at narrow width
        // (same style/priority as the code language label). Never editable (scope A).
        React.createElement("span", {
            className: "dockview-tool-lang dockview-web-url dockview-collapse-low",
            title: STRINGS.web.url
        }, url),
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            // Back — dims (not vanishes) when there's no history to go back to.
            toolBtn("web-back", STRINGS.web.back, BACK_PATH, () => webController(win)?.goBack(), false, !canBack),
            toolBtn("web-reload", STRINGS.web.reload, RELOAD_PATH, () => webController(win)?.reload()),
            // Escape hatch to the OS browser (the existing openExternalLink path).
            toolBtn("web-external", STRINGS.web.openExternal, EXTERNAL_PATH,
                () => openExternalLink(webCurrentUrl(win)))
        )
    );
}
