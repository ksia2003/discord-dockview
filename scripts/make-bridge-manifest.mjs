/*
 * DockView build helper — LEGACY-FORMAT "bridge" manifest (one-time rescue)
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Older DockView clients (plugin 0.1.21 and earlier) shipped an updater that
 * watched a SEPARATE release stream, tags prefixed "plugin-v", now RETIRED
 * (deleted 2026-07-01). Their "Check for updates" therefore finds nothing and can
 * never move forward on its own. This script builds a ONE-TIME "bridge" release
 * that rescues them:
 *
 *   - It produces a LEGACY-FORMAT manifest.json (byte-for-byte the same schema the
 *     old make-plugin-manifest.mjs emitted: { schema, pluginVersion, vencordRef,
 *     needsRelaunch, files: { <name>: { sha256, url } } }).
 *   - Every file entry's `url` is ABSOLUTE, pointing at the assets of a NEW,
 *     modern release (e.g. v0.1.25) — the same bundles the current in-app updater
 *     ships. The legacy applyUpdate resolves absolute urls as-is (resolveUrl uses
 *     `new URL(url, base)`, which ignores the base for an absolute url), so the old
 *     client downloads the MODERN code, sha256-verifies it, and commits atomically.
 *   - needsRelaunch is forced TRUE: main/preload have changed many times since
 *     0.1.21, so the client must relaunch, not just reload, to run the new main.
 *
 * You then publish this manifest as the SOLE asset on a release tagged
 * "plugin-v<target>" (e.g. plugin-v0.1.25). The legacy picker compares tags by
 * NUMERIC dotted segments (parseInt per segment), sees plugin-v0.1.25 > their
 * 0.1.21, fetches THIS manifest, and applies it. Their client lands on modern code
 * that watches the current "v*" channel — after this single hop the bridge is done.
 *
 * NEW clients are UNAFFECTED: the current discovery only accepts tags STARTING WITH
 * "v" (a "plugin-v..." tag starts with "p"), so it never sees the bridge release.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It is NOT wired into release.yml — the bridge is a deliberate, one-time manual
 * step, not part of every release. It does not create the release or upload the
 * manifest; it only writes the manifest file. See USAGE for the publish command.
 *
 * USAGE
 * ---------------------------------------------------------------------------
 *   node scripts/make-bridge-manifest.mjs <targetTag> [outPath]
 *
 *   <targetTag>   the MODERN release whose assets the bridge points at, e.g. v0.1.25.
 *                 Its plugin bundle (the four vencordDesktop* files + version.txt +
 *                 every chunk-*.js) must already be uploaded to that release.
 *   [outPath]     where to write the manifest (default: ./bridge-manifest.json).
 *
 * Env:
 *   DOCKVIEW_REPO   owner/repo (default: ksia2003/discord-dockview).
 *   GH_TOKEN        optional; raises the GitHub API rate limit for the asset list.
 *
 * Then publish it as the ONLY asset on a plugin-v* release (example for v0.1.25):
 *
 *   node scripts/make-bridge-manifest.mjs v0.1.25
 *   gh release create plugin-v0.1.25 \
 *     --title "DockView 0.1.25 (bridge for 0.1.21 clients)" \
 *     --notes "One-time update bridge that moves pre-0.1.22 clients onto the current release channel. New clients ignore this release." \
 *     bridge-manifest.json#manifest.json
 *
 * (The `#manifest.json` renames the uploaded asset to manifest.json, the name the
 * legacy updater looks for. If your gh version doesn't support the rename syntax,
 * rename the file to manifest.json before uploading.)
 */

import { createHash } from "crypto";
import { writeFileSync } from "fs";

// The legacy client fetches EXACTLY these names out of its manifest (the four
// desktop bundle files + version.txt). The legacy applyUpdate iterated the manifest
// GENERICALLY, so any extra names (chunk-*.js) are downloaded too — we add every
// chunk asset present on the target release below, so a chunked viewer isn't left
// without its chunk after the hop.
const CORE_FILES = [
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css",
    "version.txt"
];

const VERSION_FILE = "version.txt";

const repo = process.env.DOCKVIEW_REPO || "ksia2003/discord-dockview";
const targetTag = process.argv[2];
const outPath = process.argv[3] || "bridge-manifest.json";

if (!targetTag) {
    console.error("Usage: node scripts/make-bridge-manifest.mjs <targetTag> [outPath]");
    console.error("  e.g. node scripts/make-bridge-manifest.mjs v0.1.25");
    process.exit(1);
}

const ghHeaders = { Accept: "application/vnd.github+json", "User-Agent": "dockview-make-bridge" };
if (process.env.GH_TOKEN) ghHeaders.Authorization = `Bearer ${process.env.GH_TOKEN}`;

