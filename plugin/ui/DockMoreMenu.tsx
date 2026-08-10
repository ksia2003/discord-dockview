/* Active-file actions. Tab lifecycle lives exclusively in DockTabMenu. */

import { ContextMenuApi, Menu, React } from "@vencord/types/webpack/common";

import { hasFileActionSurface } from "../engine/dockEligibility";
import type { DockWindow } from "../engine/types";
import { getActiveWindow } from "../engine/window";
import {
    attachActiveFile, downloadWindowFile, type FileVersion
} from "../edit/attach";
import { jumpToSourceMessage } from "../external/jumpToSource";
import { STRINGS } from "../strings";
import { menuIcon } from "./toolbar";

const MORE_PATH = "M5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z";
const ICON = {
    jump: menuIcon("M5 4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-6l-4 4v-4H6a1 1 0 0 1-1-1V4Zm4 4v2h6V8H9Zm0 4v2h4v-2H9Z"),
    download: menuIcon("M12 3a1 1 0 0 1 1 1v9.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42l2.3 2.3V4a1 1 0 0 1 1-1ZM5 18a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z"),
    attach: menuIcon("M16.5 6.3 8.8 14a2 2 0 1 0 2.83 2.83l7.07-7.07a4 4 0 1 0-5.66-5.66l-7.07 7.07a6 6 0 0 0 8.49 8.49l6.36-6.36a1 1 0 0 0-1.41-1.42l-6.37 6.37a4 4 0 0 1-5.65-5.66l7.07-7.07a2 2 0 0 1 2.83 2.83l-7.08 7.07a.99.99 0 0 1-1.4-1.41l7.7-7.7a1 1 0 0 0-1.42-1.41Z")
};

function versionActions(w: DockWindow, version: FileVersion, prefix: string) {
    return [
        React.createElement(Menu.MenuItem, {
            key: `${prefix}-download`,
            id: `${prefix}-download`,
            label: STRINGS.menu.download,
            icon: ICON.download,
            action: () => downloadWindowFile(w, version)
        }),
        React.createElement(Menu.MenuItem, {
            key: `${prefix}-attach`,
            id: `${prefix}-attach`,
            label: STRINGS.menu.attach,
            icon: ICON.attach,
            action: () => attachActiveFile(null, w, version)
        })
    ];
}

export function DockMoreMenu({ win }: { win?: DockWindow } = {}) {
    const w = win || getActiveWindow();
    const hasEdits = w.editView.editBuffer != null;
    const canUseFile = hasFileActionSurface(w.content.type)
        && !w.content.loading && !w.content.error && w.content.name != null
        && (w.content.code != null || w.content.html != null || w.content.url != null);
    const items: any[] = [];

    if (w.sourceMessage) {
        items.push(React.createElement(Menu.MenuItem, {
            key: "jump",
            id: "dockview-file-jump-source",
            label: STRINGS.menu.jumpToMessage,
            icon: ICON.jump,
            action: () => jumpToSourceMessage(w.sourceMessage!)
        }));
    }

    if (canUseFile) {
        if (hasEdits) {
            items.push(
                React.createElement(
                    Menu.MenuItem,
                    { key: "current", id: "dockview-file-current", label: STRINGS.menu.currentVersion },
                    ...versionActions(w, "current", "dockview-file-current")
                )
            );
            if (!w.isNewFile) {
                items.push(
                    React.createElement(
                        Menu.MenuItem,
                        { key: "original", id: "dockview-file-original", label: STRINGS.menu.originalVersion },
                        ...versionActions(w, "original", "dockview-file-original")
                    )
                );
            }
        } else {
            items.push(...versionActions(w, "current", "dockview-file"));
        }
    }

    return React.createElement(
        Menu.Menu,
        { navId: "dockview-more-menu", onClose: ContextMenuApi.closeContextMenu },
        React.createElement(Menu.MenuGroup, null, ...items)
    );
}

export function DockMoreButton() {
    const win = getActiveWindow();
    if (win.content.name == null || !hasFileActionSurface(win.content.type)) return null;
    return React.createElement(
        "button",
        {
            type: "button",
            className: "dockview-tool-btn dockview-file-more",
            title: STRINGS.header.more,
            "aria-label": STRINGS.header.more,
            onClick: (event: any) => {
                event.preventDefault();
                event.stopPropagation();
                ContextMenuApi.openContextMenu(event, () => React.createElement(DockMoreMenu, { win }));
            }
        },
        React.createElement(
            "svg",
            { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: MORE_PATH })
        )
    );
}
