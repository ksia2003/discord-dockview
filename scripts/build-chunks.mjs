/*
 * DockView build helper — emit the out-of-bundle CHUNK files.
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Builds each code-dense heavy lib (see plugin/engine/chunkRegistry.ts) as a
 * STANDALONE minified IIFE `chunk-<id>.js` whose bytes are NOT in the renderer
 * bundle. Each chunk's IIFE assigns its exports to globalThis.__dockviewChunk_<id>
 * (the exact global engine/lazyLib.ts reads back after eval'ing the chunk). The
 * renderer build externalizes the same packages, so this is the home for their
 * bytes — moving their V8 compile cost off Vesktop startup.
 *
 * This is a SEPARATE esbuild pass (not Vencord's renderer build) so it can bundle
 * the lib normally while the renderer treats it as external. Run it from a Vencord
 * checkout that has the chunk packages installed (the deps the viewers' import()s
 * already pull in), pointing at that checkout's node_modules + dist.
 *
 * Usage:
 *   node scripts/build-chunks.mjs <vencordDir>
 *     <vencordDir>  a Vencord checkout with the chunk pkgs installed and a dist/.
 *                   esbuild is resolved from there; chunks are written to <dir>/dist.
 *
 * Both build paths call this:
 *   - dev:     after `pnpm build` in ~/vencord-build (see deploy loop).
 *   - release: prepare-vencord.mjs invokes it on the temp clone before copying out.
 */

import { createRequire } from "module";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { readChunks } from "./chunkList.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Node builtins that a chunk lib references ONLY in dead/debug paths but that esbuild
// must still resolve to bundle for the browser. ag-psd reaches for `util.inspect` in
// debug console.logs; alias it to a no-op browser stub so the chunk builds clean
// (the inspect() calls never run). Kept narrow — only the builtins we have proven a
// chunk lib references in unreachable code, never a blanket node polyfill.
const BUILTIN_BROWSER_STUBS = {
    util: join(__dirname, "utils", "util-browser-stub.mjs")
};

const vencordDir = process.argv[2];
if (!vencordDir) {
    console.error("usage: node scripts/build-chunks.mjs <vencordDir>");
    process.exit(1);
}

// The DockView plugin is mirrored into the Vencord clone here. A chunk's curated
// entryFile (e.g. "engine/chunks/three.entry.ts") is resolved against this dir so
// it bundles from inside the clone (where the chunk packages are installed).
// DOCKVIEW_PLUGIN_DIR overrides for non-standard layouts.
const pluginDir = process.env.DOCKVIEW_PLUGIN_DIR || join(vencordDir, "src", "userplugins", "dockView");

// Resolve esbuild from the Vencord checkout (it is a dep there), not from this
// repo — this repo ships no node_modules.
const requireFromVencord = createRequire(join(vencordDir, "package.json"));
const esbuild = requireFromVencord("esbuild");

const distDir = join(vencordDir, "dist");
mkdirSync(distDir, { recursive: true });

const chunks = readChunks();
console.log(`Building ${chunks.length} chunk file(s) into ${distDir}:`);

for (const c of chunks) {
    const globalName = `__dockviewChunk_${c.chunkId}`;
    const outfile = join(distDir, `chunk-${c.chunkId}.js`);

    // Pick the chunk's entry point:
    //   curated  → the entryFile (a real .ts in the plugin) that gathers a package
    //              plus its subpaths/loaders into one deduped chunk.
    //   bare pkg → a generated one-liner re-exporting the package in the shape
    //              lazyLib expects: "default" → `export { default } from "pkg"`,
    //              "star" → `export * from "pkg"`.
    let entryPoint;
    let tmpEntry = null;
    if (c.entryFile) {
        entryPoint = join(pluginDir, c.entryFile);
        if (!existsSync(entryPoint)) throw new Error(`Chunk entryFile not found: ${entryPoint}`);
    } else {
        const entry =
            c.exportMode === "default"
                ? `export { default } from ${JSON.stringify(c.pkg)};`
                : `export * from ${JSON.stringify(c.pkg)};`;
        tmpEntry = join(distDir, `.chunk-entry-${c.chunkId}.js`);
        writeFileSync(tmpEntry, entry);
        entryPoint = tmpEntry;
    }
    try {
        const res = await esbuild.build({
            entryPoints: [entryPoint],
            bundle: true,
            format: "iife",
            globalName,
            outfile,
            minify: true,
            target: ["esnext"],
            platform: "browser",
            // A chunk lib may ship a wasm file it loads at runtime (e.g. @jsquash/jxl's
            // jxl_dec.wasm). The renderer can't fetch it (Discord CSP blocks a wasm
            // fetch), so the chunk entry imports the .wasm as raw BYTES and the viewer
            // compiles a WebAssembly.Module from them to hand the codec via its
            // instantiateWasm hook. The "binary" loader folds the wasm into the chunk as
            // a typed-array literal (pure data) instead of emitting it as a separate
            // asset — no extra file to ship, no runtime fetch. Harmless for chunks that
            // import no wasm.
            loader: { ".wasm": "binary" },
            // Alias node builtins a chunk lib references only in dead/debug code to a
            // harmless browser stub (see BUILTIN_BROWSER_STUBS) so the browser bundle
            // resolves them — ag-psd's debug `util.inspect`.
            alias: { ...BUILTIN_BROWSER_STUBS },
            // Same React handling as the renderer: a chunk lib must NOT bundle its
            // own React copy. None of the current chunk libs import React, but keep
            // them external to be safe (matches the renderer's @webpack/common world).
            external: ["react", "react-dom"],
            legalComments: "none",
            logLevel: "warning",
            write: true
        });
        if (res.errors?.length) {
            throw new Error(res.errors.map(e => e.text).join("; "));
        }
    } finally {
        if (tmpEntry) rmSync(tmpEntry, { force: true });
    }
    console.log(`  ✔ chunk-${c.chunkId}.js  (${c.entryFile ? `entry ${c.entryFile}` : `pkg ${c.pkg}`}, global ${globalName})`);
}

console.log("Chunk build complete.");
