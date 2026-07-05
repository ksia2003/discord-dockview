/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

import { CommandLine } from "./cli";
import { getProfileDataDir } from "./profiles";

const vesktopDir = dirname(process.execPath);

export const PORTABLE =
    process.platform === "win32" &&
    !process.execPath.toLowerCase().endsWith("electron.exe") &&
    !existsSync(join(vesktopDir, "Uninstall Vesktop.exe"));

// A named --profile=<name> resolves to its own data dir (multi-account isolation);
// an explicit VENCORD_USER_DATA_DIR still wins (it's applied on the next line). The
// default launch (no env, no --profile) is null here, so DATA_DIR stays byte-
// identical to upstream. See profiles.ts.
const profileDataDir = getProfileDataDir();

export const DATA_DIR =
    process.env.VENCORD_USER_DATA_DIR ||
    profileDataDir ||
    (PORTABLE ? join(vesktopDir, "Data") : join(app.getPath("userData")));

// The profile-INDEPENDENT base data dir. Frozen HERE, before the profile setPath
// below rewrites Electron's "userData" to the profile dir — after that,
// app.getPath("userData") would return the profile dir, not the base. This anchors
// data that must be SHARED across every account profile (the plugin CODE / OTA
// files) rather than duplicated per profile. For the DEFAULT no-profile launch,
// DATA_DIR === BASE_DATA_DIR, so anything derived from it is byte-identical to
// upstream (no migration for existing single-account users).
export const BASE_DATA_DIR = PORTABLE ? join(vesktopDir, "Data") : join(app.getPath("userData"));

// When a profile is active (env-pinned OR --profile), scope Electron's userData —
// and therefore requestSingleInstanceLock + all Chromium storage — to the profile
// dir, EARLY (before any lock / app.ready). Without this, a second profile instance
// keys its lock on the DEFAULT userData and would fold into / quit against the
// default instance. The default no-profile launch skips this, leaving userData
// exactly as upstream (existing users' data untouched). GoofCord ships this same
// per-dir lock model; the shared-data variant (Legcord #685) is deliberately avoided.
if (process.env.VENCORD_USER_DATA_DIR || profileDataDir) {
    app.setPath("userData", DATA_DIR);
}

mkdirSync(DATA_DIR, { recursive: true });

export const SESSION_DATA_DIR = join(DATA_DIR, "sessionData");
app.setPath("sessionData", SESSION_DATA_DIR);

// Profile-independent counterpart of SESSION_DATA_DIR — the shared base under which
// the plugin files live (see vencordFilesDir.ts). Electron's session storage itself
// stays per-profile (SESSION_DATA_DIR above); only the shared plugin CODE uses this.
export const BASE_SESSION_DATA_DIR = join(BASE_DATA_DIR, "sessionData");

export const VENCORD_SETTINGS_DIR = join(DATA_DIR, "settings");
mkdirSync(VENCORD_SETTINGS_DIR, { recursive: true });
export const VENCORD_QUICKCSS_FILE = join(VENCORD_SETTINGS_DIR, "quickCss.css");
export const VENCORD_SETTINGS_FILE = join(VENCORD_SETTINGS_DIR, "settings.json");
export const VENCORD_THEMES_DIR = join(DATA_DIR, "themes");

export const USER_AGENT = `DockView/${app.getVersion()} (https://github.com/ksia2003/discord-dockview)`;

// dimensions shamelessly stolen from Discord Desktop :3
export const MIN_WIDTH = 940;
export const MIN_HEIGHT = 500;
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;

export const DISCORD_HOSTNAMES = ["discord.com", "canary.discord.com", "ptb.discord.com"];

const VersionString = `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split(".")[0]}.0.0.0 Safari/537.36`;
const BrowserUserAgents = {
    darwin: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${VersionString}`,
    linux: `Mozilla/5.0 (X11; Linux x86_64) ${VersionString}`,
    windows: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${VersionString}`
};

export const BrowserUserAgent =
    CommandLine.values["user-agent"] ||
    BrowserUserAgents[CommandLine.values["user-agent-os"] || process.platform] ||
    BrowserUserAgents.windows;

export const enum MessageBoxChoice {
    Default,
    Cancel
}

export const IS_FLATPAK = process.env.FLATPAK_ID !== undefined;
