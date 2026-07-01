/*
 * DockView build helper — plugin-only OTA update manifest
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Generates static/vencordDist/manifest.json: the manifest the in-app updater
 * (plugin/native.ts applyUpdate) fetches to learn what a plugin update contains.
 * It is the producer side of the in-app update stream — the consumer is the
 * renderer settings panel + plugin/native.ts.
 *
 * For each of the five shipped artifacts (the four desktop bundle files plus
 * version.txt) it records a sha256 (so the updater can verify each download) and
 * a download url under the DockView-versioned "v*" GitHub release that .github/
 * workflows/release.yml attaches the plugin bundle to (the same release that
 * carries the app installers).
 *
 * The manifest is a BUILD ARTIFACT: it is regenerated from static/vencordDist/ on
 * every release and is NOT committed to the repo.
 *
 * Usage:
 *   node scripts/make-plugin-manifest.mjs
 *
 * Env overrides:
 *   DOCKVIEW_RELEASE_BASE   GitHub release download base for each file's url, e.g.
 *                           https://github.com/ksia2003/discord-dockview/releases/download/v0.1.24
 *                           (default: "" — file urls are then just the bare name)
 *   DOCKVIEW_NEEDS_RELAUNCH "1"/"0" to force whether the patch relaunches instead of
 *                           reloading. If UNSET, it is auto-detected by diffing this
 *                           build's main/preload sha256 against the previous v* release
 *                           that carried the plugin bundle (so a tag-push release is
 *                           correct on its own; uncertainty defaults to false).
 *   DOCKVIEW_REPO           owner/repo used for the auto-detect API + asset fetch
 *                           (default: ksia2003/discord-dockview)
 */

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const DIST = join(ROOT, "static", "vencordDist");
const PLUGIN_SRC = join(ROOT, "plugin");

// The core artifacts in a plugin-only patch release: the four desktop bundle files
// plus the version stamp. Every one is recorded in the manifest. The out-of-bundle
// CHUNK files (chunk-*.js) are ADDED below — they ship alongside the renderer (the
// code-dense libs that were taken out of vencordDesktopRenderer.js to cut Vesktop
// startup parse), and applyUpdate verifies + commits them atomically with the rest.
const CORE_FILES = [
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css",
    "version.txt"
];

// Discover the chunk files present in DIST (chunk-<lib>.js). Reading them off disk
// (rather than re-deriving from chunkRegistry.ts) keeps the manifest a faithful
// record of exactly what prepare-vencord.mjs emitted — if a chunk failed to build
// it simply won't be listed, and the build's own verify catches a missing one.
const CHUNK_FILES = existsSync(DIST)
    ? readdirSync(DIST).filter(f => /^chunk-[A-Za-z0-9._-]+\.js$/.test(f)).sort()
    : [];

const FILES = [...CORE_FILES, ...CHUNK_FILES];

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

// Numeric dotted-version compare (so 0.1.10 > 0.1.9). Returns -1/0/1; null on parse fail.
function parseVer(s) {
    if (typeof s !== "string") return null;
    const parts = s.split(".").map(Number);
    return parts.every(Number.isFinite) ? parts : null;
}
function cmpVer(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d) return d < 0 ? -1 : 1;
    }
    return 0;
}

