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

    // ALWAYS (re)install the bundled Vencord+DockView dist on startup. It's a
    // cheap local copy and it's the canonical Vencord for this build, so doing it
    // unconditionally means a stale or older Vencord left in the data dir — from a
    // previous Vesktop, an upgrade, or an earlier manual DockView install — can
    // never shadow the version shipped inside the app. (Enabled-plugin state lives
    // in Vencord's settings store, not here, so this doesn't touch user settings.)
    copyBundledVencordFiles();
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
