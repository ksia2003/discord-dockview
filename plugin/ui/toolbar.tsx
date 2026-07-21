/*
 * Shared toolbar glyphs + button helpers used across the dock chrome.
 *
 * Two kinds of thing live here:
 *  - PLAIN DATA: FILE_TYPE_ICON (the per-content-type header/tab glyph) and the
 *    shared zoom/pan path strings. These are bare SVG path-data strings, NEVER
 *    React elements.
 *  - LAZY FACTORIES: toolBtn / copyBtn / zoomGroup / menuIcon build their elements
 *    at call time (render time), when `React` from @webpack/common is actually
 *    resolved.
 *
 * VERBATIM HAZARD (the silent-death trap): `React` from @webpack/common is a lazy
 * proxy that is NOT ready at module-eval. Calling React.createElement at module top
 * would throw and take the WHOLE plugin import down (window.__dockView never
 * appears). So FILE_TYPE_ICON stays plain path-data and every element is built
 * inside a function. Do not "promote" any of these to a module-top element.
 */

import { React } from "@webpack/common";

import { STRINGS } from "../strings";
import type { ContentType } from "../engine/types";

// A type's glyph is an array of [d, extraAttrs] tuples (a type can layer a document
// frame + a type mark). All drawn on a 24x24 grid in Discord's muted icon tone.
export type IconPath = [string] | [string, Record<string, any>];

// A shared rounded document outline (page with a folded corner) used as the base
// frame for the text-ish types so they share one silhouette.
const DOC_FRAME = "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-7-7Zm0 2.5L17.5 9H14a1 1 0 0 1-1-1V4.5Z";

