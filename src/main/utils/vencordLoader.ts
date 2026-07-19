/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * DockView modification: ensureVencordFiles() now copies the Vencord+DockView
 * dist bundled inside the app (static/vencordDist) instead of downloading it
 * from GitHub.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { access, constants as FsConstants, writeFile } from "fs/promises";
import { BASE_DATA_DIR } from "main/constants";
import { PROFILES_ROOT } from "main/profiles";
import { VENCORD_FILES_DIR } from "main/vencordFilesDir";
import { join } from "path";
import { compareDockviewVersions, parseVersionTxt } from "shared/dockviewVersion";
import { STATIC_DIR } from "shared/paths";

// Directory holding the Vencord (+ DockView plugin) dist bundled with the app.
// Populated at build time by scripts/prepare-vencord.mjs and shipped via
// package.json -> build.files -> "static".
const VERSION_FILE_NAME = "version.txt";
const BUNDLED_VENCORD_DIR = join(STATIC_DIR, "vencordDist");
const BUNDLED_VERSION_FILE = join(BUNDLED_VENCORD_DIR, VERSION_FILE_NAME);
const INSTALLED_VERSION_FILE = join(VENCORD_FILES_DIR, VERSION_FILE_NAME);

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

    // The heavy viewer libraries (mermaid, pdfjs, ghostscript, three, …) ship as
    // chunk-*.js beside the four core files and are pulled in at runtime over the
    // readChunk IPC from VENCORD_FILES_DIR. They must be copied too — otherwise every
    // chunked viewer (PDF, mermaid, pptx, 3D, code) fails to load on a fresh install.
    for (const file of readdirSync(BUNDLED_VENCORD_DIR)) {
        if (file.startsWith("chunk-") && file.endsWith(".js")) {
            copyFileSync(join(BUNDLED_VENCORD_DIR, file), join(VENCORD_FILES_DIR, file));
        }
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

/**
 * One-time, best-effort migration for the shared plugin-files dir.
 *
 * The plugin files used to live PER PROFILE (<profile>/sessionData/vencordFiles);
 * they now live in a single profile-independent dir (VENCORD_FILES_DIR under
 * BASE_DATA_DIR) so one in-app OTA update covers every account. For a fresh or
 * single-account install this is a no-op — the default install's old dir IS the
 * shared dir (same path). The only loss case is a multi-account user who had OTA'd
 * a NAMED profile to a version newer than both the bundled build and the shared dir:
 * that OTA lived in the profile's own vencordFiles and would otherwise be ignored.
 *
 * So: scan the named profile dirs for the newest previously-installed version.txt
 * and, if it is newer than what the shared dir currently holds, seed the shared dir
 * from it. This runs BEFORE the version-guarded bundled copy below, so the guard
 * then sees the migrated (newer) version and preserves it. Any error is swallowed —
 * a failed migration just falls back to the bundled copy (worst case: that user
 * re-runs the OTA once).
 */
function migrateSharedVencordFiles() {
    // A custom vencordDir opts out of the shared-base layout entirely.
    if (VENCORD_FILES_DIR !== join(BASE_DATA_DIR, "sessionData", "vencordFiles")) return;

    try {
        const sharedVersion = readVersion(INSTALLED_VERSION_FILE); // string | null

        // Collect candidate per-profile installs: <PROFILES_ROOT>/<name>/sessionData/vencordFiles.
        let best: { dir: string; version: string } | null = null;
        let profileNames: string[] = [];
        try {
            profileNames = readdirSync(PROFILES_ROOT, { withFileTypes: true })
                .filter(e => e.isDirectory())
                .map(e => e.name);
        } catch {
            return; // no profiles root → nothing to migrate
        }

        for (const name of profileNames) {
            const candidateDir = join(PROFILES_ROOT, name, "sessionData", "vencordFiles");
            const version = readVersion(join(candidateDir, VERSION_FILE_NAME));
            if (version === null) continue;
            if (!existsSync(join(candidateDir, "vencordDesktopMain.js"))) continue; // incomplete install
            if (best === null || compareDockviewVersions(best.version, version) < 0) {
                best = { dir: candidateDir, version };
            }
        }

        if (!best) return;
        // Only seed when the best profile install is strictly newer than the shared dir.
        if (sharedVersion !== null && compareDockviewVersions(sharedVersion, best.version) >= 0) return;

        mkdirSync(VENCORD_FILES_DIR, { recursive: true });
        for (const file of readdirSync(best.dir)) {
            const src = join(best.dir, file);
            try {
                if (statSync(src).isFile()) copyFileSync(src, join(VENCORD_FILES_DIR, file));
            } catch {
                /* skip unreadable entry */
            }
        }
        console.log(
            `[VencordLoader] migrated shared Vencord dist from profile install ${JSON.stringify(best.dir)} ` +
                `(version ${JSON.stringify(best.version)} > shared ${JSON.stringify(sharedVersion)})`
        );
    } catch (err) {
        console.warn("[VencordLoader] shared-dir migration skipped:", err);
    }
}

export async function ensureVencordFiles() {
    // Best-effort: rescue a newer OTA that used to live in a per-profile dir.
    migrateSharedVencordFiles();

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
