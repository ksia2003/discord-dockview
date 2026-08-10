/* Browser-style lifecycle menu for one content tab.
 *
 * This menu deliberately owns only tab collection actions. File actions belong to the
 * active viewer toolbar's more menu; opening a context menu on an inactive tab must not
 * activate that tab unless the chosen lifecycle action necessarily leaves it active.
 */

import { ContextMenuApi, Menu, React } from "@vencord/types/webpack/common";

import { setContextActive } from "../engine/contextTab";
import { requestRender } from "../engine/forceRender";
import { hostActions } from "../engine/hostBridge";
import { closeTab, switchToWindow } from "../engine/tabs";
import type { DockWindow } from "../engine/types";
import { getActiveWindowId, getWindowChannelId, getWindows, isRealTab } from "../engine/window";
import { STRINGS } from "../strings";
import { getDockContextView } from "../host/searchResults";
import { menuIcon } from "./toolbar";

const CLOSE_ICON = menuIcon("M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z");

function liveTabs(): DockWindow[] {
    return getWindows().filter(isRealTab);
}

function activateTarget(target: DockWindow): void {
    const channelId = getWindowChannelId();
    hostActions().revealDock();
    hostActions().deactivateSearchView();
    setContextActive(channelId, false);
    switchToWindow(target.id);
    // switchToWindow intentionally no-ops when this window is already the hidden active
    // binding under Channel info/Search. Repaint so the explicit menu action still makes
    // the target the visible Dock surface.
    requestRender();
}

function closeOtherTabs(target: DockWindow): void {
    const ids = liveTabs()
        .filter(tab => tab.id !== target.id)
        .map(tab => tab.id)
        .reverse();
    for (const id of ids) closeTab(id);
    // If the target began inactive, closing tabs on the other side does not always
    // traverse it. The contract for "Close other tabs" is explicit: the survivor is
    // active once the operation completes.
    activateTarget(target);
}

function closeTabsToRight(target: DockWindow): void {
    const tabs = liveTabs();
    const index = tabs.findIndex(tab => tab.id === target.id);
    if (index < 0) return;
    const removedIds = new Set(tabs.slice(index + 1).map(tab => tab.id));
    const channelId = getWindowChannelId();
    const fileTabWasVisible = getDockContextView(channelId) == null;
    const activeWasRemoved = fileTabWasVisible && removedIds.has(getActiveWindowId());
    for (const id of [...removedIds].reverse()) closeTab(id);
    if (activeWasRemoved) activateTarget(target);
}

export function DockTabMenu({ win }: { win: DockWindow; }) {
    const tabs = liveTabs();
    const index = tabs.findIndex(tab => tab.id === win.id);

    return React.createElement(
        Menu.Menu,
        { navId: "dockview-tab-menu", onClose: ContextMenuApi.closeContextMenu },
        React.createElement(
            Menu.MenuGroup,
            null,
            React.createElement(Menu.MenuItem, {
                id: "dockview-tab-close",
                label: STRINGS.tabs.close,
                icon: CLOSE_ICON,
                disabled: index < 0,
                action: () => closeTab(win.id)
            }),
            React.createElement(Menu.MenuItem, {
                id: "dockview-tab-close-others",
                label: STRINGS.menu.closeOtherTabs,
                disabled: index < 0 || tabs.length <= 1,
                action: () => closeOtherTabs(win)
            }),
            React.createElement(Menu.MenuItem, {
                id: "dockview-tab-close-right",
                label: STRINGS.menu.closeTabsToRight,
                disabled: index < 0 || index === tabs.length - 1,
                action: () => closeTabsToRight(win)
            })
        )
    );
}
