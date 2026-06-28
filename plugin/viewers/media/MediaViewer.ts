/*
 * The AUDIO + VIDEO viewers — the Viewer contract over a native <audio>/<video controls>.
 *
 * Both stream content.url directly: there is nothing to fetch or decode (the simplest
 * loader, like the image viewer). load() just validates the url and clears loading; the
 * shared MediaBody picks the element from content.type and plays it. Native controls own
 * playback, so there is no view-state, no find, and nothing to dispose.
 */

import type { CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext } from "../../engine/types";
import { MediaBody } from "./MediaBody";

/** MEDIA loader: nothing to fetch — the <audio>/<video> tag streams content.url itself.
 *  Mirrors the image loader (validate the url, mark the entry resolved). */
function load(opts: LoadOpts, _token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = "No media source";
        return;
    }
    if (entry) { entry.loading = false; entry.error = null; }
    ctx.content.loading = false;
    ctx.content.error = null;
}

/** Audio and video are identical but for their ContentType; one factory builds both. */
function makeMediaViewer(type: "audio" | "video"): Viewer {
    return {
        type,
        load,
        createState: () => ({}),
        resetState: () => { /* native controls own playback — no view-state */ },
        snapshot: () => { /* nothing parked on the cache entry */ },
        restore: () => { /* nothing to restore */ },
        Body: MediaBody
        // No capabilities: no gallery, no find, no pop-out (download via the ⋯ menu).
    };
}

export const AudioViewer: Viewer = makeMediaViewer("audio");
export const VideoViewer: Viewer = makeMediaViewer("video");
