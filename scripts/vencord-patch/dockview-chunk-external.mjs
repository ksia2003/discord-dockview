/*
 * DockView — Vencord renderer externalize plugin (injected into a Vencord clone).
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Marks the DockView chunked heavy libs (mermaid, …) as `external` in Vencord's
 * renderer (IIFE) bundle so their bytes leave vencordDesktopRenderer.js — that is
 * the byte-removal that drops their V8 compile cost off Vesktop startup. The libs
 * are rebuilt as standalone chunk-<id>.js files by scripts/build-chunks.mjs and
 * loaded on first use over the readChunk IPC + eval (engine/lazyLib.ts).
 *
 * The package list comes from the env var DOCKVIEW_CHUNK_EXTERNALS (comma-sep) so
 * this plugin carries no coupling to the chunk registry; the build glue derives the
 * list from plugin/engine/chunkRegistry.ts and passes it in. The leftover
 * `import("pkg")` esbuild emits for an external dynamic import is DEAD CODE: the
 * renderer never reaches it, because engine/lazyLib.ts routes a chunked key to the
 * chunk path before its viewer's importer is ever called.
 *
 * This file is COPIED into a Vencord clone's scripts/build/ and appended to
 * commonRendererPlugins by the DockView build glue (scripts/build-chunks helpers /
 * prepare-vencord.mjs). It must therefore depend on nothing but esbuild's plugin
 * contract.
 */

const raw = (process.env.DOCKVIEW_CHUNK_EXTERNALS || "").trim();
const externals = raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : [];

// Match a chunked package OR a subpath import of it ("three/examples/...").
function isChunkExternal(spec) {
    for (const pkg of externals) {
        if (spec === pkg || spec.startsWith(pkg + "/")) return true;
    }
    return false;
}

/** @type {import("esbuild").Plugin} */
export const dockviewChunkExternalPlugin = {
    name: "dockview-chunk-external",
    setup(build) {
        if (externals.length === 0) return;
        // Bare specifiers only (not "./" or absolute) — same guard esbuild's own
        // external matching uses; our chunk pkgs are always bare npm specifiers.
        const filter = /^[^./]/;
        build.onResolve({ filter }, args => {
            if (isChunkExternal(args.path)) {
                return { path: args.path, external: true };
            }
            return null;
        });
    }
};
