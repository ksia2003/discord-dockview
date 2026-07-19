/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import { getProfileDataDir } from "main/profiles";

export interface DockViewDataPaths {
    baseDataDir: string;
    dataDir: string;
    shouldSetUserData: boolean;
}

export function resolveDockViewDataPaths({
    getDefaultUserData,
    portableDataDir
}: {
    getDefaultUserData: () => string;
    portableDataDir?: string;
}): DockViewDataPaths {
    const profileDataDir = getProfileDataDir();
    const explicitDataDir = process.env.VENCORD_USER_DATA_DIR;

    return {
        dataDir: explicitDataDir || profileDataDir || portableDataDir || getDefaultUserData(),
        baseDataDir: portableDataDir || getDefaultUserData(),
        shouldSetUserData: Boolean(explicitDataDir || profileDataDir)
    };
}

export function applyDockViewGpuBlocklistBypass(ignoreGpuBlocklist: boolean, enabledFeatures: Set<string>) {
    if (!ignoreGpuBlocklist) return;

    app.commandLine.appendSwitch("ignore-gpu-blocklist");
    enabledFeatures.add("VaapiIgnoreDriverChecks");
    app.commandLine.appendSwitch("enable-gpu-rasterization");
    app.commandLine.appendSwitch("enable-zero-copy");
}

export function registerDockViewReadyHooks(initFirewall: () => void, initVoiceFix: () => void) {
    initFirewall();
    initVoiceFix();
}

export function getDockViewUserAgent(version: string) {
    return `DockView/${version} (https://github.com/ksia2003/discord-dockview)`;
}
