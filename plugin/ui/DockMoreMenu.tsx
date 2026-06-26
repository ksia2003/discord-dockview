/*
 * The ⋯ more-menu — a Discord-native context menu of SECONDARY per-window actions
 * (the per-type toolbar already exposes zoom/page/etc.). Parameterized by a window
 * `win`: a non-active tab's ⋯ opens the menu for THAT window and every action
 * operates on it IN PLACE — opening the menu never switches the active tab.
 *
 * Items: Pin/Unpin (always), Open-in-browser + Download + Copy-link (when a url),
 * and the viewer-specific bits (PDF fit-to-width, image copy-image) GUARDED behind
 * `isActive && a registered viewer` so they degrade gracefully with zero viewers
 * (Phase 2 reality: no viewer is registered, so those never show).
 *
 * The "Attach to message" item (it stages the live/edited buffer as an upload) rides
 * the edit/attach cross-cutting layer that lands in P8 — omitted here.
 */

import { ContextMenuApi, Menu, React } from "@webpack/common";

import { pinActiveWindow, unpinActiveWindow } from "../engine/tabs";
import { getActiveWindow } from "../engine/window";
import { absUrl, copyText, downloadUrl, openUrlInVesktopWindow } from "../external/openExternal";
import { STRINGS } from "../strings";
import { getViewer } from "../viewers/registry";
import type { DockWindow } from "../engine/types";
import { menuIcon } from "./toolbar";

const MENU_ICON = {
    popout: menuIcon("M10 5a1 1 0 0 0 0 2h5.59l-8.3 8.3a1 1 0 1 0 1.42 1.4l8.29-8.29V14a1 1 0 1 0 2 0V6a1 1 0 0 0-1-1h-8Z M5 8a3 3 0 0 1 3-3h2a1 1 0 1 1 0 2H8a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2a1 1 0 1 1 2 0v2a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8Z"),
    download: menuIcon("M12 3a1 1 0 0 1 1 1v9.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42l2.3 2.3V4a1 1 0 0 1 1-1ZM5 18a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z"),
    copyImage: menuIcon("M4 5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5Zm3-1a1 1 0 0 0-1 1v9.59l2.3-2.3a1 1 0 0 1 1.4 0l2.3 2.3 3.3-3.3a1 1 0 0 1 1.4 0L18 14.6V5a1 1 0 0 0-1-1H7Zm2.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"),
    copyLink: menuIcon("M9.88 13.41a1 1 0 0 1 0-1.41l2.12-2.12a1 1 0 0 1 1.42 1.41L11.3 13.4a1 1 0 0 1-1.42 0Zm-2.3 4.6a3 3 0 0 1 0-4.24l2.12-2.12a1 1 0 0 1 1.42 1.41l-2.12 2.12a1 1 0 0 0 1.41 1.42l2.12-2.13a1 1 0 0 1 1.42 1.42l-2.13 2.12a3 3 0 0 1-4.24 0Zm9.9-9.9a3 3 0 0 1 0 4.25l-2.13 2.12a1 1 0 0 1-1.41-1.41l2.12-2.13a1 1 0 0 0-1.41-1.41l-2.12 2.12a1 1 0 1 1-1.42-1.42l2.13-2.12a3 3 0 0 1 4.24 0Z"),
    fitWidth: menuIcon("M4 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1Zm16 0a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1ZM8.7 8.3a1 1 0 0 0-1.4 1.4l.29.3H7a1 1 0 0 0 0 2h.59l-.3.3a1 1 0 1 0 1.42 1.4l2-2a1 1 0 0 0 0-1.4l-2-2Zm6.6 0a1 1 0 0 1 1.4 1.4l-.29.3H17a1 1 0 1 1 0 2h-.59l.3.3a1 1 0 0 1-1.42 1.4l-2-2a1 1 0 0 1 0-1.4l2-2Z"),
    pin: menuIcon("M19.38 11.38a3 3 0 0 0 0-4.24l-2.52-2.52a3 3 0 0 0-4.24 0l-1.06 1.06a1 1 0 0 0 0 1.42l.7.7-4.6 4.6a1 1 0 0 0 0 1.41l.36.36-2.83 2.83a2 2 0 0 0-.44.68l-1 2.5a1 1 0 0 0 1.3 1.3l2.5-1a2 2 0 0 0 .68-.44l2.83-2.83.36.36a1 1 0 0 0 1.41 0l4.6-4.6.7.7a1 1 0 0 0 1.42 0l1.06-1.06Z")
};

