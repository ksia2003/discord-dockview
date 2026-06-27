/*
 * The ⋯ more-menu — a Discord-native context menu of SECONDARY per-window actions
 * (the per-type toolbar already exposes zoom/page/etc.). Parameterized by a window
 * `win`: a non-active tab's ⋯ opens the menu for THAT window and every action
 * operates on it IN PLACE — opening the menu never switches the active tab.
 *
 * Items: Attach-to-message (when there's a file to stage), Pin/Unpin (always),
 * Open-in-browser (per-type in-app window) + Download + Copy-link (when a url), and
 * the viewer-specific bits (PDF fit-to-width, image copy-image) GUARDED behind
 * `isActive && a registered viewer` so they degrade gracefully.
 *
 * The "Attach to message" item stages the live/edited buffer as an upload via the
 * cross-cutting edit/attach layer (the EDITED buffer is staged when the file has
 * edits). For the ACTIVE window it opens the inline filename bar (active-window
 * header chrome); a non-active tab attaches THAT window's file directly under its
 * own name (its hidden header has no inline bar).
 */

import { ContextMenuApi, Menu, React } from "@webpack/common";

import { pinActiveWindow, unpinActiveWindow } from "../engine/tabs";
import { getActiveWindow } from "../engine/window";
import { absUrl, copyText, downloadUrl } from "../external/openExternal";
import { openInVesktopWindow } from "../external/vesktopWindow";
import { attachActiveFile, openAttachBar } from "../edit/attach";
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
    // Paperclip — the universal "attach a file" affordance (matches Discord's own).
    attach: menuIcon("M16.5 6.3 8.8 14a2 2 0 1 0 2.83 2.83l7.07-7.07a4 4 0 1 0-5.66-5.66l-7.07 7.07a6 6 0 0 0 8.49 8.49l6.36-6.36a1 1 0 0 0-1.41-1.42l-6.37 6.37a4 4 0 0 1-5.65-5.66l7.07-7.07a2 2 0 0 1 2.83 2.83l-7.08 7.07a.99.99 0 0 1-1.4-1.41l7.7-7.7a1 1 0 0 0-1.42-1.41Z"),
    pin: menuIcon("M19.38 11.38a3 3 0 0 0 0-4.24l-2.52-2.52a3 3 0 0 0-4.24 0l-1.06 1.06a1 1 0 0 0 0 1.42l.7.7-4.6 4.6a1 1 0 0 0 0 1.41l.36.36-2.83 2.83a2 2 0 0 0-.44.68l-1 2.5a1 1 0 0 0 1.3 1.3l2.5-1a2 2 0 0 0 .68-.44l2.83-2.83.36.36a1 1 0 0 0 1.41 0l4.6-4.6.7.7a1 1 0 0 0 1.42 0l1.06-1.06Z")
};

export function DockMoreMenu({ win }: { win?: DockWindow } = {}) {
    const w = win || getActiveWindow();
    const isActive = w === getActiveWindow();
    const url = w.content.url;
    const name = w.content.name as string | null;
    const type = w.content.type;
    const isHtml = type === "html";

    const items: any[] = [];

    // Attach to message: stage THIS window's file as a pending upload on the channel
    // composer. Shown whenever there's a file to attach — text in memory
    // (code/csv/structured/unknown), inline artifact html, or a url. For the ACTIVE
    // window, open the inline filename bar (active-window header chrome); a non-active
    // tab attaches THAT window's file directly under its own name.
    const canAttach = !w.content.loading && !w.content.error && w.content.name != null
        && (w.content.code != null || (isHtml && w.content.html != null) || url != null);
    if (canAttach) {
        items.push(React.createElement(Menu.MenuItem, {
            id: "dockview-more-attach",
            label: STRINGS.menu.attach,
            icon: MENU_ICON.attach,
            action: () => { if (isActive) openAttachBar(); else attachActiveFile(null, w); }
        }));
    }

    // Pin / Unpin: promote THIS window to a persistent TAB (survives channel
    // switches), or demote a pinned window back to the channel-bound transient.
    items.push(React.createElement(Menu.MenuItem, {
        id: "dockview-more-pin",
        label: w.pinned ? STRINGS.menu.unpin : STRINGS.menu.pin,
        icon: MENU_ICON.pin,
        action: () => { if (w.pinned) unpinActiveWindow(w); else pinActiveWindow(w); }
    }));

    // Open in browser: open the CURRENT file in a real IN-APP Vesktop window. ONE
    // reliable path for every viewer — openInVesktopWindow() builds the per-type
    // shell (artifact html / rendered markdown / <pre> text / <embed> pdf / <img>
    // image, embedding url-backed types by their working url) and opens it via the
    // empty-window + write path (in-app regardless of the "Open Links in app"
    // setting). Shown whenever there's a file (content or a url to embed).
    if (w.content.name != null) {
        items.push(React.createElement(Menu.MenuItem, {
            id: "dockview-more-popout",
            label: STRINGS.menu.openInNewWindow,
            icon: MENU_ICON.popout,
            action: () => openInVesktopWindow(w)
        }));
    }
    if (url) {
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
