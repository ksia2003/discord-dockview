/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync } from "fs";
import { copyFile, mkdir, readFile, unlink, writeFile } from "fs/promises";
import { VENCORD_FILES_DIR } from "main/vencordFilesDir";
import { join } from "path";
import { VENCORD_CORE_FILES } from "shared/dockviewBundleFiles";
import { STATIC_DIR } from "shared/paths";

import { USER_AGENT } from "../constants";
import { downloadFile, fetchie } from "./http";

const BUNDLED_DIR = join(STATIC_DIR, "vencordDist");
const API_BASE = "https://api.github.com";
const LEGACY_VERSION_FILE = "version.txt";
const LEGACY_DOCKVIEW_FILES = [
    LEGACY_VERSION_FILE,
    "chunk-mermaid.js",
    "chunk-agpsd.js",
    "chunk-jxl.js",
    "chunk-pptx.js",
    "chunk-dicomparser.js",
    "chunk-three.js",
    "chunk-ghostscript.js",
    "chunk-pdfjs.js",
    "chunk-codemirror.js",
    "chunk-samples.js"
] as const;

export const FILES_TO_DOWNLOAD = VENCORD_CORE_FILES;

interface ReleaseData {
    assets: Array<{
        name: string;
        browser_download_url: string;
    }>;
}

function filesExist(dir: string, names: readonly string[]): boolean {
    return names.every(name => existsSync(join(dir, name)));
}

export function isValidVencordInstall(dir: string): boolean {
    return (
        typeof dir === "string" && !!dir && existsSync(join(dir, "package.json")) && filesExist(dir, VENCORD_CORE_FILES)
    );
}

async function assertBundledDistribution(): Promise<void> {
    if (!filesExist(BUNDLED_DIR, VENCORD_CORE_FILES)) {
        throw new Error(
            "[VencordLoader] Bundled official Vencord distribution is incomplete. Run pnpm prepareVencord."
        );
    }
}

async function copyBundledDistribution(removeLegacy = false): Promise<void> {
    await mkdir(VENCORD_FILES_DIR, { recursive: true });
    await Promise.all(VENCORD_CORE_FILES.map(name => copyFile(join(BUNDLED_DIR, name), join(VENCORD_FILES_DIR, name))));
    await writeFile(join(VENCORD_FILES_DIR, "package.json"), "{}\n");
    if (removeLegacy) {
        await Promise.all(LEGACY_DOCKVIEW_FILES.map(name => unlink(join(VENCORD_FILES_DIR, name)).catch(() => {})));
    }
}

async function isLegacyCombinedInstall(): Promise<boolean> {
    try {
        const version = await readFile(join(VENCORD_FILES_DIR, LEGACY_VERSION_FILE), "utf-8");
        // Every DockView release before the split wrote version.txt beside the
        // Vencord core. Older releases used bare and "+dockview-" stamps; newer
        // ones use "dockview:". Official Vencord writes no version.txt here, so
        // any non-empty stamp identifies the combined runtime and must migrate.
        return version.trim().length > 0;
    } catch {
        return false;
    }
}

/** Restore Vesktop's Force Update behavior without involving DockView files. */
export async function downloadVencordFiles(): Promise<void> {
    const release = await fetchie(
        `${API_BASE}/repos/Vendicated/Vencord/releases/latest`,
        {
            headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": USER_AGENT
            }
        },
        { retryOnNetworkError: true }
    );
    const { assets } = (await release.json()) as ReleaseData;

    await mkdir(VENCORD_FILES_DIR, { recursive: true });
    await Promise.all(
        assets
            .filter(({ name }) => VENCORD_CORE_FILES.some(file => name.startsWith(file)))
            .map(({ name, browser_download_url }) =>
                downloadFile(browser_download_url, join(VENCORD_FILES_DIR, name), {}, { retryOnNetworkError: true })
            )
    );
    await writeFile(join(VENCORD_FILES_DIR, "package.json"), "{}\n");
}

export async function ensureVencordFiles(): Promise<void> {
    await assertBundledDistribution();
    const legacy = await isLegacyCombinedInstall();
    if (legacy || !isValidVencordInstall(VENCORD_FILES_DIR)) {
        await copyBundledDistribution(legacy);
    }
}
