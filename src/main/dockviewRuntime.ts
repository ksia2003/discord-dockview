/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Stable app-shell loader for the independently updated DockView runtime.
 *
 * New DockView native features travel through one Runtime ABI v1 invocation
 * instead of adding a new app IPC/preload method each time. The legacy named
 * export path keeps pre-ABI runtimes usable during migration and rollback.
 */

import { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent, session, shell } from "electron";
import { readFileSync } from "fs";
import { join } from "path";

import { DOCKVIEW_RUNTIME_ABI_VERSION } from "../shared/dockviewRuntimeAbi";
import { DOCKVIEW_FILES_DIR } from "./dockviewFilesDir";
import { enableDockViewWebviews, installDockViewWebviewSecurity } from "./dockviewWebview";

const LEGACY_METHODS = new Set([
    "readInstalledVersion",
    "readChunk",
    "convertAttachment",
    "discoverManifest",
    "applyUpdate"
]);

interface DockViewRuntime {
    DOCKVIEW_RUNTIME_ABI_VERSION?: number;
    invoke?: (event: IpcMainInvokeEvent, method: string, args: unknown[]) => unknown;
    configureBrowserWindow?: (options: BrowserWindowConstructorOptions) => void;
    attachBrowserWindow?: (
        win: BrowserWindow,
        host: {
            fromPartition(partition: string): Electron.Session;
            openExternal(url: string): void | Promise<void>;
        }
    ) => void;
    [method: string]: unknown;
}

let runtime: DockViewRuntime | null = null;

function getRuntime(): DockViewRuntime {
    return (runtime ??= require(join(DOCKVIEW_FILES_DIR, "dockviewMain.js")));
}

function usesRuntimeAbiV1(value: DockViewRuntime): boolean {
    return (
        value.DOCKVIEW_RUNTIME_ABI_VERSION === DOCKVIEW_RUNTIME_ABI_VERSION &&
        typeof value.invoke === "function" &&
        typeof value.configureBrowserWindow === "function" &&
        typeof value.attachBrowserWindow === "function"
    );
}

export function readDockviewRendererScript(): string {
    return readFileSync(join(DOCKVIEW_FILES_DIR, "dockviewRenderer.js"), "utf-8");
}

export function invokeDockviewRuntime(event: IpcMainInvokeEvent, method: string, args: unknown[]): unknown {
    const loaded = getRuntime();
    if (usesRuntimeAbiV1(loaded)) return loaded.invoke!(event, method, args);

    if (loaded.DOCKVIEW_RUNTIME_ABI_VERSION != null) {
        throw new Error(`Unsupported DockView runtime ABI: ${loaded.DOCKVIEW_RUNTIME_ABI_VERSION}`);
    }
    if (!LEGACY_METHODS.has(method)) throw new Error(`Unsupported legacy DockView method: ${method}`);

    const legacy = loaded[method];
    if (typeof legacy !== "function") throw new Error(`DockView runtime does not implement ${method}`);
    return legacy(event, ...args);
}

export function configureDockviewBrowserWindow(options: BrowserWindowConstructorOptions): void {
    const loaded = getRuntime();
    if (usesRuntimeAbiV1(loaded)) loaded.configureBrowserWindow!(options);
    else enableDockViewWebviews(options);
}

export function attachDockviewBrowserWindow(win: BrowserWindow): void {
    const loaded = getRuntime();
    if (usesRuntimeAbiV1(loaded)) {
        loaded.attachBrowserWindow!(win, {
            fromPartition: partition => session.fromPartition(partition),
            openExternal: url => shell.openExternal(url)
        });
    } else {
        installDockViewWebviewSecurity(win);
    }
}
