/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync } from "fs";
import { copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { VENCORD_FILES_DIR } from "main/vencordFilesDir";
import { join } from "path";
import { DOCKVIEW_VENCORD_BUNDLE_FILES, DOCKVIEW_VENCORD_CORE_FILES } from "shared/dockviewBundleFiles";
import { compareDockviewVersions, parseVersionTxt } from "shared/dockviewVersion";
import { STATIC_DIR } from "shared/paths";

/** DockView is compiled into Vencord, so the matching distribution is shipped
 * with the app instead of downloading stock Vencord at runtime. */
const BUNDLED_DIR = join(STATIC_DIR, "vencordDist");
const VERSION_FILE = "version.txt";

export const FILES_TO_DOWNLOAD = DOCKVIEW_VENCORD_CORE_FILES;

function readText(path: string): Promise<string | null> {
    return readFile(path, "utf-8")
        .then(value => value.trim())
        .catch(() => null);
}

function filesExist(dir: string, names: readonly string[]): boolean {
    return names.every(name => existsSync(join(dir, name)));
}

/** The custom-directory picker calls this synchronously in upstream Vesktop.
 * Require the full DockView runtime set, not only the four Vencord core files. */
export function isValidVencordInstall(dir: string): boolean {
    if (typeof dir !== "string" || !dir) return false;
    if (!existsSync(join(dir, "package.json")) || !existsSync(join(dir, VERSION_FILE))) return false;

    return filesExist(dir, DOCKVIEW_VENCORD_BUNDLE_FILES);
}

async function assertBundledDistribution(): Promise<readonly string[]> {
    if (!filesExist(BUNDLED_DIR, DOCKVIEW_VENCORD_BUNDLE_FILES) || !(await readText(join(BUNDLED_DIR, VERSION_FILE)))) {
        throw new Error("[VencordLoader] Bundled DockView distribution is incomplete. Run pnpm prepareVencord.");
    }
    return DOCKVIEW_VENCORD_BUNDLE_FILES;
}

async function copyBundledDistribution(names: readonly string[]): Promise<void> {
    await mkdir(VENCORD_FILES_DIR, { recursive: true });
    await Promise.all(names.map(name => copyFile(join(BUNDLED_DIR, name), join(VENCORD_FILES_DIR, name))));

    // Both writes are awaited. Force Update must never relaunch with an incomplete
    // package marker or version stamp still buffered in an abandoned promise.
    await writeFile(join(VENCORD_FILES_DIR, "package.json"), "{}\n");
}

/** Repair/Force Update entry point. The operation is local and deterministic. */
export async function downloadVencordFiles(): Promise<void> {
    const names = await assertBundledDistribution();
    await copyBundledDistribution(names);
}

export async function ensureVencordFiles(): Promise<void> {
    const names = await assertBundledDistribution();
    const bundledVersion = await readText(join(BUNDLED_DIR, VERSION_FILE));
    const installedVersion = await readText(join(VENCORD_FILES_DIR, VERSION_FILE));
    const complete = filesExist(VENCORD_FILES_DIR, ["package.json", ...names]);

    let shouldCopy = !complete || installedVersion == null || bundledVersion == null;
    if (!shouldCopy && bundledVersion && installedVersion) {
        const order = compareDockviewVersions(installedVersion, bundledVersion);
        shouldCopy = order < 0;

        if (order === 0) {
            const installedBuild = parseVersionTxt(installedVersion).gitHash;
            const bundledBuild = parseVersionTxt(bundledVersion).gitHash;
            shouldCopy = installedBuild !== bundledBuild;
        }
    }

    if (shouldCopy) await copyBundledDistribution(names);
}
