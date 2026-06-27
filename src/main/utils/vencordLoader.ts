/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * DockView modifications (c) 2026 DockView contributors:
 *   ensureVencordFiles() now copies the Vencord+DockView dist bundled inside
 *   the app (static/vencordDist) instead of downloading from GitHub.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { access, constants as FsConstants, writeFile } from "fs/promises";
import { VENCORD_FILES_DIR } from "main/vencordFilesDir";
import { join } from "path";
import { compareDockviewVersions, parseVersionTxt } from "shared/dockviewVersion";
import { STATIC_DIR } from "shared/paths";

// Directory holding the Vencord (+ DockView plugin) dist bundled with the app.
// Populated at build time by scripts/prepare-vencord.mjs and shipped via
// package.json -> build.files -> "static".
const BUNDLED_VENCORD_DIR = join(STATIC_DIR, "vencordDist");
const BUNDLED_VERSION_FILE = join(BUNDLED_VENCORD_DIR, "version.txt");
const INSTALLED_VERSION_FILE = join(VENCORD_FILES_DIR, "version.txt");

export const FILES_TO_DOWNLOAD = [
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css"
];

const existsAsync = (path: string) =>
    access(path, FsConstants.F_OK)
        .then(() => true)
        .catch(() => false);

export async function isValidVencordInstall(dir: string) {
    const results = await Promise.all(["package.json", ...FILES_TO_DOWNLOAD].map(f => existsAsync(join(dir, f))));
    return !results.includes(false);
}

function readVersion(path: string) {
    try {
        return readFileSync(path, "utf-8").trim();
    } catch {
        return null;
    }
}

/**
 * Copies the bundled Vencord (+ DockView) dist into VENCORD_FILES_DIR.
 * No network access is performed; the files travel inside the app package.
 */
function copyBundledVencordFiles() {
    mkdirSync(VENCORD_FILES_DIR, { recursive: true });

    for (const file of FILES_TO_DOWNLOAD) {
        copyFileSync(join(BUNDLED_VENCORD_DIR, file), join(VENCORD_FILES_DIR, file));
    }

    // Minimal package.json marker so isValidVencordInstall() passes.
    writeFile(join(VENCORD_FILES_DIR, "package.json"), "{}");

    const bundledVersion = readVersion(BUNDLED_VERSION_FILE);
    if (bundledVersion) {
        writeFile(INSTALLED_VERSION_FILE, bundledVersion);
    }
}

/**
 * Force a (re)install of the bundled Vencord (+ DockView) dist, unconditionally.
 * Used by the "Repair / Force Update Vencord" menu entries. Despite the name,
 * this performs a local copy from the bundled dist, never a network download.
 */
export async function downloadVencordFiles() {
    if (!existsSync(BUNDLED_VENCORD_DIR)) {
        throw new Error(`[VencordLoader] Bundled Vencord dist not found at ${BUNDLED_VENCORD_DIR}.`);
    }
    copyBundledVencordFiles();
}

export async function ensureVencordFiles() {
    if (!existsSync(BUNDLED_VENCORD_DIR)) {
        throw new Error(
            `[VencordLoader] Bundled Vencord dist not found at ${BUNDLED_VENCORD_DIR}. ` +
                "Run `node scripts/prepare-vencord.mjs` before building."
        );
    }

    // Version-guarded (re)install of the bundled Vencord+DockView dist on startup.
    // The copy overwrites the live data-dir files, so doing it unconditionally
    // would clobber a hot-deployed / OTA-updated plugin (newer than the bundled
    // build) on every restart. Compare the bundled vs installed version.txt and
    // only copy when the bundled build is the same-or-newer canonical version;
    // skip when the install is already newer so an OTA patch survives a restart.
    // (Enabled-plugin state lives in Vencord's settings store, not here, so this
    // never touches user settings either way.)
    const bundled = readVersion(BUNDLED_VERSION_FILE); // string | null
    const installed = readVersion(INSTALLED_VERSION_FILE); // string | null

    let shouldCopy: boolean;
    let reason: string;
    if (installed === null) {
        // First install, or an unreadable/corrupt install: fail safe to the
        // known-good bundled build.
        shouldCopy = true;
        reason = "no readable installed version";
    } else if (bundled === null) {
        // Can't reason about bundled provenance: fail safe to the shipped build.
        shouldCopy = true;
        reason = "no readable bundled version";
    } else if (compareDockviewVersions(installed, bundled) < 0) {
        // Bundled is NEWER (e.g. a full-app upgrade ships a newer plugin): refresh.
        shouldCopy = true;
        reason = "bundled is newer";
    } else if (
        compareDockviewVersions(installed, bundled) === 0 &&
        parseVersionTxt(bundled).gitHash !== parseVersionTxt(installed).gitHash
    ) {
        // SAME DockView version but a DIFFERENT build — e.g. an app reinstall or a
        // version-bump release that ships the same plugin version compiled from a
        // different commit. compareDockviewVersions only looks at the plugin version,
        // so it can't see this; fall back to the build hash. A differing gitHash means
        // a different bundle (its preload/main may differ from the live ones), so
        // install it — otherwise a stale preload/main from the previous build persists
        // out of sync with the new renderer (this is exactly what broke Vencord
        // Settings: old preload lacked supportsWindowsMaterial). A genuine OTA bumps
        // the plugin version so it sorts NEWER and is preserved by the branch above;
        // this fires only on a version tie with differing builds.
        shouldCopy = true;
        reason = "same version, different build (gitHash differs)";
    } else {
        // Installed is same-or-newer AND the same build (plain restart, or a genuine
        // higher-versioned OTA patch): preserve it.
        shouldCopy = false;
        reason = "installed is same-or-newer (same build)";
    }

    console.log(
        `[VencordLoader] ${shouldCopy ? "copying bundled" : "keeping installed"} Vencord dist ` +
            `(${reason}; installed=${JSON.stringify(installed)}, bundled=${JSON.stringify(bundled)})`
    );

    if (shouldCopy) {
        copyBundledVencordFiles();
    }
}

// TODO: remove this once enough time has passed
export function vencordSupportsSandboxing() {
    const supports = readFileSync(join(VENCORD_FILES_DIR, "vencordDesktopMain.js"), "utf-8").includes(
        "VencordGetRendererCss"
    );
    if (!supports) {
        console.warn(
            "⚠️  [VencordLoader] Vencord version is outdated and does not support sandboxing. Please update Vencord to the latest version."
        );
    }
    return supports;
}
