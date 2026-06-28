/*
 * DockView build helper — read the out-of-bundle CHUNK registry from the plugin.
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The single source of truth for which heavy libs ship as separate chunk-<id>.js
 * files is plugin/engine/chunkRegistry.ts (the runtime imports it). A .mjs build
 * script can't import a .ts, so this module parses the CHUNKS array out of that
 * file's source text — the same regex-over-source trick prepare-vencord.mjs and
 * make-plugin-manifest.mjs use for plugin/version.ts. Keeping ONE registry means
 * the runtime chunk branch, the renderer externals, the chunk-emit pass, and the
 * OTA manifest can never list different libs.
 *
 * chunkRegistry.ts keeps every CHUNKS entry on one line in a fixed object shape
 * (`{ key: "..", pkg: "..", chunkId: "..", exportMode: ".." },`) precisely so this
 * parser stays trivial and robust.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
// chunkRegistry.ts location. In the repo it's plugin/engine/; the dev loop runs
// this script against a Vencord checkout where the plugin is mirrored elsewhere,
// so DOCKVIEW_CHUNK_REGISTRY can point at that copy.
const REGISTRY = process.env.DOCKVIEW_CHUNK_REGISTRY || join(ROOT, "plugin", "engine", "chunkRegistry.ts");

/**
 * Parse plugin/engine/chunkRegistry.ts and return the chunk specs:
 *   [{ key, pkg, chunkId, exportMode }, ...]
 * Throws if the file or the CHUNKS array can't be read — a silent empty list
 * would ship an un-chunked (heavy) renderer with no error.
 */
export function readChunks() {
    const src = readFileSync(REGISTRY, "utf-8");
    const arrMatch = src.match(/export\s+const\s+CHUNKS\s*:\s*ChunkSpec\[\]\s*=\s*\[([\s\S]*?)\n\];/);
    if (!arrMatch) throw new Error(`Could not find CHUNKS array in ${REGISTRY}`);
    const body = arrMatch[1];

    // Each entry is one `{ … },` object on its own line. Pull each object literal,
    // then read fields by name so OPTIONAL fields (entryFile, extraExternals) don't
    // break parsing and field order is irrelevant.
    const chunks = [];
    const objRe = /\{([^{}]*)\}/g;
    let m;
    while ((m = objRe.exec(body)) !== null) {
        const obj = m[1];
        const str = field => {
            const mm = obj.match(new RegExp(`${field}\\s*:\\s*"([^"]+)"`));
            return mm ? mm[1] : null;
        };
        const arr = field => {
            const mm = obj.match(new RegExp(`${field}\\s*:\\s*\\[([^\\]]*)\\]`));
            if (!mm) return [];
            return [...mm[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
        };
        const key = str("key"), pkg = str("pkg"), chunkId = str("chunkId"), exportMode = str("exportMode");
        if (!key || !pkg || !chunkId || !exportMode) continue;
        chunks.push({ key, pkg, chunkId, exportMode, entryFile: str("entryFile"), extraExternals: arr("extraExternals") });
    }
    if (chunks.length === 0) {
        throw new Error(`CHUNKS array in ${REGISTRY} parsed to zero entries — registry shape changed?`);
    }
    return chunks;
}

/** The set of npm packages the renderer must externalize (their bytes go to a
 *  chunk file instead of inline). Includes each chunk's primary pkg plus any
 *  extraExternals a curated entry pulls in at a separate top level. */
export function chunkExternalPackages() {
    const set = new Set();
    for (const c of readChunks()) {
        set.add(c.pkg);
        for (const e of c.extraExternals || []) set.add(e);
    }
    return [...set];
}

/** The chunk file names (`chunk-<id>.js`) the build emits + the OTA ships. */
export function chunkFileNames() {
    return readChunks().map(c => `chunk-${c.chunkId}.js`);
}
