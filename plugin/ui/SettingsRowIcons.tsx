/*
 * DockView — per-row icons for the settings sidebar section.
 * ---------------------------------------------------------------------------
 * One distinct glyph per DockView settings row, so the sidebar reads like
 * Discord's own native sections (each row a recognisable mark) rather than a
 * column of identical panel icons.
 *
 * SHAPE. Vencord's Settings plugin renders sidebar icons as `<Icon width={20}
 * height={20} />`, so every icon here is a function component taking the same
 * width/height (Vencord's IconProps) and degrading to 24 when called bare —
 * matching DockViewIcon's contract.
 *
 * MODULE-TOP TRAP. `React` from @webpack/common is a lazy proxy that is NOT
 * ready at module-eval; calling React.createElement at module top throws and
 * takes the whole plugin import down. So the glyphs are stored as PLAIN PATH
 * DATA (strings) and every element is built inside a function (`glyph()`),
 * never at module top. Icons paint with `currentColor` so they inherit the
 * sidebar item's idle/hover/active tint, exactly like Discord's own icons.
 *
 * SET A — Discord-native line icons. Thin single-weight line glyphs in the same
 * visual language as Discord's own settings sidebar (Account / Data & Privacy /
 * Notifications …). Each row gets a semantic mark: General=sliders,
 * Viewers=eye, Performance=gauge, Privacy=shield,
 * Updates=refresh, Examples=gallery, About=info.
 */

import { React } from "@vencord/types/webpack/common";

interface IconProps {
    width?: number | string;
    height?: number | string;
    className?: string;
}

// A glyph is one or more <path>-like element specs, built lazily. Each entry is
// [tag, attrs] so a mark can layer strokes/fills. Stored as data, never elements.
type El = [string, Record<string, any>];

// Shared stroke defaults for the line style (Discord-native weight).
const S = (extra: Record<string, any>): El => ["path", {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...extra
}];

const GLYPHS: Record<string, El[]> = {
    // General — horizontal sliders (settings/tuning).
    general: [
        S({ d: "M4 7h9" }), S({ d: "M17 7h3" }),
        S({ d: "M4 12h3" }), S({ d: "M11 12h9" }),
        S({ d: "M4 17h13" }), S({ d: "M21 17h-1" }),
        ["circle", { cx: 15, cy: 7, r: 2, fill: "none", stroke: "currentColor", strokeWidth: 1.7 }],
        ["circle", { cx: 9, cy: 12, r: 2, fill: "none", stroke: "currentColor", strokeWidth: 1.7 }],
        ["circle", { cx: 19, cy: 17, r: 2, fill: "none", stroke: "currentColor", strokeWidth: 1.7 }]
    ],
    // Viewers — an eye (what the panel shows / previews).
    viewers: [
        S({ d: "M3 12s3.5-6.5 9-6.5 9 6.5 9 6.5-3.5 6.5-9 6.5-9-6.5-9-6.5Z" }),
        ["circle", { cx: 12, cy: 12, r: 2.6, fill: "none", stroke: "currentColor", strokeWidth: 1.7 }]
    ],
    // Performance — a speed gauge (dial + needle).
    performance: [
        S({ d: "M4 16a8 8 0 0 1 16 0" }),
        S({ d: "M12 16l4-4" }),
        ["circle", { cx: 12, cy: 16, r: 1.3, fill: "currentColor" }]
    ],
    // Privacy — a shield.
    privacy: [
        S({ d: "M12 3.5l7 2.6v5.1c0 4.3-2.9 7.3-7 8.8-4.1-1.5-7-4.5-7-8.8V6.1l7-2.6Z" })
    ],
    // Updates — circular refresh arrows.
    updates: [
        S({ d: "M20 12a8 8 0 1 1-2.3-5.6" }),
        S({ d: "M20 4v3.5h-3.5" })
    ],
    // Examples — a gallery (framed picture with a mountain).
    examples: [
        ["rect", { x: 4, y: 5, width: 16, height: 14, rx: 2.5, fill: "none", stroke: "currentColor", strokeWidth: 1.7 }],
        ["circle", { cx: 9, cy: 10, r: 1.4, fill: "none", stroke: "currentColor", strokeWidth: 1.5 }],
        S({ d: "M5 16.5l4-3.5 3 2.5 3-3 4 4" })
    ],
    // About — an info circle.
    about: [
        ["circle", { cx: 12, cy: 12, r: 8.2, fill: "none", stroke: "currentColor", strokeWidth: 1.7 }],
        S({ d: "M12 11v5" }),
        ["circle", { cx: 12, cy: 8, r: 1, fill: "currentColor" }]
    ]
};

/** Build one row's icon component from its glyph data (lazy — React is ready at
 *  render time, never at module top). */
function makeIcon(glyph: El[]) {
    return function RowIcon({ width = 24, height = 24, className }: IconProps) {
        return React.createElement(
            "svg",
            { width, height, className, viewBox: "0 0 24 24", role: "img", "aria-hidden": true },
            ...glyph.map(([tag, attrs], i) => React.createElement(tag, { key: i, ...attrs }))
        );
    };
}

export const ROW_ICONS = {
    general: makeIcon(GLYPHS.general),
    viewers: makeIcon(GLYPHS.viewers),
    performance: makeIcon(GLYPHS.performance),
    privacy: makeIcon(GLYPHS.privacy),
    updates: makeIcon(GLYPHS.updates),
    examples: makeIcon(GLYPHS.examples),
    about: makeIcon(GLYPHS.about)
};
