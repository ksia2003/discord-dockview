/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DockViewIpcEvents } from "dockview/shared/IpcEvents";
import { applyProxy, ProxyConfig, setFirewallEnabled } from "main/networkPrivacy";
import { handle, handleSync } from "main/utils/ipcWrappers";
import { VENCORD_FILES_DIR } from "main/vencordFilesDir";
import { setVoiceFixEnabled } from "main/voiceFix";
import { join } from "path";

type DockViewIpcRegistrationPoint = "compatibility" | "vencordFiles" | "privacy";

export function registerDockViewIpcHandlers(point: DockViewIpcRegistrationPoint) {
    switch (point) {
        case "compatibility":
            handleSync(DockViewIpcEvents.DEPRECATED_GET_VENCORD_PRELOAD_SCRIPT_PATH, () =>
                join(VENCORD_FILES_DIR, "vencordDesktopPreload.js")
            );
            break;
        case "vencordFiles":
            handleSync(DockViewIpcEvents.GET_VENCORD_FILES_DIR, () => VENCORD_FILES_DIR);
            break;
        case "privacy":
            handle(DockViewIpcEvents.SET_FIREWALL_ENABLED, (_, enabled: boolean) => setFirewallEnabled(enabled));
            handle(DockViewIpcEvents.SET_PROXY, (_, config: ProxyConfig) => applyProxy(config));
            handle(DockViewIpcEvents.SET_VOICE_FIX_ENABLED, (_, enabled: boolean) => setVoiceFixEnabled(enabled));
            break;
    }
}
