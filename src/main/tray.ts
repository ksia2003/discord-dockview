/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from "child_process";
import { app, BrowserWindow, Menu, MenuItemConstructorOptions, Tray } from "electron";

import { createAboutWindow } from "./about";
import { AppEvents } from "./events";
import { getActiveProfileName, listProfileNames } from "./profiles";
import { Settings } from "./settings";
import { resolveAssetPath } from "./userAssets";
import { clearData } from "./utils/clearData";
import { downloadVencordFiles } from "./utils/vencordLoader";

/** Switch THIS instance to another profile from the tray: spawn the target (a named
 *  --profile, or the default install when `name` is null) detached, then quit this one
 *  after a short grace so exactly one window remains. Mirrors the plugin-side
 *  switchProfileImpl; kept here (small, self-contained) so the tray needs no plugin
 *  import. The spawn env is cleaned of VENCORD_USER_DATA_DIR so the child honours
 *  --profile / the default rather than inheriting an env-pinned dir. */
function switchToProfile(name: string | null, setIsQuitting: (val: boolean) => void) {
    const env = { ...process.env };
    delete env.VENCORD_USER_DATA_DIR;
    const args = name ? [`--profile=${name}`] : [];
    try {
        spawn(process.execPath, args, { detached: true, stdio: "ignore", env }).unref();
    } catch {
        return; // Couldn't launch the other profile — stay put rather than quit into nothing.
    }
    setIsQuitting(true);
    setTimeout(() => app.quit(), 900);
}

let tray: Tray;
let trayVariant: "tray" | "trayUnread" = "tray";

AppEvents.on("userAssetChanged", async asset => {
    if (tray && (asset === "tray" || asset === "trayUnread")) {
        tray.setImage(await resolveAssetPath(trayVariant));
    }
});

AppEvents.on("setTrayVariant", async variant => {
    if (trayVariant === variant) return;

    trayVariant = variant;
    if (!tray) return;

    tray.setImage(await resolveAssetPath(trayVariant));
});

export function destroyTray() {
    tray?.destroy();
}

export async function initTray(win: BrowserWindow, setIsQuitting: (val: boolean) => void) {
    const onTrayClick = () => {
        if (Settings.store.clickTrayToShowHide && win.isVisible()) win.hide();
        else win.show();
    };

    // "Switch account" submenu: the default install + every named profile, the current
    // one checked and disabled (switching to yourself is a no-op). Selecting another
    // replaces this window with that profile (one window at a time). null = the default.
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

    const trayMenu = Menu.buildFromTemplate([
        {
            label: "Open",
            click() {
                win.show();
            }
        },
        {
            label: "Switch account",
            submenu: switchItems
        },
        {
            label: "About",
            click: createAboutWindow
        },
        {
            label: "Repair Vencord",
            async click() {
                await downloadVencordFiles();
                app.relaunch();
                app.quit();
            }
        },
        {
            label: "Reset Vesktop",
            async click() {
                await clearData(win);
            }
        },
        {
            type: "separator"
        },
        {
            label: "Restart",
            click() {
                app.relaunch();
                app.quit();
            }
        },
        {
            label: "Quit",
            click() {
                setIsQuitting(true);
                app.quit();
            }
        }
    ]);

    // Append the profile name when running a non-default profile so several
    // instances (each its own account) are distinguishable in the tray.
    tray = new Tray(await resolveAssetPath(trayVariant));
    tray.setToolTip(activeProfile ? `Vesktop — ${activeProfile}` : "Vesktop");
    tray.setContextMenu(trayMenu);
    tray.on("click", onTrayClick);
}
