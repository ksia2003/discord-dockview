/*
 * DockView build helper — emit the gallery SAMPLES data chunk.
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Builds chunk-samples.js: the example fixtures behind the "Examples / supported
 * formats" gallery in the DockView settings tab, base64-embedded and assigned to a
 * global. It ships alongside the renderer in DockView's own runtime directory,
 * exactly like the out-of-bundle LIB chunks (chunk-mermaid.js, chunk-three.js, …),
 * and is loaded ON DEMAND over the SAME readChunk IPC (plugin/native.ts) the first
 * time the gallery is opened. It is therefore NOT inline in dockviewRenderer.js
 * — the fixtures never cost a byte at Vesktop startup.
 *
 * SHAPE — identical contract to a lib chunk so the existing wiring is reused verbatim:
 *   - the file name is `chunk-samples.js` (matches make-plugin-manifest.mjs's
 *     `^chunk-[A-Za-z0-9._-]+\.js$` glob and native.ts readChunk's guard);
 *   - it is a `"use strict"` IIFE-style file that assigns its payload to the global
 *     `__dockviewChunk_samples`, the same `__dockviewChunk_<id>` convention
 *     engine/lazyLib.ts reads back after eval (plugin/gallery/samples.ts mirrors
 *     that eval-via-`new Function` + read-the-global pattern for this data chunk).
 *
 * The payload is a flat map { "<filename>": "<base64 of the file bytes>" }. Unlike a
 * LIB chunk this is pure DATA (base64 string literals), so — like heic2any's libheif
 * — it costs ~0 ms of V8 pre-parse even were it inline; keeping it out-of-bundle is
 * still the right call (it keeps renderer.js lean and the fixtures off every startup).
 *
 * Usage:
 *   node scripts/build-sample-chunk.mjs <outDir>
 *     <outDir>  directory to write chunk-samples.js into (e.g. a Vencord checkout's
 *               dist/, or static/vencordDist for a release).
 *
 * Both build paths call this (right after build-chunks.mjs):
 *   - dev:     into ~/vencord-build/dist alongside the renderer.
 *   - release: prepare-vencord.mjs invokes it on the temp clone before copying out.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// The fixtures live in the plugin so they travel with the source. DOCKVIEW_SAMPLES_DIR
// overrides for the dev/release loops that run this against a Vencord checkout where
// the plugin is mirrored elsewhere.
const SAMPLES_DIR = process.env.DOCKVIEW_SAMPLES_DIR || join(ROOT, "plugin", "gallery", "samples");

const outDir = process.argv[2];
if (!outDir) {
    console.error("usage: node scripts/build-sample-chunk.mjs <outDir>");
    process.exit(1);
}

if (!existsSync(SAMPLES_DIR)) {
    throw new Error(`Samples dir not found: ${SAMPLES_DIR}`);
}

// Read every fixture file (skip dotfiles / subdirs) → { name: base64(bytes) }.
const names = readdirSync(SAMPLES_DIR, { withFileTypes: true })
    .filter(d => d.isFile() && !d.name.startsWith("."))
    .map(d => d.name)
    .sort();

if (names.length === 0) {
    throw new Error(`No sample fixtures in ${SAMPLES_DIR} — gallery chunk would be empty.`);
}

const payload = {};
let totalBytes = 0;
for (const name of names) {
    const bytes = readFileSync(join(SAMPLES_DIR, name));
    totalBytes += bytes.length;
    payload[name] = bytes.toString("base64");
}

mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, "chunk-samples.js");

// Match the lib-chunk runtime contract: a strict file that assigns the payload to
// the `__dockviewChunk_samples` global. samples.ts eval's this with `new Function`
// and reads the global straight back (the same approach engine/lazyLib.ts uses for
// lib chunks). JSON.stringify keeps it a pure data literal (no function bodies).
const body =
    `"use strict";\n` +
    `var __dockviewChunk_samples = ${JSON.stringify(payload)};\n`;

writeFileSync(outfile, body);

console.log(`✔ chunk-samples.js  (${names.length} fixtures, ${totalBytes} source bytes → ${body.length} chunk bytes)`);
for (const name of names) console.log(`    - ${name}`);
