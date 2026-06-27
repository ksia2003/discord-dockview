/*
 * DockView build helper — channel-2 (drop-in) bundle
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Builds the "drop-in" release asset for users who already run Vesktop and
 * don't want the whole fork installer. It zips the four desktop dist files
 * (the exact same artifacts the fork installer ships, from prepare-vencord.mjs)
 * together with the install scripts + README into
 *   dist-bundle/DockView-Vencord-<version>.zip
 *
 * The user unzips it and runs install-dockview.sh / install-dockview.ps1, which
 * copies the four files into their Vesktop sessionData/vencordFilesCustom/ dir.
 *
 * Requirements:
 *   - The system `zip` command (Info-ZIP). We deliberately avoid pulling in a
 *     heavy archiver dep just for this one step.
 *   - static/vencordDist/ must already be populated (run prepareVencord first).
 *
 * Usage:
 *   node scripts/package-bundle.mjs
 */

import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const DIST = join(ROOT, "static", "vencordDist");
const SCRIPTS = __dirname;
const OUT_DIR = join(ROOT, "dist-bundle");

// The four desktop files both delivery channels share.
const DESKTOP_FILES = [
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css"
];

// Helper files that go in the zip next to the four desktop files.
const HELPER_FILES = [
    { from: join(SCRIPTS, "install-dockview.sh"), name: "install-dockview.sh" },
    { from: join(SCRIPTS, "install-dockview.ps1"), name: "install-dockview.ps1" },
    { from: join(SCRIPTS, "BUNDLE-README.md"), name: "README.md" }
];

// Work out the version label for the zip name. Prefer the version.txt the
// Vencord build wrote (e.g. "v1.14.13+dockview-abc1234"); fall back to the
// app package.json version.
function resolveVersion() {
    const versionTxt = join(DIST, "version.txt");
    if (existsSync(versionTxt)) {
        const v = readFileSync(versionTxt, "utf-8").trim();
        if (v) return v;
    }
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    return pkg.version;
}

function ensureDesktopFiles() {
    const missing = DESKTOP_FILES.filter(f => !existsSync(join(DIST, f)));
    if (missing.length) {
        throw new Error(
            `Missing desktop files in ${DIST}: ${missing.join(", ")}.\n` +
            "Run `pnpm prepareVencord` first to build the Vencord dist."
        );
    }
}

const version = resolveVersion();
// Sanitise the version for a filename (the "+" and friends are fine on every
// OS we target, but keep it tidy).
const safeVersion = version.replace(/[^\w.+-]/g, "_");
const stageName = `DockView-Vencord-${safeVersion}`;
const stageDir = join(OUT_DIR, stageName);
const zipPath = join(OUT_DIR, `${stageName}.zip`);

ensureDesktopFiles();

// Stage the payload in a clean folder, then zip that folder's *contents*
// (`zip -j` flattens, but we want the version.txt too and a predictable set).
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const f of DESKTOP_FILES) copyFileSync(join(DIST, f), join(stageDir, f));

// version.txt is handy for the user / install script to confirm what they got.
const versionTxt = join(DIST, "version.txt");
if (existsSync(versionTxt)) copyFileSync(versionTxt, join(stageDir, "version.txt"));

for (const h of HELPER_FILES) {
    if (!existsSync(h.from)) throw new Error(`Missing helper file: ${h.from}`);
    copyFileSync(h.from, join(stageDir, h.name));
}

// Build the zip with a flat layout (`-j` = junk paths) so the user gets the
// files directly, not nested under a folder.
rmSync(zipPath, { recursive: true, force: true });
const entries = [
    ...DESKTOP_FILES,
    ...(existsSync(versionTxt) ? ["version.txt"] : []),
    ...HELPER_FILES.map(h => h.name)
];
console.log(`Zipping ${entries.length} files -> ${zipPath}`);
execFileSync("zip", ["-j", "-X", zipPath, ...entries.map(e => join(stageDir, e))], {
    stdio: "inherit"
});

console.log(`✔ Bundle ready: ${zipPath}`);
console.log(`  version: ${version}`);
console.log(`  contents: ${entries.join(", ")}`);
