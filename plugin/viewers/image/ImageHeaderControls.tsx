/*
 * Image row-2 controls: prev/next channel-image nav + the shared zoom group + a
 * reset-to-fit + a fullscreen toggle.
 *
 * The prev/next pair cycles through the channel's images IN ORDER (oldest→newest),
 * like Discord's native lightbox; at a true end (no more to fetch) or while a
 * load-more is in flight the button DIMS rather than vanishing (grammar rule 9).
 * Zoom / reset / fullscreen drive the live "image" controller the ImageBody
 * publishes (so the toolbar and the keyboard share the exact same zoom math).
 *
 * No module-top React.createElement — the glyph strings are plain path-data; the
 * element tree is built inside the component.
 */

import { React } from "@webpack/common";

import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import { toolBtn, zoomGroup } from "../../ui/toolbar";
import { galleryCanStep, galleryStep } from "./gallery";
import { imgController, imgState } from "./ImageBody";
// imgController is read at click time (the controller is published by the live
// ImageBody) so the toolbar shares the body's exact zoom math.

// Chevron glyphs for the prev/next image stepper (Discord-style ghost icons).
const IMG_PREV_PATH = "M15.3 18.7a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 1 1 1.4 1.4L10 12l5.3 5.3a1 1 0 0 1 0 1.4Z";
const IMG_NEXT_PATH = "M8.7 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 1 1-1.4-1.4L14 12 8.7 6.7a1 1 0 0 1 0-1.4Z";
// Reset-to-fit glyph (a refresh arrow) and the fullscreen expand glyph.
const RESET_PATH = "M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5 1 1 0 1 0-2 0 7 7 0 1 0 7-7Z";
const FULLSCREEN_PATH = "M5 5h5a1 1 0 0 1 0 2H7v3a1 1 0 1 1-2 0V5Zm9 0h5v5a1 1 0 1 1-2 0V7h-3a1 1 0 1 1 0-2ZM6 14a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2H5v-5a1 1 0 0 1 1-1Zm12 0a1 1 0 0 1 1 1v5h-5a1 1 0 1 1 0-2h3v-3a1 1 0 0 1 1-1Z";

/** Image header controls: prev/next image nav + zoom group + reset + fullscreen. */
export function ImageHeaderControls() {
    const win = getActiveWindow();
    if (win.content.loading || win.content.error || !win.content.url) return null;
    const iv = imgState(win);
    const pct = Math.round(iv.scale * 100);

    return React.createElement(
        React.Fragment,
        null,
        // prev/next image stepper — highest priority (it's the headline image
        // action), so it never collapses. Dim at a true end / while loading.
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            toolBtn("img-prev", STRINGS.image.prevImage, IMG_PREV_PATH,
                () => galleryStep(-1), false, !galleryCanStep(-1)),
            toolBtn("img-next", STRINGS.image.nextImage, IMG_NEXT_PATH,
                () => galleryStep(1), false, !galleryCanStep(1))
        ),
        zoomGroup("img", pct, () => imgController()?.zoomOut(), () => imgController()?.zoomIn()),
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            toolBtn("zoom-reset", STRINGS.zoom.reset, RESET_PATH, () => imgController()?.reset()),
            // Fullscreen toggle (IMG-2): the active state reflects whether the
            // lightbox is currently open, so the button reads as a toggle.
            toolBtn("img-fullscreen",
                iv.fullscreen ? STRINGS.image.exitFullscreen : STRINGS.image.enterFullscreen,
                FULLSCREEN_PATH,
                () => imgController()?.toggleFullscreen(),
                iv.fullscreen)
        )
    );
}
