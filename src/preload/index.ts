/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { loadVencordPreloadCompatibility } from "dockview/preload/vencordCompatibility";
import { contextBridge, ipcRenderer, webFrame } from "electron/renderer";

import { IpcEvents } from "../shared/IpcEvents";
import { VesktopNative } from "./VesktopNative";

contextBridge.exposeInMainWorld("VesktopNative", VesktopNative);

const isSandboxed = typeof __dirname === "undefined";
// Electron supplies these bindings as preload-local values while sandboxed, so pass
// the call-site values through instead of resolving them from another module scope.
loadVencordPreloadCompatibility({
    Buffer,
    clearImmediate,
    ipcRenderer,
    isSandboxed,
    process,
    require,
    setImmediate
});

webFrame.executeJavaScript(ipcRenderer.sendSync(IpcEvents.GET_VENCORD_RENDERER_SCRIPT));
webFrame.executeJavaScript(ipcRenderer.sendSync(IpcEvents.GET_VESKTOP_RENDERER_SCRIPT));