// Whether this patch must RELAUNCH (vs reload) — true when main/preload changed, so
// the renderer never loads against a stale main process (e.g. a new IPC the renderer
// now calls). An explicit DOCKVIEW_NEEDS_RELAUNCH env wins (1/0). Otherwise auto-detect
// by diffing this build's main/preload sha256 against the manifest of the PREVIOUS v*
// release that carried the plugin bundle — that makes a plain tag-push release correct
// on its own, since the workflow only feeds the env on a manual dispatch. On any
// uncertainty (no prior release, network or parse failure) it defaults to false (the
// safe match to the old behavior) and warns, so a human can still force it via the env.
async function detectNeedsRelaunch(version, builtFiles) {
    const env = process.env.DOCKVIEW_NEEDS_RELAUNCH;
    if (env === "1") return true;
    if (env === "0") return false;

    const cur = parseVer(version);
    if (!cur) {
        console.warn(`(needsRelaunch: can't parse version "${version}"; defaulting to false)`);
        return false;
    }
    const repo = process.env.DOCKVIEW_REPO || "ksia2003/discord-dockview";
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "dockview-make-manifest" };
    if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;

    try {
        const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers });
        if (!res.ok) throw new Error(`releases API ${res.status}`);
        const releases = await res.json();
        // The plugin bundle now ships as assets on the DockView-versioned "v*"
        // releases (the same ones that carry the installers). Only a release that
        // actually HAS a manifest.json asset carried the plugin bundle — an
        // installer-only "v*" release didn't, so skip it here (its manifest.json
        // fetch would 404). Diff against the highest such release older than this one.
        const prev = releases
            .filter(r => (r?.assets ?? []).some(a => a?.name === "manifest.json"))
            .map(r => r?.tag_name)
            .filter(t => typeof t === "string" && t.startsWith("v"))
            .map(t => ({ tag: t, v: parseVer(t.slice("v".length)) }))
            .filter(x => x.v && cmpVer(x.v, cur) < 0)
            .sort((a, b) => cmpVer(b.v, a.v))[0];
        if (!prev) {
            console.warn("(needsRelaunch: no prior plugin-bundle v* release to diff; defaulting to false)");
            return false;
        }
        const manRes = await fetch(`https://github.com/${repo}/releases/download/${prev.tag}/manifest.json`, { headers });
        if (!manRes.ok) throw new Error(`prev manifest ${manRes.status}`);
        const prevMan = await manRes.json();
        const watch = ["vencordDesktopMain.js", "vencordDesktopPreload.js"];
        const changed = watch.some(f => (prevMan.files?.[f]?.sha256 ?? null) !== (builtFiles[f]?.sha256 ?? null));
        console.log(`  (needsRelaunch auto-detected vs ${prev.tag}: main/preload changed = ${changed})`);
        return changed;
    } catch (err) {
        console.warn(`(needsRelaunch auto-detect failed: ${err?.message ?? err}; defaulting to false)`);
        return false;
    }
}

const baseDownloadUrl = process.env.DOCKVIEW_RELEASE_BASE || "";

// Fail loudly (non-zero exit) on a missing artifact — a partial manifest would
// hand the updater a download it can never satisfy.
const missing = FILES.filter(f => !existsSync(join(DIST, f)));
if (missing.length) {
    console.error(`Missing artifacts in ${DIST}: ${missing.join(", ")}`);
    console.error("Run `node scripts/prepare-vencord.mjs` first to build static/vencordDist.");
    process.exit(1);
}

// Cross-check the chunk files in DIST against the registry: every chunk the plugin
// declares MUST be present, or we'd ship a renderer whose externalized lib has no
// chunk to load (a chunked viewer would fail at runtime). A registry read failure
// is non-fatal here (older releases had no chunks) but a DECLARED-but-MISSING chunk
// aborts the manifest.
try {
    const { chunkFileNames } = await import("./chunkList.mjs");
    const expected = chunkFileNames();
    const missingChunks = expected.filter(f => !CHUNK_FILES.includes(f));
    if (missingChunks.length) {
        console.error(`Registry declares chunks not built into ${DIST}: ${missingChunks.join(", ")}`);
        console.error("Run the chunk build (scripts/build-chunks.mjs) before the manifest.");
        process.exit(1);
    }
} catch (err) {
    console.warn(`(chunk registry cross-check skipped: ${err?.message ?? err})`);
}

const files = {};
for (const name of FILES) {
    const path = join(DIST, name);
    files[name] = {
        sha256: sha256Hex(path),
        url: baseDownloadUrl ? `${baseDownloadUrl}/${name}` : name
    };
}

const pluginVersion = readPluginVersion();
const needsRelaunch = await detectNeedsRelaunch(pluginVersion, files);

const manifest = {
    schema: 1,
    pluginVersion,
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
