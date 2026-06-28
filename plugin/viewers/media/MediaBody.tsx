/*
 * The MEDIA body — a native <audio> / <video controls> that streams content.url.
 *
 * Audio and video share ONE body; the element is chosen from content.type. Like the
 * image viewer, there is nothing to fetch or decode — the element streams the
 * attachment url itself. An unplayable container (the browser fires the element's
 * `error` event) falls back to a quiet download notice, matching the unsupported card.
 *
 * autoPlay is OFF: a side-panel viewer shouldn't blare on open — the user presses play.
 *
 * No module-top React.createElement / no module-top webpack member access — the React
 * proxy is only invoked inside the component body below.
 */

import { React } from "@webpack/common";

import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";

/** The shared inline media body. Keyed on content.seq by the dispatcher, so a new
 *  file (or a retry) remounts it and the local `failed` flag resets. */
export function MediaBody() {
    const { useState } = React;
    const [failed, setFailed] = useState(false);

    const win = getActiveWindow();
    const isVideo = win.content.type === "video";
    const url = win.content.url || "";
    const name = win.content.name || (isVideo ? "video" : "audio");

    if (failed || !url) {
        return React.createElement(
            "div",
            { className: "dockview-media-wrap dockview-media-fallback" },
            React.createElement(
                "div",
                { className: "dockview-media-fallback-card" },
                React.createElement("div", { className: "dockview-media-fallback-title" }, STRINGS.media.title),
                React.createElement("div", { className: "dockview-media-fallback-sub" }, STRINGS.media.sub(name))
            )
        );
    }

    return React.createElement(
        "div",
        { className: "dockview-media-wrap " + (isVideo ? "dockview-media-wrap--video" : "dockview-media-wrap--audio") },
        React.createElement(isVideo ? "video" : "audio", {
            className: isVideo ? "dockview-video" : "dockview-audio",
            src: url,
            controls: true,
            preload: "metadata",
            onError: () => setFailed(true)
        })
    );
}
