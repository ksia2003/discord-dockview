/*
 * DockView build helper — patch a Vencord clone to externalize chunked libs.
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Wires scripts/vencord-patch/dockview-chunk-external.mjs into a Vencord checkout's
 * renderer build so the chunked heavy libs (plugin/engine/chunkRegistry.ts) leave
 * vencordDesktopRenderer.js. It:
 *   1. copies the plugin into <vencordDir>/scripts/build/
 *   2. appends `import { dockviewChunkExternalPlugin } ...` + a push into
 *      commonRendererPlugins in <vencordDir>/scripts/build/common.mjs (idempotent)
 *
 * The package list is passed to the build at RUN time via the DOCKVIEW_CHUNK_EXTERNALS
 * env var (the plugin reads it), so this patch is independent of which libs are chunked.
 *
 * Both build paths apply this:
 *   - dev:     once against ~/vencord-build (the patch is idempotent on re-run).
 *   - release: prepare-vencord.mjs applies it on the fresh temp clone.
 *
 * Usage:
 *   node scripts/patch-vencord-build.mjs <vencordDir>
 */

import { copyFileSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PLUGIN_SRC = join(ROOT, "scripts", "vencord-patch", "dockview-chunk-external.mjs");

const vencordDir = process.argv[2];
if (!vencordDir) {
    console.error("usage: node scripts/patch-vencord-build.mjs <vencordDir>");
    process.exit(1);
}

const buildDir = join(vencordDir, "scripts", "build");
const commonPath = join(buildDir, "common.mjs");

// 1. Copy the plugin in next to common.mjs.
copyFileSync(PLUGIN_SRC, join(buildDir, "dockview-chunk-external.mjs"));

// 2. Patch common.mjs idempotently.
const MARK = "dockview-chunk-external";
let src = readFileSync(commonPath, "utf-8");

if (src.includes(MARK)) {
    console.log(`✔ ${commonPath} already patched for ${MARK}`);
    process.exit(0);
}

// (a) add the import after the existing build-utils import line.
const importLine = `import { dockviewChunkExternalPlugin } from "./dockview-chunk-external.mjs";\n`;
// Anchor on the first import from "../utils.mjs" (present in stock common.mjs).
const utilsImportRe = /import\s+\{[^}]*\}\s+from\s+"\.\.\/utils\.mjs";\n/;
if (utilsImportRe.test(src)) {
    src = src.replace(utilsImportRe, m => m + importLine);
} else {
    // Fallback: prepend after the first import line in the file.
    src = src.replace(/(^import .*\n)/m, `$1${importLine}`);
}

// (b) append the plugin to commonRendererPlugins. The stock array ends with the
//     spread `...commonOpts.plugins\n];`. Insert our plugin before that spread so
//     it runs first (its onResolve short-circuits chunk pkgs to external).
const rendererArrRe = /(export const commonRendererPlugins = \[)([\s\S]*?)(\n\];)/;
const mr = src.match(rendererArrRe);
if (!mr) {
    console.error("Could not find commonRendererPlugins array in common.mjs — Vencord build layout changed.");
    process.exit(1);
}
const patchedArr = `${mr[1]}\n    dockviewChunkExternalPlugin,${mr[2]}${mr[3]}`;
src = src.replace(rendererArrRe, patchedArr);

writeFileSync(commonPath, src);
console.log(`✔ Patched ${commonPath} to externalize DockView chunk libs`);
