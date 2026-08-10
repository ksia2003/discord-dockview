/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { lstat, readFile } from "fs/promises";
import { basename, dirname, join } from "path";

const STANDALONE_BANNER = /^\/\/ Standalone: true$/im;

export async function isStandaloneVencordInstall(dir: string): Promise<boolean> {
    const source = await readFile(join(dir, "vencordDesktopMain.js"), "utf8");
    return STANDALONE_BANNER.test(source.slice(0, 512));
}

/**
 * A custom regular Vencord build is expected to be either the checkout root or
 * its dist/ directory. Preserve it only when that checkout really has Git
 * metadata; a copied file-only non-standalone build cannot use Vencord's Git
 * updater and must be repaired to standalone just like the old managed install.
 */
export async function isGitVencordInstall(dir: string): Promise<boolean> {
    // Only the documented shapes count: the checkout root itself, or its literal
    // `dist/` output directory. Checking every arbitrary parent causes a false Git
    // install whenever a user-selected file directory merely lives inside some other
    // repository (or, as the regression fixture proved, when /tmp/.git exists).
    const roots = basename(dir) === "dist" ? [dir, dirname(dir)] : [dir];
    for (const root of roots) {
        try {
            await lstat(join(root, ".git"));
            return true;
        } catch {
            // Try the other supported checkout shape.
        }
    }
    return false;
}

interface ManagedInstallState {
    customDir: boolean;
    customGitCheckout: boolean;
    legacyCombined: boolean;
    valid: boolean;
    standalone: boolean;
}

/**
 * The app owns only its default Vencord directory. A valid non-standalone
 * runtime left there by DockView 0.1.43 has no Git repository and must migrate
 * to the bundled standalone build. A user-selected non-standalone directory is
 * preserved only when it is backed by an actual Git checkout; otherwise its
 * updater is structurally broken for the same reason and it is repaired too.
 */
export function shouldInstallBundledVencord(state: ManagedInstallState): boolean {
    if (state.legacyCombined || !state.valid) return true;
    if (state.standalone) return false;
    return !state.customDir || !state.customGitCheckout;
}