// PLAIN DATA — path strings only, NO React.createElement. (See the file header.)
export const FILE_TYPE_ICON: Record<string, IconPath[]> = {
    // PDF: document frame + "PDF" marked by three short text rules.
    pdf: [
        [DOC_FRAME],
        ["M7 12.5h10V14H7v-1.5Zm0 3h10V17H7v-1.5Zm0 3h7V20H7v-1.5Z"]
    ],
    // Markdown: document frame + the canonical "M▼" markdown mark.
    markdown: [
        [DOC_FRAME],
        ["M6.5 12.5h11a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-6a.5.5 0 0 1 .5-.5Zm1.25 5.25v-2.4l1.25 1.5 1.25-1.5v2.4h1.25v-4h-1.25l-1.25 1.55L9 13.75H7.75v4h0Zm7-4h-1.25v2h-1l1.625 2 1.625-2h-1v-2Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // HTML / interactive artifact: angle-bracket code mark on a document.
    html: [
        [DOC_FRAME],
        ["M10 12.6 7.3 15.3a1 1 0 0 0 0 1.4L10 19.4l1-1-2.2-2.2L11 14l-1-1.4Zm4 0-1 1.4 2.2 1.9-2.2 2.2 1 1 2.7-2.7a1 1 0 0 0 0-1.4L14 12.6Z"]
    ],
    // Code / text: a document with angle brackets (same family as html, leaner).
    code: [
        [DOC_FRAME],
        ["M9.7 13 7 15.7a1 1 0 0 0 0 1.4L9.7 19.8 11 18.6l-2.4-2.2L11 14.2 9.7 13Zm4.6 0L13 14.2l2.4 2.2L13 18.6l1.3 1.2 2.7-2.7a1 1 0 0 0 0-1.4L14.3 13Z"]
    ],
    // Image: the classic Discord "framed picture" (rect + sun + mountain).
    image: [
        ["M4 5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5Zm3-1a1 1 0 0 0-1 1v9.59l2.3-2.3a1 1 0 0 1 1.4 0l2.3 2.3 3.3-3.3a1 1 0 0 1 1.4 0L18 14.6V5a1 1 0 0 0-1-1H7Zm2.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Word document: document frame + a "W" mark.
    docx: [
        [DOC_FRAME],
        ["M6.4 13h1.4l.9 3.8.95-3.8h1.3l.95 3.8.9-3.8H15l-1.55 6h-1.4l-.85-3.4-.85 3.4H8.95L6.4 13Z"]
    ],
    // Presentation (PowerPoint): document frame + a "P" mark.
    pptx: [
        [DOC_FRAME],
        ["M7.5 12.5h3.4c1.5 0 2.4.9 2.4 2.3s-.9 2.3-2.4 2.3H9v2.4H7.5v-7Zm1.5 1.3v2h1.7c.7 0 1.1-.4 1.1-1s-.4-1-1.1-1H9Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Spreadsheet: document frame + a small grid mark.
    xlsx: [
        [DOC_FRAME],
        ["M6.5 12.5h11v6.5h-11v-6.5Zm1.25 1.25v1.25H11v-1.25H7.75Zm4.5 0v1.25h3.75v-1.25h-3.75Zm-4.5 2.5v1.25H11v-1.25H7.75Zm4.5 0v1.25h3.75v-1.25h-3.75Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Mermaid diagram: two linked nodes (a tiny flowchart glyph).
    mermaid: [
        ["M5 4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1v3h3.05a2.5 2.5 0 1 1 0 1.5H10v-1.5H9V8H7a2 2 0 0 1-2-2V4Zm12 13a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Graphviz / DOT: a small directed-graph glyph (three nodes joined by edges).
    graphviz: [
        ["M11 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm-1.2 6.6L6.6 12.4a2.5 2.5 0 1 0 1.1 1L10.9 10.6a4 4 0 0 1-1.1-1ZM5 14.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm7.2-4.9 3.2 2.8a2.5 2.5 0 1 1-1.1 1l-3.2-2.8a4 4 0 0 0 1.1-1ZM18 14.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Jupyter notebook: document frame + a circle-on-a-line "[*]" notebook prompt mark.
    ipynb: [
        [DOC_FRAME],
        ["M6.5 14h6v1.5h-6V14Zm0 3h6v1.5h-6V17Zm9.25-3.6a1.85 1.85 0 1 0 0 3.7 1.85 1.85 0 0 0 0-3.7Zm0 1.3a.55.55 0 1 1 0 1.1.55.55 0 0 1 0-1.1Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Structured (JSON / XML tree): document frame + a "{ }" braces mark.
    structured: [
        [DOC_FRAME],
        ["M9.2 12.5c-1 0-1.5.5-1.5 1.4v1.1c0 .5-.2.7-.7.7v1.1c.5 0 .7.2.7.7v1.1c0 .9.5 1.4 1.5 1.4v-1.2c-.3 0-.4-.1-.4-.5v-.9c0-.5-.2-.8-.6-1 .4-.2.6-.5.6-1v-.9c0-.4.1-.5.4-.5v-1.1Zm5.6 0v1.1c.3 0 .4.1.4.5v.9c0 .5.2.8.6 1-.4.2-.6.5-.6 1v.9c0 .4-.1.5-.4.5v1.2c1 0 1.5-.5 1.5-1.4v-1.1c0-.5.2-.7.7-.7v-1.1c-.5 0-.7-.2-.7-.7v-1.1c0-.9-.5-1.4-1.5-1.4Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Rich-text documents (RTF / ODT): document frame + short justified text rules.
    rtf: [
        [DOC_FRAME],
        ["M7 12.5h10V14H7v-1.5Zm0 3h10V17H7v-1.5Zm0 3h7V20H7v-1.5Z"]
    ],
    odt: [
        [DOC_FRAME],
        ["M7 12.5h10V14H7v-1.5Zm0 3h10V17H7v-1.5Zm0 3h7V20H7v-1.5Z"]
    ],
    // CSV / TSV: a plain grid mark on the document frame (same family as xlsx).
    csv: [
        [DOC_FRAME],
        ["M6.5 12.5h11v6.5h-11v-6.5Zm1.25 1.25v1.25H11v-1.25H7.75Zm4.5 0v1.25h3.75v-1.25h-3.75Zm-4.5 2.5v1.25H11v-1.25H7.75Zm4.5 0v1.25h3.75v-1.25h-3.75Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // ODP presentation: reuse the pptx "P" mark on the frame.
    odp: [
        [DOC_FRAME],
        ["M7.5 12.5h3.4c1.5 0 2.4.9 2.4 2.3s-.9 2.3-2.4 2.3H9v2.4H7.5v-7Zm1.5 1.3v2h1.7c.7 0 1.1-.4 1.1-1s-.4-1-1.1-1H9Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Email (.eml) / Outlook (.msg): an envelope glyph.
    email: [
        ["M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Zm2.2-.4 6.8 5.1 6.8-5.1a1 1 0 0 0-.3-.1h-13a1 1 0 0 0-.3.1Zm13.3 1.7-6 4.5a1 1 0 0 1-1.2 0l-6-4.5v9.7a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V7.8Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    msg: [
        ["M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Zm2.2-.4 6.8 5.1 6.8-5.1a1 1 0 0 0-.3-.1h-13a1 1 0 0 0-.3.1Zm13.3 1.7-6 4.5a1 1 0 0 1-1.2 0l-6-4.5v9.7a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V7.8Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Exotic images (TIFF/HEIC/PSD/RAW/…) — the framed-picture image glyph, so they
    // read as pictures alongside plain images.
    rasterimage: [
        ["M4 5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5Zm3-1a1 1 0 0 0-1 1v9.59l2.3-2.3a1 1 0 0 1 1.4 0l2.3 2.3 3.3-3.3a1 1 0 0 1 1.4 0L18 14.6V5a1 1 0 0 0-1-1H7Zm2.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // DICOM (medical) / DXF (CAD) / RAW / PostScript (EPS/AI): the picture glyph too
    // (they all decode to an image surface).
    dicom: [
        ["M4 5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5Zm3-1a1 1 0 0 0-1 1v9.59l2.3-2.3a1 1 0 0 1 1.4 0l2.3 2.3 3.3-3.3a1 1 0 0 1 1.4 0L18 14.6V5a1 1 0 0 0-1-1H7Zm2.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    dxf: [
        ["M4 5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5Zm3-1a1 1 0 0 0-1 1v9.59l2.3-2.3a1 1 0 0 1 1.4 0l2.3 2.3 3.3-3.3a1 1 0 0 1 1.4 0L18 14.6V5a1 1 0 0 0-1-1H7Zm2.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    raw: [
        ["M4 5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5Zm3-1a1 1 0 0 0-1 1v9.59l2.3-2.3a1 1 0 0 1 1.4 0l2.3 2.3 3.3-3.3a1 1 0 0 1 1.4 0L18 14.6V5a1 1 0 0 0-1-1H7Zm2.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    postscript: [
        ["M4 5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5Zm3-1a1 1 0 0 0-1 1v9.59l2.3-2.3a1 1 0 0 1 1.4 0l2.3 2.3 3.3-3.3a1 1 0 0 1 1.4 0L18 14.6V5a1 1 0 0 0-1-1H7Zm2.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // 3D models: a cube (isometric box).
    model3d: [
        ["M12 2.2a1 1 0 0 0-.5.13l-7 4A1 1 0 0 0 4 7.2v9.6a1 1 0 0 0 .5.87l7 4a1 1 0 0 0 1 0l7-4a1 1 0 0 0 .5-.87V7.2a1 1 0 0 0-.5-.87l-7-4A1 1 0 0 0 12 2.2Zm0 2.15 5 2.85-5 2.86-5-2.86 5-2.85ZM6 8.92l5 2.86v5.7l-5-2.86V8.92Zm7 8.56v-5.7l5-2.86v5.7l-5 2.86Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Audio: a music note.
    audio: [
        ["M18 3.5a1 1 0 0 0-1.24-.97l-8 2A1 1 0 0 0 8 5.5v9.3A3.5 3.5 0 1 0 10 18V9.28l6-1.5v4.52A3.5 3.5 0 1 0 18 15V3.5Z"]
    ],
    // Video: a film / play-in-rect glyph.
    video: [
        ["M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Zm6.4 2.6a1 1 0 0 0-1.4.9v4a1 1 0 0 0 1.5.87l3.5-2a1 1 0 0 0 0-1.74l-3.6-2.03Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Thread: Discord's own thread glyph (a speech line branching into a reply), so a
    // thread tab reads as a thread at a glance, matching the native thread affordance.
    thread: [
        ["M12 2.81a9.19 9.19 0 0 0-8.05 13.6l-1.2 3.63a1 1 0 0 0 1.27 1.27l3.63-1.2A9.19 9.19 0 1 0 12 2.8Zm-4 6.94h8a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2Zm0 3.5h5a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2Z", { "fillRule": "evenodd", "clipRule": "evenodd" }]
    ],
    // Fallback (unknown / binary): a plain document frame.
    unknown: [[DOC_FRAME]]
};

export const ZOOM_OUT_PATH = "M19 11a1 1 0 0 1 0 2H5a1 1 0 1 1 0-2h14Z";
export const ZOOM_IN_PATH = "M13 5a1 1 0 1 0-2 0v6H5a1 1 0 1 0 0 2h6v6a1 1 0 1 0 2 0v-6h6a1 1 0 1 0 0-2h-6V5Z";
// Open-hand "pan tool" glyph (Material "pan_tool") for the PDF drag-mode toggle.
export const PAN_HAND_PATH = "M21 11.5v5a4.5 4.5 0 0 1-4.5 4.5h-3.4a4.5 4.5 0 0 1-3.18-1.32l-4.9-4.9a1.4 1.4 0 0 1 1.98-1.98l1.5 1.5V5.5a1.25 1.25 0 0 1 2.5 0v5h.5v-7a1.25 1.25 0 0 1 2.5 0v7h.5v-6a1.25 1.25 0 0 1 2.5 0v6h.5v-4.5a1.25 1.25 0 0 1 2.5 0Z";

/** Build the <path> elements for a content type's glyph (lazy — React is ready at
 *  call time). Used by the header leading icon and by tabIcon. */
export function iconPaths(type: ContentType): any[] {
    return (FILE_TYPE_ICON[type] || FILE_TYPE_ICON.unknown).map(
        ([d, extra]: IconPath, i: number) =>
            React.createElement("path", { key: i, fill: "currentColor", d, ...(extra || {}) })
    );
}

/** A small SVG toolbar button (square, hover bg) — shared by all tool types.
 *  `disabled` keeps the button in its slot but dimmed + non-interactive (Discord
 *  grammar rule 9: a control never disappears by mode; when inactive it renders
 *  disabled, not removed). A disabled button drops its hover/active state, dims,
 *  shows a default cursor, and no-ops on click. */
export function toolBtn(key: string, label: string, path: string, onClick: () => void, active = false, disabled = false) {
    return React.createElement(
        "button",
        {
            key,
            type: "button",
            className: "dockview-tool-btn"
                + (active && !disabled ? " dockview-tool-btn-active" : "")
                + (disabled ? " dockview-tool-btn-disabled" : ""),
            "aria-label": label,
            title: label,
            "aria-pressed": (active && !disabled) || undefined,
            "aria-disabled": disabled || undefined,
            disabled,
            onClick: disabled ? undefined : onClick
        },
        React.createElement(
            "svg",
            { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: path })
        )
    );
}

/** The shared zoom group: [− %readout +]. Identical layout / icons / spacing for
 *  PDF + image. `keyPrefix` keys the two buttons; `pct` is the integer percent. */
export function zoomGroup(keyPrefix: string, pct: number, onOut: () => void, onIn: () => void) {
    return React.createElement(
        "div",
        { className: "dockview-tool-group dockview-zoom-group" },
        toolBtn(keyPrefix + "-zoom-out", STRINGS.zoom.out, ZOOM_OUT_PATH, onOut),
        React.createElement("span", { className: "dockview-tool-pct", title: STRINGS.zoom.level }, pct + "%"),
        toolBtn(keyPrefix + "-zoom-in", STRINGS.zoom.in, ZOOM_IN_PATH, onIn)
    );
}

/** A copy button whose glyph flips to a checkmark while `copied` is true. */
export function copyBtn(key: string, label: string, copied: boolean, onClick: () => void) {
    return React.createElement(
        "button",
        {
            key,
            type: "button",
            className: "dockview-tool-btn dockview-tool-copy" + (copied ? " dockview-tool-copied" : ""),
            "aria-label": copied ? STRINGS.code.copied : label,
            title: copied ? STRINGS.code.copied : label,
            onClick
        },
        React.createElement(
            "svg",
            { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            copied
                ? React.createElement("path", { fill: "currentColor", d: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" })
                : React.createElement("path", { fill: "currentColor", d: "M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2Zm2 0h5a2 2 0 0 1 2 2v5h2V5h-9v2ZM6 9v9h9V9H6Z" })
        )
    );
}

/** A leading icon for a native Menu.MenuItem (Discord renders the `icon` prop in
 *  the row's left slot). Returns a component (MenuItem calls it). */
export const menuIcon = (d: string) => () =>
    React.createElement(
        "svg",
        { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true, className: "dockview-menu-icon" },
        React.createElement("path", { fill: "currentColor", d })
    );
