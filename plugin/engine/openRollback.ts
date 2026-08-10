import { Toasts } from "@vencord/types/webpack/common";

import { setContextActive, setContextView } from "./contextTab";
import { requestRender } from "./forceRender";
import { hostActions } from "./hostBridge";
import { closeTab, switchToWindow } from "./tabs";
import {
    allLiveWindows, getActiveWindow, getActiveWindowId, getWindowChannelId, getWindows,
    removeWindowEverywhere
} from "./window";
import { STRINGS } from "../strings";
import { selectThreadPortal } from "../viewers/thread/threadPortal";

let settling = false;

function showFailureToast(): void {
    try {
        Toasts.show(Toasts.create(
            STRINGS.error.openFailedToast,
            Toasts.Type.FAILURE,
            { position: Toasts.Position.BOTTOM }
        ));
    } catch {
        /* Toast drift must never block rollback. */
    }
}

/** Settle every provisional NEW-tab load, including a tab/channel the user left before
 * its request completed. Existing tabs never carry openRollback and keep their ordinary
 * retry/error surface. Called in DockPanel's layout effect after any engine repaint. */
export function settlePendingOpens(): void {
    if (settling) return;
    settling = true;
    try {
        let removedInactive = false;
        for (const win of [...allLiveWindows()]) {
            const rollback = win.openRollback;
            if (!rollback || win.content.loading) continue;
            if (!win.content.error) {
                win.openRollback = null;
                continue;
            }

            win.openRollback = null;
            const isCurrentActive = win.id === getActiveWindowId()
                && win.ownerChannelId === getWindowChannelId();
            if (!isCurrentActive) {
                // The user already left this provisional tab (or its channel). Remove
                // only that dead tab; their current Dock selection must not jump back.
                removeWindowEverywhere(win);
                removedInactive = true;
                showFailureToast();
                continue;
            }

            closeTab(win.id);
            const channelId = getWindowChannelId();
            if (rollback.previousContextView) {
                setContextView(channelId, rollback.previousContextView);
                selectThreadPortal(null);
            } else {
                const previous = getWindows().find(tab => tab.id === rollback.previousWindowId);
                if (previous) {
                    setContextActive(channelId, false);
                    switchToWindow(previous.id);
                }
            }
            if (rollback.previousSearch) hostActions().activateSearchView();
            showFailureToast();
        }
        if (removedInactive) requestRender();
    } finally {
        settling = false;
    }
}
