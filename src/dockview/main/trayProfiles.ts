/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from "child_process";
import { app, MenuItemConstructorOptions } from "electron";
import { getActiveProfileName, listProfileNames } from "main/profiles";

function switchToProfile(name: string | null, setIsQuitting: (val: boolean) => void) {
    const env = { ...process.env };
    delete env.VENCORD_USER_DATA_DIR;
    const args = name ? [`--profile=${name}`] : [];
    try {
        spawn(process.execPath, args, { detached: true, stdio: "ignore", env }).unref();
    } catch {
        return;
    }
    setIsQuitting(true);
    setTimeout(() => app.quit(), 900);
}

export function createDockViewProfileSwitchItems(setIsQuitting: (val: boolean) => void) {
    const activeProfile = getActiveProfileName();
    const switchItems: MenuItemConstructorOptions[] = [
        {
            label: "Default",
            type: "checkbox",
            checked: activeProfile === null,
            enabled: activeProfile !== null,
            click() {
                switchToProfile(null, setIsQuitting);
            }
        },
        ...listProfileNames().map<MenuItemConstructorOptions>(name => ({
            label: name,
            type: "checkbox",
            checked: name === activeProfile,
            enabled: name !== activeProfile,
            click() {
                switchToProfile(name, setIsQuitting);
            }
        }))
    ];

    return { activeProfile, switchItems };
}

export function getDockViewTrayTooltip(activeProfile: string | null) {
    return activeProfile ? `Vesktop — ${activeProfile}` : "Vesktop";
}
