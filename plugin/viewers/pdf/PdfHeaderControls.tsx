/*
 * PDF row-2 controls: page navigation (prev / jump-input / next + total), the
 * shared zoom group, the text/pan drag-mode toggle, and the find toggle.
 *
 * Drives the live "pdf" controller (PdfBody publishes it) plus the active window's
 * PdfViewState for the indicator + the toggle states. The page jump-input owns a
 * little local React state (the typed string); everything else reads view-state /
 * the controller at render time. Collapse priorities (the dockview-collapse-*
 * classes) match the old header: the prev/next arrows go first (scroll + ←/→
 * cover them), the readout/jump input is always kept, and the zoom group is the
 * last to collapse.
 *
 * fit-to-width is NOT here — it lives in the ⋯ more-menu (DockMoreMenu reads
 * getViewer("pdf").fitWidth()). The header keeps the zoom group +/-.
 *
 * No module-top React.createElement / no module-top webpack access — the glyph
 * strings are plain path-data; the element tree is built inside the component.
 */

import { React } from "@webpack/common";

import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import { PAN_HAND_PATH, toolBtn, zoomGroup } from "../../ui/toolbar";
import { pdfController, pdfState } from "./PdfBody";

// Magnifier glyph (find) — the only header toggle for PDF (fit-width is in ⋯).
const FIND_PATH = "M10 4a6 6 0 1 0 3.71 10.71l4.29 4.3a1 1 0 0 0 1.42-1.42l-4.3-4.29A6 6 0 0 0 10 4Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z";
// Rotate-clockwise glyph (a circular arrow) — shared verbatim with the image header.
const ROTATE_PATH = "M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z";
// Prev/next page chevrons.
const PDF_PREV_PATH = "M15.3 5.3a1 1 0 0 1 0 1.4L10 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0Z";
const PDF_NEXT_PATH = "M8.7 5.3a1 1 0 0 0 0 1.4L14 12l-5.3 5.3a1 1 0 0 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z";

/** PDF header controls: page nav + zoom group + drag-mode toggle + find toggle. */
export function PdfHeaderControls() {
    const { useState } = React;
    const [pageInput, setPageInput] = useState("");
    const win = getActiveWindow();
    if (win.content.loading || win.content.error || win.content.pdf.doc == null) return null;
    const pv = pdfState(win);
    const pct = Math.round(pv.zoom * 100);
    const commitPage = () => {
        const n = parseInt(pageInput, 10);
        if (!isNaN(n)) pdfController()?.goToPage(n);
        setPageInput("");
    };
    return React.createElement(
        React.Fragment,
        null,
        // page navigation + indicator + jump input. The prev/next ARROWS are the
        // lowest-priority items (scroll + ←/→ keys cover them) so they collapse
        // first at narrow width; the readout/jump input is kept (it's the only way
        // to SEE/type the page number) — see the container queries in CSS.
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            React.createElement(
                "span",
                { className: "dockview-collapse-low" },
                toolBtn("pdf-prev", STRINGS.pdf.prevPage, PDF_PREV_PATH,
                    () => pdfController()?.prevPage())
            ),
            React.createElement(
                "span",
                { className: "dockview-tool-pageind", title: STRINGS.pdf.pageIndicator },
                React.createElement("input", {
                    className: "dockview-tool-pageinput",
                    type: "text",
                    inputMode: "numeric",
                    "aria-label": STRINGS.pdf.goToPage,
                    title: STRINGS.pdf.goToPageHint,
                    value: pageInput,
                    placeholder: String(pv.page),
                    onChange: (e: any) => setPageInput(e.target.value.replace(/[^0-9]/g, "")),
                    onKeyDown: (e: any) => {
                        if (e.key === "Enter") { e.preventDefault(); commitPage(); }
                        e.stopPropagation();
                    },
                    onBlur: () => { if (pageInput) commitPage(); }
                }),
                React.createElement("span", { className: "dockview-tool-pagetotal" }, " / " + pv.total)
            ),
            React.createElement(
                "span",
                { className: "dockview-collapse-low" },
                toolBtn("pdf-next", STRINGS.pdf.nextPage, PDF_NEXT_PATH,
                    () => pdfController()?.nextPage())
            )
        ),
        // zoom group (shared w/ image) — a CORE control, last to collapse.
        zoomGroup("pdf", pct, () => pdfController()?.zoomOut(), () => pdfController()?.zoomIn()),
        // drag-mode toggle (state-colour, member-list grammar): a single hand icon
        // button that HIGHLIGHTS when pan is active. Off = text-select (drag selects
        // PDF text, the default + current behaviour); on (highlighted) = pan (drag
        // scrolls the page on both axes so a zoomed PDF can be moved sideways). The
        // colour state — not a label — says which mode is active. Always present
        // (rule 9), never removed; mid priority so it collapses with find.
        React.createElement(
            "div",
            { className: "dockview-tool-group dockview-collapse-mid" },
            toolBtn("pdf-dragmode",
                pv.dragMode === "pan" ? STRINGS.pdf.dragSelect : STRINGS.pdf.dragPan,
                PAN_HAND_PATH,
                () => pdfController()?.toggleDragMode(), pv.dragMode === "pan")
        ),
        // rotate (PDF-4): one click = 90° clockwise (0→90→180→270→0). A plain action
        // button (not a state toggle) — each click advances the rotation, persisted in
        // the PDF view-state so a cache return reopens at the same angle. Mid priority.
        React.createElement(
            "div",
            { className: "dockview-tool-group dockview-collapse-mid" },
            toolBtn("pdf-rotate", STRINGS.pdf.rotate, ROTATE_PATH,
                () => pdfController()?.rotate())
        ),
        // find toggle (the only header toggle for PDF; fit-width is in ⋯).
        // Mid priority: collapses before the zoom group but after the arrows.
        React.createElement(
            "div",
            { className: "dockview-tool-group dockview-collapse-mid" },
            toolBtn("pdf-find", STRINGS.pdf.find, FIND_PATH,
                () => pdfController()?.toggleFind(), pv.findOpen)
        )
    );
}
