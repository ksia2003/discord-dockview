/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Independent DockView runtime installer/upgrader.

import { existsSync } from "fs";
import { copyFile, mkdir, readFile } from "fs/promises";
import { DOCKVIEW_FILES_DIR } from "main/dockviewFilesDir";
import { join } from "path";
import { DOCKVIEW_RUNTIME_FILES } from "shared/dockviewBundleFiles";
import { compareDockviewVersions, parseVersionTxt } from "shared/dockviewVersion";
import { STATIC_DIR } from "shared/paths";

const BUNDLED_DIR = join(STATIC_DIR, "dockviewDist");
const VERSION_FILE = "version.txt";

function filesExist(dir: string, names: readonly string[]): boolean {
    return names.every(name => existsSync(join(dir, name)));
}

async function readText(path: string): Promise<string | null> {
    return readFile(path, "utf-8")
        .then(value => value.trim())
        .catch(() => null);
}

async function assertBundledDistribution(): Promise<string> {
    const version = await readText(join(BUNDLED_DIR, VERSION_FILE));
    if (!version || !filesExist(BUNDLED_DIR, DOCKVIEW_RUNTIME_FILES)) {
        throw new Error("[DockViewLoader] Bundled DockView distribution is incomplete. Run pnpm prepareVencord.");
    }
    return version;
}

async function copyBundledDistribution(): Promise<void> {
    await mkdir(DOCKVIEW_FILES_DIR, { recursive: true });
    await Promise.all(
        DOCKVIEW_RUNTIME_FILES.map(name => copyFile(join(BUNDLED_DIR, name), join(DOCKVIEW_FILES_DIR, name)))
    );
}

export async function ensureDockviewFiles(): Promise<void> {
    const bundledVersion = await assertBundledDistribution();
    const installedVersion = await readText(join(DOCKVIEW_FILES_DIR, VERSION_FILE));
    const complete = filesExist(DOCKVIEW_FILES_DIR, DOCKVIEW_RUNTIME_FILES);

    let shouldCopy = !complete || installedVersion == null;
    if (!shouldCopy && installedVersion) {
        const order = compareDockviewVersions(installedVersion, bundledVersion);
        shouldCopy = order < 0;
        if (order === 0) {
            shouldCopy = parseVersionTxt(installedVersion).gitHash !== parseVersionTxt(bundledVersion).gitHash;
        }
    }
    if (shouldCopy) await copyBundledDistribution();
}
