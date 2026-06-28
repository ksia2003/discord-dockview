/*
 * Multi-page TIFF row-2 controls: PAGE navigation (prev / jump-input / next + total) +
 * the image zoom group + reset-to-fit + rotate + fullscreen.
 *
 * Only shown for a TIFF with 2+ pages (a single-image raster file retypes to "image" and
 * uses ImageHeaderControls). The page nav mirrors the PDF/pptx page nav and drives the
 * live "rasterimage" controller (RasterImageBody publishes it); the zoom / reset / rotate
 * / fullscreen group drives the live "image" controller (the wrapped ImageBody publishes
 * it), so the toolbar and keyboard share the image viewer's exact zoom/rotation math.
 *
 * The channel-image gallery stepper that ImageHeaderControls shows is intentionally NOT
 * here — a multi-page TIFF's prev/next means PAGES, not other channel images, so showing
 * both would be two competing arrow pairs. (The raster surface opts out of the gallery
 * capability, so its gallery step is inert anyway.)
 *
 * No module-top React.createElement / no module-top webpack access — the glyph strings
 * are plain path-data; the element tree is built inside the component.
 */

import { React } from "@webpack/common";

import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import { toolBtn, zoomGroup } from "../../ui/toolbar";
import { imgController, imgState } from "../image/ImageBody";
import { rasterController, rasterState } from "./RasterImageBody";

// Prev/next page chevrons (same glyphs as the PDF/pptx page nav for a consistent feel).
const PAGE_PREV_PATH = "M15.3 5.3a1 1 0 0 1 0 1.4L10 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0Z";
const PAGE_NEXT_PATH = "M8.7 5.3a1 1 0 0 0 0 1.4L14 12l-5.3 5.3a1 1 0 0 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z";
// Reset-to-fit (refresh arrow), rotate-clockwise, fullscreen expand — shared verbatim
// with the image header so the raster surface keeps the same image affordances.
const RESET_PATH = "M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5 1 1 0 1 0-2 0 7 7 0 1 0 7-7Z";
const ROTATE_PATH = "M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z";
const FULLSCREEN_PATH = "M5 5h5a1 1 0 0 1 0 2H7v3a1 1 0 1 1-2 0V5Zm9 0h5v5a1 1 0 1 1-2 0V7h-3a1 1 0 1 1 0-2ZM6 14a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2H5v-5a1 1 0 0 1 1-1Zm12 0a1 1 0 0 1 1 1v5h-5a1 1 0 1 1 0-2h3v-3a1 1 0 0 1 1-1Z";

/** Multi-page TIFF header controls: page nav + zoom + reset + rotate + fullscreen. */
export function RasterHeaderControls() {
    const { useState } = React;
    const [pageInput, setPageInput] = useState("");
    const win = getActiveWindow();
    if (win.content.loading || win.content.error || win.content.type !== "rasterimage") return null;
    const vs = rasterState(win);
    const iv = imgState(win);
    const pct = Math.round(iv.scale * 100);
    const commitPage = () => {
        const n = parseInt(pageInput, 10);
        if (!isNaN(n)) rasterController()?.goToPage(n);
        setPageInput("");
    };
    return React.createElement(
        React.Fragment,
        null,
        // page navigation + indicator + jump input. The prev/next ARROWS are the
        // lowest-priority items (←/→ keys cover them) so they collapse first at narrow
        // width; the readout/jump input is always kept (the only way to see/type the
        // page number). Reuses the PDF page-indicator chrome.
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            React.createElement(
                "span",
                { className: "dockview-collapse-low" },
                toolBtn("raster-prev", STRINGS.raster.prevPage, PAGE_PREV_PATH,
                    () => rasterController()?.prevPage())
            ),
            React.createElement(
                "span",
                { className: "dockview-tool-pageind", title: STRINGS.raster.pageIndicator },
                React.createElement("input", {
                    className: "dockview-tool-pageinput",
                    type: "text",
                    inputMode: "numeric",
                    "aria-label": STRINGS.raster.goToPage,
                    title: STRINGS.raster.goToPageHint,
                    value: pageInput,
                    placeholder: String(vs.page),
                    onChange: (e: any) => setPageInput(e.target.value.replace(/[^0-9]/g, "")),
                    onKeyDown: (e: any) => {
                        if (e.key === "Enter") { e.preventDefault(); commitPage(); }
                        e.stopPropagation();
                    },
                    onBlur: () => { if (pageInput) commitPage(); }
                }),
                React.createElement("span", { className: "dockview-tool-pagetotal" }, " / " + vs.total)
            ),
            React.createElement(
                "span",
                { className: "dockview-collapse-low" },
                toolBtn("raster-next", STRINGS.raster.nextPage, PAGE_NEXT_PATH,
                    () => rasterController()?.nextPage())
            )
        ),
        // zoom group (shared w/ the image viewer) — drives the live "image" controller.
        zoomGroup("raster", pct, () => imgController()?.zoomOut(), () => imgController()?.zoomIn()),
        // reset-to-fit + rotate + fullscreen — the same image affordances, same controller.
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            toolBtn("raster-zoom-reset", STRINGS.zoom.reset, RESET_PATH, () => imgController()?.reset()),
            toolBtn("raster-rotate", STRINGS.image.rotate, ROTATE_PATH, () => imgController()?.rotate()),
            toolBtn("raster-fullscreen",
                iv.fullscreen ? STRINGS.image.exitFullscreen : STRINGS.image.enterFullscreen,
                FULLSCREEN_PATH,
                () => imgController()?.toggleFullscreen(),
                iv.fullscreen)
        )
    );
}
