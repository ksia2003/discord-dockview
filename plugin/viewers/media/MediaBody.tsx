/*
 * The MEDIA body — a native <audio> / <video controls> that streams content.url.
 *
 * Audio and video share ONE body; the element is chosen from content.type. Like the
 * image viewer, there is nothing to fetch or decode — the element streams the
 * attachment url itself. An unplayable container (the browser fires the element's
 * `error` event) falls back to a quiet download notice, matching the unsupported card.
 *
 * AUTOPLAY is a user setting (General page, default OFF): a side-panel viewer
 * shouldn't blare on open. When ON, the element requests autoplay — but Chromium
 * BLOCKS unmuted autoplay without a user gesture, so an autoplaying element is muted
 * (the honest behaviour: it plays, silent, with controls; the user unmutes). When OFF
 * the element mounts paused with controls and the user presses play. The setting is
 * read at MOUNT (a new file remounts the body via content.seq), so a change applies to
 * the next opened media, not one already playing.
 *
 * No module-top React.createElement / no module-top webpack member access — the React
 * proxy is only invoked inside the component body below.
 */

import { React } from "@vencord/types/webpack/common";

import { getActiveWindow } from "../../engine/window";
import { settings } from "../../settings";
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

    // Autoplay is a live setting, read once at mount. Chromium blocks UNMUTED autoplay
    // without a user gesture, so an autoplaying element must be muted or it stays paused
    // and the setting silently does nothing — muted-autoplay is the honest behaviour
    // (plays silent, controls let the user unmute). Read once so a mid-play toggle
    // doesn't yank a playing element.
    const autoplay = React.useMemo(() => {
        try { return !!settings.store.dockMediaAutoplay; } catch { return false; }
    }, []);

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
            autoPlay: autoplay,
            // Chromium only autoplays a MUTED element without a user gesture; mute when
            // autoplaying so it actually plays (the user unmutes via the controls),
            // otherwise leave it unmuted so play starts at full volume. React's `muted`
            // prop is unreliable at reflecting to the DOM property, so we also set
            // el.muted directly in a ref callback BEFORE the browser evaluates autoplay.
            muted: autoplay,
            preload: autoplay ? "auto" : "metadata",
            ref: (el: HTMLMediaElement | null) => { if (el) el.muted = autoplay; },
            onError: () => setFailed(true)
        })
    );
}
