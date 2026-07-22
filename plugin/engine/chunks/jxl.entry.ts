/*
 * Chunk entry for @jsquash/jxl — see engine/chunkRegistry.ts (exportMode "star").
 * ---------------------------------------------------------------------------
 * The raster viewer decodes JPEG-XL (.jxl) with @jsquash/jxl, a Squoosh-derived
 * Emscripten codec: a small JS glue (jxl_dec.js) + an 849 KB jxl_dec.wasm.
 *
 * Why a CHUNK (not inline):
 *   1. The wasm is 849 KB. Keeping the whole codec out of dockviewRenderer.js
 *      keeps the base renderer lean (the bytes load on first .jxl open over the chunk
 *      IPC, behind the "Loading JPEG XL decoder…" dock state — like the other chunks).
 *   2. The codec's default wasm fetch is `fetch(new URL("jxl_dec.wasm", import.meta.url))`,
 *      which Discord's CSP connect-src would BLOCK in the renderer. So we must hand the
 *      codec the wasm bytes ourselves. @jsquash/jxl's init() takes a WebAssembly.Module
 *      as its first argument and wires it through Emscripten's instantiateWasm hook
 *      (utils.js initEmscriptenModule), bypassing any fetch. To do that the renderer
 *      needs the raw wasm bytes — so this chunk carries them as a binary import (esbuild
 *      `.wasm` → "binary" loader, see scripts/build-chunks.mjs), exported as `wasm`.
 *
 * The codec's own `new URL("jxl_dec.wasm", import.meta.url)` default-fetch path becomes
 * dead code once init() is given a Module (instantiateWasm short-circuits it); esbuild's
 * binary loader folds that referenced wasm into the chunk as a typed array literal (data,
 * ~0 ms V8 pre-parse) rather than emitting a separate asset file.
 *
 * exportMode "star": the chunk's namespace object is handed back, and the viewer reads
 *   const { init, decode, wasm } = await loadLib("jxl", …)
 * compiling a WebAssembly.Module from `wasm`, init(module)-ing the codec once, then
 * decode(buffer) → ImageData.
 */

// The decode glue (init + default decode) from @jsquash/jxl.
export { init, default as decode } from "@jsquash/jxl/decode";

// The codec's wasm bytes, inlined by esbuild's binary loader (Uint8Array). The renderer
// compiles a WebAssembly.Module from this and passes it to init() so the codec never
// fetches (CSP-safe).
// @ts-expect-error — resolved by esbuild's ".wasm" binary loader at chunk-build time.
export { default as wasm } from "@jsquash/jxl/codec/dec/jxl_dec.wasm";