/** Lower-cased hex sha256 of a byte buffer — the same digest the legacy applyUpdate
 *  computes over each downloaded file and checks against the manifest. */
function sha256Hex(bytes) {
    return createHash("sha256").update(bytes).digest("hex").toLowerCase();
}

/** Fetch a URL and throw a clear error on a non-2xx. */
async function fetchOk(url, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    return res;
}

// --- 1. Read the target release's asset list from the GitHub API. -----------
// We need each asset's browser_download_url (the ABSOLUTE url the manifest points
// at) and to discover which chunk-*.js assets the release actually carries.
const relUrl = `https://api.github.com/repos/${repo}/releases/tags/${targetTag}`;
console.log(`Reading release ${targetTag} on ${repo} …`);
const release = await (await fetchOk(relUrl, ghHeaders)).json();
const assets = Array.isArray(release?.assets) ? release.assets : [];
if (!assets.length) {
    console.error(`Release ${targetTag} has no assets — upload the plugin bundle to it first.`);
    process.exit(1);
}

// The set of files to record: the core five, plus every chunk-*.js on the release.
const chunkNames = assets
    .map(a => a?.name)
    .filter(n => typeof n === "string" && /^chunk-[A-Za-z0-9._-]+\.js$/.test(n))
    .sort();
const wantNames = [...CORE_FILES, ...chunkNames];

// Map name -> browser_download_url (absolute), so each file entry's url is absolute.
const urlByName = new Map();
for (const a of assets) {
    if (a?.name && typeof a.browser_download_url === "string") urlByName.set(a.name, a.browser_download_url);
}

const missing = wantNames.filter(n => !urlByName.has(n));
if (missing.length) {
    console.error(`Release ${targetTag} is missing expected plugin assets: ${missing.join(", ")}`);
    console.error("The target release must carry the full plugin bundle before the bridge can point at it.");
    process.exit(1);
}

// --- 2. Download each asset, sha256 it. -------------------------------------
// The legacy client verifies every file against these digests, so they must be the
// digests of the ACTUAL bytes served at each absolute url.
const files = {};
let vencordRef = null;
for (const name of wantNames) {
    const url = urlByName.get(name);
    process.stdout.write(`  ${name} … `);
    const bytes = new Uint8Array(await (await fetchOk(url)).arrayBuffer());
    const sha256 = sha256Hex(bytes);
    files[name] = { sha256, url };
    console.log(sha256);

    // Pull the Vencord ref out of the target's version.txt for the manifest's
    // vencordRef field (informational; the legacy client doesn't gate on it).
    if (name === VERSION_FILE) {
        const text = Buffer.from(bytes).toString("utf-8").trim();
        const m = text.match(/^dockview:\S+\s+(\S+)\s+\S+$/) || text.match(/^(\S+)\+dockview-\S+$/);
        vencordRef = m ? m[1] : (/\s/.test(text) ? null : text);
    }
}

// --- 3. Derive the plugin version from the target tag. ----------------------
// pluginVersion is the modern version the client ends up on (e.g. "0.1.25"). The
// legacy client stores/compares its own version off version.txt, not this field,
// but we set it faithfully so the manifest reads correctly.
const pluginVersion = targetTag.replace(/^v/, "");

// --- 4. Emit the LEGACY-format manifest. ------------------------------------
// Field names + order match the legacy make-plugin-manifest.mjs output exactly:
// schema, pluginVersion, vencordRef, needsRelaunch, files. needsRelaunch is forced
// true — main/preload changed since 0.1.21, so the client must relaunch to run the
// new main process, not merely reload the renderer.
const manifest = {
    schema: 1,
    pluginVersion,
    vencordRef,
    needsRelaunch: true,
    files
};

writeFileSync(outPath, JSON.stringify(manifest, null, 4) + "\n");

console.log(`\n✔ Wrote ${outPath}`);
console.log(`  pluginVersion: ${manifest.pluginVersion}`);
console.log(`  vencordRef:    ${manifest.vencordRef ?? "(unknown)"}`);
console.log(`  needsRelaunch: ${manifest.needsRelaunch}`);
console.log(`  files:         ${wantNames.length} (${CORE_FILES.length} core + ${chunkNames.length} chunk)`);
console.log("\nNext: publish it as the sole asset (named manifest.json) on a plugin-v* release:");
console.log(`  gh release create plugin-${targetTag} \\`);
console.log(`    --title "DockView ${pluginVersion} (bridge for 0.1.21 clients)" \\`);
console.log("    --notes \"One-time update bridge onto the current release channel.\" \\");
console.log(`    ${outPath}#manifest.json`);
