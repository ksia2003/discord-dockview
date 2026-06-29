/*
 * Browser stub for node core modules referenced only in DEAD code, used ONLY by the
 * chunk build (build-chunks.mjs).
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * @jspawn/ghostscript-wasm is a dual-target Emscripten build: its gs.mjs has a
 * `if (globalThis.process) import("path"/"module")` Node branch, and its gs.js glue
 * references `require("fs"/"path"/"crypto")` + `__dirname` inside Emscripten's Node-only
 * code paths. On the BROWSER code path none of that runs (proven: a clean
 * --platform=browser esbuild + a live EPS→PDF conversion in the renderer). But esbuild
 * must still RESOLVE those bare `fs`/`path`/`module`/`crypto` specifiers to bundle the
 * chunk for the browser; node core has no browser resolution, so the chunk build aliases
 * them to this harmless no-op stub — the same util-browser-stub technique used for
 * ag-psd's debug `util.inspect`, kept narrow to the builtins a chunk lib references in
 * unreachable code (never a blanket node polyfill).
 *
 * Every commonly-touched member is a no-op so an (unreached) call degrades harmlessly
 * rather than throwing on a missing property.
 */

export function createRequire() {
    return function () {
        return {};
    };
}
export function dirname() {
    return "";
}
export function join() {
    return "";
}
export function readFileSync() {
    return new Uint8Array();
}
export function existsSync() {
    return false;
}
export function randomBytes(n) {
    return new Uint8Array(typeof n === "number" ? n : 0);
}

export default {
    createRequire,
    dirname,
    join,
    readFileSync,
    existsSync,
    randomBytes
};
