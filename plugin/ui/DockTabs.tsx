/*
 * The tab strip (pin-driven multi-window). ALWAYS rendered — one window or many —
 * so the dock has a single unified header/tab model (a lone window is just a single
 * tab). The tabs ARE the header's icon/name slot.
 *
 * "header = tab" model: each tab carries its OWN persistent ⋯ + ✕ acting on THAT
 * window — the only shared header control is the far-right DOCK X (owned by
 * DockPanel). The per-tab controls are PERSISTENT on EVERY tab (no hover/active
 * gating), so tab widths are stable (no layout shift). The ⋯ opens THAT window's menu
 * IN PLACE (parameterized by `w`, never setActiveWindow → no tab switch); the ✕
 * closes THAT window (closeTab — closing the LAST tab leaves the dock open on the
 * empty card, only the dock X closes the dock). Tabs are FLAT (icon + name); the
 * active tab gets a subtle underline + brighter text (CSS), not a pill.
 */

import { ContextMenuApi, React } from "@webpack/common";

import { closeTab, switchToWindow } from "../engine/tabs";
import { getActiveWindowId, getWindows } from "../engine/window";
import { STRINGS } from "../strings";
import type { ContentType } from "../engine/types";
import { DockMoreMenu } from "./DockMoreMenu";
import { iconPaths } from "./toolbar";

const TAB_CLOSE_PATH = "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z";
const TAB_MORE_PATH = "M7 12.001C7 13.105 6.105 14 5 14C3.895 14 3 13.105 3 12.001C3 10.896 3.895 10.001 5 10.001C6.105 10.001 7 10.896 7 12.001ZM14 12.001C14 13.105 13.105 14 12 14C10.895 14 10 13.105 10 12.001C10 10.896 10.895 10.001 12 10.001C13.105 10.001 14 10.896 14 12.001ZM19 14C20.105 14 21 13.105 21 12.001C21 10.896 20.105 10.001 19 10.001C17.895 10.001 17 10.896 17 12.001C17 13.105 17.895 14 19 14Z";

/** A file-type glyph for a tab. SIZE PARITY with the single-window header's leading
 *  glyph (20px) — a tab must never shrink any element vs the pre-tab header. */
function tabIcon(type: ContentType) {
    return React.createElement(
        "svg",
        { className: "dockview-tab-icon", width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
        ...iconPaths(type)
    );
}

/** A per-tab ghost icon control (⋯ / ✕) — flat, borderless, at a tab's right edge.
 *  Distinct from the tab body so its click never bubbles into a tab switch. SIZE
 *  PARITY with the single-window header's ⋯/✕ (20px). */
function tabCtrlBtn(opts: { key: string; cls: string; label: string; path: string; onClick: (e: any) => void; }) {
    return React.createElement(
        "button",
        {
            key: opts.key,
            type: "button",
            className: "dockview-tab-ctrl " + opts.cls,
            "aria-label": opts.label,
            title: opts.label,
            onClick: opts.onClick
        },
        React.createElement(
            "svg",
            { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: opts.path })
        )
    );
}

/** Tabs row. Every tab carries its OWN persistent ⋯ + ✕ acting on THAT window. A
 *  tab's ✕ always closes THAT window via closeTab (active or not); closing the last
 *  tab leaves the dock open on the empty card. */
export function DockTabs() {
    const activeId = getActiveWindowId();
    return React.createElement(
        "div",
        { className: "dockview-tabs", role: "tablist" },
        ...getWindows().map(w => {
            const isActive = w.id === activeId;
            // An empty window (no file yet — the open-but-empty dock) shows the short
            // product name, not the long empty-card sentence.
            const label = (w.content.name as string | null) || STRINGS.tabs.untitled;
            return React.createElement(
                "div",
                {
                    key: w.id,
                    className: "dockview-tab" + (isActive ? " dockview-tab-active" : ""),
                    role: "tab",
                    "aria-selected": isActive,
                    title: label,
                    onClick: () => switchToWindow(w.id)
                },
                tabIcon(w.content.type),
                React.createElement("span", { className: "dockview-tab-name" }, label),
                tabCtrlBtn({
                    key: "more",
                    cls: "dockview-tab-more",
                    label: STRINGS.header.more,
                    path: TAB_MORE_PATH,
                    onClick: (e: any) => {
                        e.stopPropagation();
                        ContextMenuApi.openContextMenu(e, () => React.createElement(DockMoreMenu, { win: w }));
                    }
                }),
                tabCtrlBtn({
                    key: "close",
                    cls: "dockview-tab-close",
                    label: STRINGS.tabs.close,
                    path: TAB_CLOSE_PATH,
                    onClick: (e: any) => {
                        e.stopPropagation();
                        closeTab(w.id);
                    }
                })
            );
        })
    );
}
