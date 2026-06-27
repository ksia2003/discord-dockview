/*
 * DockView build helper — plugin-only OTA update manifest
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Generates static/vencordDist/manifest.json: the manifest the in-app updater
 * (plugin/native.ts applyUpdate) fetches to learn what a plugin-only patch
 * release contains. It is the producer side of the OTA stream — the consumer is
 * the renderer settings panel + plugin/native.ts.
 *
 * For each of the five shipped artifacts (the four desktop bundle files plus
 * version.txt) it records a sha256 (so the updater can verify each download) and
 * a download url under the GitHub release the .github/workflows/plugin-release.yml
 * workflow uploads them to.
 *
 * The manifest is a BUILD ARTIFACT: it is regenerated from static/vencordDist/ on
 * every plugin release and is NOT committed to the repo.
 *
 * Usage:
 *   node scripts/make-plugin-manifest.mjs
 *
 * Env overrides:
 *   DOCKVIEW_RELEASE_BASE   GitHub release download base for each file's url, e.g.
 *                           https://github.com/ksia2003/discord-dockview/releases/download/plugin-v0.1.1
 *                           (default: "" — file urls are then just the bare name)
 *   DOCKVIEW_NEEDS_RELAUNCH set to "1" when a patch changes main/preload so the
 *                           panel relaunches instead of reloading (default: false)
 */

import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const DIST = join(ROOT, "static", "vencordDist");
const PLUGIN_SRC = join(ROOT, "plugin");

// The five artifacts that go into a plugin-only patch release: the four desktop
// bundle files plus the version stamp. Every one is recorded in the manifest.
const FILES = [
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css",
    "version.txt"
];

const VERSION_FILE = "version.txt";

// plugin/version.ts is the SINGLE home of the running plugin version. This is a
// .mjs and can't import a .ts, so read the literal as text and regex it out —
// the same approach prepare-vencord.mjs uses, keeping one source of truth.
function readPluginVersion() {
    const src = readFileSync(join(PLUGIN_SRC, "version.ts"), "utf-8");
    const m = src.match(/DOCKVIEW_PLUGIN_VERSION\s*=\s*["']([^"']+)["']/);
    if (!m) throw new Error("Could not extract DOCKVIEW_PLUGIN_VERSION from plugin/version.ts");
    return m[1];
}

// Pull the Vencord ref out of version.txt. The build writes the new shape
// "dockview:<plugin> <vencordRef> <gitHash>"; tolerate the legacy/bare shapes
// (e.g. "1.14.13") by falling back to null when no ref can be read.
function readVencordRef() {
    const p = join(DIST, VERSION_FILE);
    if (!existsSync(p)) return null;
    const text = readFileSync(p, "utf-8").trim();
    if (!text) return null;

    // (a) new: "dockview:<plugin> <vencordRef> <gitHash>"
    const newMatch = text.match(/^dockview:\S+\s+(\S+)\s+\S+$/);
    if (newMatch) return newMatch[1];

    // (b) legacy script: "<vencordRef>+dockview-<gitHash>"
    const legacyMatch = text.match(/^(\S+)\+dockview-\S+$/);
    if (legacyMatch) return legacyMatch[1];

    // (c) bare legacy: "<vencordRef>" (a single token, no spaces)
    if (!/\s/.test(text)) return text;

    return null;
}

// Lower-cased hex sha256 of a file's bytes.
function sha256Hex(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex").toLowerCase();
}

const baseDownloadUrl = process.env.DOCKVIEW_RELEASE_BASE || "";
const needsRelaunch = process.env.DOCKVIEW_NEEDS_RELAUNCH === "1";

// Fail loudly (non-zero exit) on a missing artifact — a partial manifest would
// hand the updater a download it can never satisfy.
const missing = FILES.filter(f => !existsSync(join(DIST, f)));
if (missing.length) {
    console.error(`Missing artifacts in ${DIST}: ${missing.join(", ")}`);
    console.error("Run `node scripts/prepare-vencord.mjs` first to build static/vencordDist.");
    process.exit(1);
}

const files = {};
for (const name of FILES) {
    const path = join(DIST, name);
    files[name] = {
        sha256: sha256Hex(path),
        url: baseDownloadUrl ? `${baseDownloadUrl}/${name}` : name
    };
}

const manifest = {
    schema: 1,
    pluginVersion: readPluginVersion(),
    vencordRef: readVencordRef(),
    needsRelaunch,
    files
};

const outPath = join(DIST, "manifest.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 4) + "\n");

console.log(`✔ Wrote ${outPath}`);
console.log(`  pluginVersion: ${manifest.pluginVersion}`);
console.log(`  vencordRef:    ${manifest.vencordRef ?? "(unknown)"}`);
console.log(`  needsRelaunch: ${manifest.needsRelaunch}`);
console.log(`  baseDownloadUrl: ${baseDownloadUrl || "(none)"}`);
for (const name of FILES) {
    console.log(`  - ${name}  ${files[name].sha256}`);
}
