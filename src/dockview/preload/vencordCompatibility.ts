/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DockViewIpcEvents } from "dockview/shared/IpcEvents";
import type { ipcRenderer as IpcRenderer } from "electron/renderer";
import { IpcEvents } from "shared/IpcEvents";

export function loadVencordPreloadCompatibility({
    Buffer,
    clearImmediate,
    ipcRenderer,
    isSandboxed,
    process,
    require,
    setImmediate
}: {
    Buffer: typeof globalThis.Buffer;
    clearImmediate: typeof globalThis.clearImmediate;
    ipcRenderer: typeof IpcRenderer;
    isSandboxed: boolean;
    process: NodeJS.Process;
    require: NodeRequire;
    setImmediate: typeof globalThis.setImmediate;
}) {
    if (isSandboxed) {
        Function(
            "require",
            "Buffer",
            "process",
            "clearImmediate",
            "setImmediate",
            ipcRenderer.sendSync(IpcEvents.GET_VENCORD_PRELOAD_SCRIPT)
        )(require, Buffer, process, clearImmediate, setImmediate);
    } else {
        require(ipcRenderer.sendSync(DockViewIpcEvents.DEPRECATED_GET_VENCORD_PRELOAD_SCRIPT_PATH));
    }
}
