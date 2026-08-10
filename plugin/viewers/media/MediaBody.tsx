/*
 * The MEDIA body — a native <audio> / <video controls> that streams content.url.
 *
 * Audio and video share ONE body; the element is chosen from content.type. Like the
 * image viewer, there is nothing to fetch or decode — the element streams the
 * attachment url itself. An unplayable container reports a provisional load failure
 * to the engine so openRollback can remove a failed new tab.
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

import { requestRender } from "../../engine/forceRender";
import { getActiveWindow } from "../../engine/window";
import { settings } from "../../settings";
import { markMediaDecodeError, markMediaLoaded } from "./mediaError";
import { settleMediaProbeFromBody } from "./mediaProbe";

/** The shared inline media body. Keyed on content.seq by the dispatcher, so a new
 *  file (or a retry) remounts it with a fresh native element. */
export function MediaBody() {
    const win = getActiveWindow();
    const mediaSeq = win.content.seq;
    const isVideo = win.content.type === "video";
    const url = win.content.url || "";

    // Autoplay is a live setting, read once at mount. Chromium blocks UNMUTED autoplay
    // without a user gesture, so an autoplaying element must be muted or it stays paused
    // and the setting silently does nothing — muted-autoplay is the honest behaviour
    // (plays silent, controls let the user unmute). Read once so a mid-play toggle
    // doesn't yank a playing element.
    const autoplay = React.useMemo(() => {
        try { return !!settings.store.dockMediaAutoplay; } catch { return false; }
    }, []);

    if (!url) return null;

    const reportDecodeError = () => {
        if (settleMediaProbeFromBody(win, mediaSeq, "error") || markMediaDecodeError(win, mediaSeq)) requestRender();
    };
    const reportLoaded = () => {
        if (settleMediaProbeFromBody(win, mediaSeq, "loaded") || markMediaLoaded(win, mediaSeq)) requestRender();
    };

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
            onLoadedMetadata: reportLoaded,
            onCanPlay: reportLoaded,
            onError: reportDecodeError
        })
    );
}
