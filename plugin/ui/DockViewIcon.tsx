/*
 * DockView — sidebar entry icon.
 * ---------------------------------------------------------------------------
 * The 20×20 glyph for the standalone "DockView" entry in Vencord's settings
 * sidebar. The Settings plugin renders sidebar icons as `<Icon width={20}
 * height={20} />` (see _core/settings.tsx buildEntry → `icon: () => <Icon
 * width={20} height={20} />`), so this component accepts the same width/height
 * (Vencord's IconProps) and degrades to 24 when called bare.
 *
 * The mark: a rounded window split into a wide left pane and a narrow docked
 * right pane — DockView's whole shape (a right-docked panel). Drawn with
 * `currentColor` so it inherits the sidebar item's active/idle tint, exactly
 * like Discord's own settings icons.
 */

import { React } from "@webpack/common";

interface IconProps {
    width?: number | string;
    height?: number | string;
    className?: string;
}

export function DockViewIcon({ width = 24, height = 24, className }: IconProps) {
    return React.createElement(
        "svg",
        {
            width,
            height,
            className,
            viewBox: "0 0 24 24",
            role: "img",
            "aria-hidden": true
        },
        // The window frame.
        React.createElement("rect", {
            x: 3,
            y: 4,
            width: 18,
            height: 16,
            rx: 2.5,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.8
        }),
        // The divider between the main pane and the docked right pane.
        React.createElement("line", {
            x1: 15,
            y1: 4,
            x2: 15,
            y2: 20,
            stroke: "currentColor",
            strokeWidth: 1.8
        }),
        // The docked right pane, filled to read as the active panel.
        React.createElement("rect", {
            x: 15,
            y: 4,
            width: 6,
            height: 16,
            rx: 0,
            fill: "currentColor",
            opacity: 0.25
        })
    );
}