export function DockMoreMenu({ win }: { win?: DockWindow } = {}) {
    const w = win || getActiveWindow();
    const isActive = w === getActiveWindow();
    const url = w.content.url;
    const name = w.content.name as string | null;
    const type = w.content.type;

    const items: any[] = [];

    // Pin / Unpin: promote THIS window to a persistent TAB (survives channel
    // switches), or demote a pinned window back to the channel-bound transient.
    items.push(React.createElement(Menu.MenuItem, {
        id: "dockview-more-pin",
        label: w.pinned ? STRINGS.menu.unpin : STRINGS.menu.pin,
        icon: MENU_ICON.pin,
        action: () => { if (w.pinned) unpinActiveWindow(w); else pinActiveWindow(w); }
    }));

    // Open in browser: open the CURRENT file in a real IN-APP Vesktop window. The
    // content-rich per-type popout (a rendered markdown / <pre> code / <embed> pdf
    // shell built from the live content) rides the viewer render pipelines (P4/P5);
    // for now any url-backed file embeds its url, which is the same path the state
    // cards use. Shown only when there's a url to embed.
    if (url) {
        items.push(React.createElement(Menu.MenuItem, {
            id: "dockview-more-popout",
            label: STRINGS.menu.openInNewWindow,
            icon: MENU_ICON.popout,
            action: () => openUrlInVesktopWindow(url, name || "file")
        }));
        items.push(React.createElement(Menu.MenuItem, {
            id: "dockview-more-download",
            label: STRINGS.menu.download,
            icon: MENU_ICON.download,
            action: () => downloadUrl(url, name)
        }));
    }

    // Image copy: needs the image viewer's copy path (it transcodes to a PNG blob).
    // Guarded behind a registered image viewer + the active window, so it stays
    // hidden until P4 wires the viewer.
    if (isActive && type === "image" && url && getViewer("image")) {
        const viewer = getViewer("image") as any;
        if (typeof viewer.copyImage === "function") {
            items.push(React.createElement(Menu.MenuItem, {
                id: "dockview-more-copy-image",
                label: STRINGS.menu.copyImage,
                icon: MENU_ICON.copyImage,
                action: () => viewer.copyImage(url)
            }));
        }
    }

    // PDF fit-to-width: needs the live PDF controller (the active viewer). Guarded
    // behind a registered pdf viewer; hidden until P7.
    if (isActive && type === "pdf" && getViewer("pdf")) {
        const viewer = getViewer("pdf") as any;
        if (typeof viewer.fitWidth === "function") {
            items.push(React.createElement(Menu.MenuItem, {
                id: "dockview-more-fit-width",
                label: STRINGS.menu.fitToWidth,
                icon: MENU_ICON.fitWidth,
                action: () => viewer.fitWidth()
            }));
        }
    }

    const linkGroup = url
        ? [
            React.createElement(Menu.MenuSeparator, { key: "sep" }),
            React.createElement(Menu.MenuGroup, { key: "link" },
                React.createElement(Menu.MenuItem, {
                    id: "dockview-more-copy-link",
                    label: STRINGS.menu.copyLink,
                    icon: MENU_ICON.copyLink,
                    action: () => copyText(absUrl(url))
                })
            )
        ]
        : [];

    return React.createElement(Menu.Menu, {
        navId: "dockview-more-menu",
        onClose: ContextMenuApi.closeContextMenu
    },
    React.createElement(Menu.MenuGroup, null, ...items),
    ...linkGroup
    );
}
