/*
 * pptx row-2 controls: slide navigation (prev / jump-input / next + total).
 *
 * Drives the live "pptx" controller (PptxBody publishes it) plus the active window's
 * PptxViewState for the indicator. The jump-input owns a little local React state
 * (the typed string); the prev/next arrows read view-state / the controller at render
 * time. Collapse priorities match the PDF header: the prev/next arrows go first
 * (scroll + ←/→ cover them), the readout/jump input is always kept.
 *
 * The pptx render is view-only and theme-agnostic (each slide carries its own
 * background), so there is no zoom group / find / drag-mode here — just slide nav,
 * the analogue of the PDF page nav.
 *
 * No module-top React.createElement / no module-top webpack access — the glyph
 * strings are plain path-data; the element tree is built inside the component.
 */

import { React } from "@vencord/types/webpack/common";

import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import { toolBtn } from "../../ui/toolbar";
import { pptxController, pptxState } from "./PptxBody";

// Prev/next slide chevrons (same glyphs as the PDF page nav for a consistent feel).
const PPTX_PREV_PATH = "M15.3 5.3a1 1 0 0 1 0 1.4L10 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0Z";
const PPTX_NEXT_PATH = "M8.7 5.3a1 1 0 0 0 0 1.4L14 12l-5.3 5.3a1 1 0 0 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z";

/** pptx header controls: slide nav (prev / jump input + total / next). */
export function PptxHeaderControls() {
    const { useState } = React;
    const [slideInput, setSlideInput] = useState("");
    const win = getActiveWindow();
    if (win.content.loading || win.content.error || win.content.pptx.presentation == null) return null;
    const vs = pptxState(win);
    const commitSlide = () => {
        const n = parseInt(slideInput, 10);
        if (!isNaN(n)) pptxController()?.goToSlide(n);
        setSlideInput("");
    };
    return React.createElement(
        "div",
        { className: "dockview-tool-group" },
        // prev arrow (lowest priority — scroll + ←/→ cover it; collapses first).
        React.createElement(
            "span",
            { className: "dockview-collapse-low" },
            toolBtn("pptx-prev", STRINGS.pptx.prevSlide, PPTX_PREV_PATH,
                () => pptxController()?.prevSlide())
        ),
        // slide indicator + jump input (always kept — the only way to see/type the
        // slide number). Reuses the PDF page-indicator chrome.
        React.createElement(
            "span",
            { className: "dockview-tool-pageind", title: STRINGS.pptx.slideIndicator },
            React.createElement("input", {
                className: "dockview-tool-pageinput",
                type: "text",
                inputMode: "numeric",
                "aria-label": STRINGS.pptx.goToSlide,
                title: STRINGS.pptx.goToSlideHint,
                value: slideInput,
                placeholder: String(vs.slide),
                onChange: (e: any) => setSlideInput(e.target.value.replace(/[^0-9]/g, "")),
                onKeyDown: (e: any) => {
                    if (e.key === "Enter") { e.preventDefault(); commitSlide(); }
                    e.stopPropagation();
                },
                onBlur: () => { if (slideInput) commitSlide(); }
            }),
            React.createElement("span", { className: "dockview-tool-pagetotal" }, " / " + vs.total)
        ),
        // next arrow.
        React.createElement(
            "span",
            { className: "dockview-collapse-low" },
            toolBtn("pptx-next", STRINGS.pptx.nextSlide, PPTX_NEXT_PATH,
                () => pptxController()?.nextSlide())
        )
    );
}
