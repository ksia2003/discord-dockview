/*
 * Chunk entry for @jspawn/ghostscript-wasm — see engine/chunkRegistry.ts (exportMode "star").
 * ---------------------------------------------------------------------------
 * The PostScript viewer converts EPS / non-PDF Illustrator (.ai) to PDF with
 * Ghostscript compiled to WASM (@jspawn/ghostscript-wasm — GPL Ghostscript 9.56.0).
 *
 * Why a CHUNK (not inline):
 *   1. The wasm is ~16 MB. Keeping the whole interpreter out of vencordDesktopRenderer.js
 *      keeps the base renderer lean (the bytes load on first .eps / non-PDF .ai open over
 *      the chunk IPC, behind the "Converting PostScript…" dock state — like the other
 *      chunks). Being a chunk it costs ~0 ms at startup (data, not pre-parsed code) and
 *      only ever ships when a PostScript file is actually opened.
 *   2. The codec's Emscripten glue default-fetches its wasm via
 *      `fetch(new URL("gs.wasm", import.meta.url))`, which Discord's CSP connect-src would
 *      BLOCK in the renderer. So we hand the interpreter the wasm bytes ourselves through
 *      Emscripten's `instantiateWasm` Module hook (see ghostscript.ts), bypassing the fetch
 *      — exactly the CSP-safe pattern @jsquash/jxl uses. To do that the renderer needs the
 *      raw wasm bytes, so this chunk carries them as a binary import (esbuild `.wasm` →
 *      "binary" loader, see scripts/build-chunks.mjs), exported as `wasm`.
 *
 * We import the CommonJS `gs.js` Emscripten factory DIRECTLY (not the package's gs.mjs
 * ESM wrapper). The gs.mjs wrapper has a Node-vs-browser fork that, on the browser path,
 * reads the factory back off `globalThis.exports.Module` — a UMD/globalThis dance that
 * does not survive esbuild's CommonJS interop (the bundled `exports` is a local binding,
 * so `globalThis.exports.Module` stays undefined → "createModule is not defined"). gs.js's
 * own UMD tail is `module.exports = Module`, which esbuild maps straight to the module's
 * default export — so importing gs.js directly hands back the factory cleanly, with no
 * globalThis indirection. The factory's glue still references `require("fs"/"path"/"crypto")`
 * + `__dirname` in Emscripten's dead Node paths; the chunk build aliases those bare node
 * builtins to a harmless browser stub (the same util-browser-stub technique build-chunks.mjs
 * already uses for ag-psd) so the browser bundle resolves them — they never run on the
 * browser code path (proven: a clean --platform=browser esbuild + a live EPS→PDF conversion).
 *
 * exportMode "star": the chunk's namespace object is handed back, and the viewer reads
 *   const { createModule, wasm } = await loadLib("ghostscript", …)
 * compiling a WebAssembly.Module from `wasm`, then createModule({ instantiateWasm,
 * noInitialRun, … }) → FS.writeFile(input) → callMain(gs args) → FS.readFile("out.pdf").
 */

// The Ghostscript Emscripten module factory — gs.js's CommonJS `module.exports = Module`,
// imported directly (see header for why we bypass the package's gs.mjs ESM wrapper).
export { default as createModule } from "@jspawn/ghostscript-wasm/gs.js";

// The interpreter's wasm bytes, inlined by esbuild's binary loader (Uint8Array). The
// renderer compiles a WebAssembly.Module from this and hands it to createModule()'s
// instantiateWasm hook so Ghostscript never fetches its wasm (CSP-safe).
// @ts-expect-error — resolved by esbuild's ".wasm" binary loader at chunk-build time.
export { default as wasm } from "@jspawn/ghostscript-wasm/gs.wasm";
