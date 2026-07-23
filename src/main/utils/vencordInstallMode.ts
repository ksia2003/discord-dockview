/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFile } from "fs/promises";
import { join } from "path";

const STANDALONE_BANNER = /^\/\/ Standalone: true$/im;

export async function isStandaloneVencordInstall(dir: string): Promise<boolean> {
    const source = await readFile(join(dir, "vencordDesktopMain.js"), "utf8");
    return STANDALONE_BANNER.test(source.slice(0, 512));
}

interface ManagedInstallState {
    customDir: boolean;
    legacyCombined: boolean;
    valid: boolean;
    standalone: boolean;
}

/**
 * The app owns only its default Vencord directory. A valid non-standalone
 * runtime left there by DockView 0.1.43 has no Git repository and must migrate
 * to the bundled standalone build. A user-selected directory may be an actual
 * Git checkout, so a valid custom runtime is always preserved.
 */
export function shouldInstallBundledVencord(state: ManagedInstallState): boolean {
    if (state.legacyCombined || !state.valid) return true;
    return !state.customDir && !state.standalone;
}
