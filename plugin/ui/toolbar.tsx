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
