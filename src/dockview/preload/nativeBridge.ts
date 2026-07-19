/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DockViewIpcEvents } from "dockview/shared/IpcEvents";
import { ipcRenderer } from "electron/renderer";
import { invoke, sendSync } from "preload/typedIpc";

type DockViewNativeBridge = {
    dockView: {
        onOpenWebTab: (cb: (url: string) => void) => void;
        onWebTabDownload: (cb: (guestWebContentsId: number) => void) => void;
    };
    fileManager: {
        getVencordDir: () => string;
    };
    networkPrivacy: {
        setFirewallEnabled: (enabled: boolean) => Promise<void>;
        setProxy: (config: { enabled: boolean; rules: string; bypass: string }) => Promise<void>;
        setVoiceFixEnabled: (enabled: boolean) => Promise<void>;
    };
};

export function extendVesktopNative<T extends { fileManager: object }>(native: T): T & DockViewNativeBridge {
    return {
        ...native,
        fileManager: {
            ...native.fileManager,
            getVencordDir: () => sendSync<string>(DockViewIpcEvents.GET_VENCORD_FILES_DIR)
        },
        networkPrivacy: {
            setFirewallEnabled: (enabled: boolean) => invoke<void>(DockViewIpcEvents.SET_FIREWALL_ENABLED, enabled),
            setProxy: (config: { enabled: boolean; rules: string; bypass: string }) =>
                invoke<void>(DockViewIpcEvents.SET_PROXY, config),
            setVoiceFixEnabled: (enabled: boolean) => invoke<void>(DockViewIpcEvents.SET_VOICE_FIX_ENABLED, enabled)
        },
        dockView: {
            onWebTabDownload: (cb: (guestWebContentsId: number) => void) => {
                ipcRenderer.on(DockViewIpcEvents.WEB_TAB_DOWNLOAD, (_e, id: number) => cb(id));
            },
            onOpenWebTab: (cb: (url: string) => void) => {
                ipcRenderer.on(DockViewIpcEvents.WEB_TAB_OPEN, (_e, url: string) => cb(url));
            }
        }
    };
}
