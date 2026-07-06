/*
 * Chunk entry for @timephy/rnnoise-wasm's AudioWorklet — see engine/chunkRegistry.ts.
 * ---------------------------------------------------------------------------
 * Unlike every other chunk, this one is NOT eval'd in the renderer. It is the source
 * of an AudioWorkletProcessor: it runs inside AudioWorkletGlobalScope (a separate,
 * realtime audio thread) and calls registerProcessor() at top level. The renderer
 * reads its bytes over the readChunk IPC (like the other chunks) but then turns them
 * into a blob: URL and hands that to audioWorklet.addModule() — noiseSuppression.ts
 * does the loading, so this key is deliberately absent from lazyLib's eval path.
 *
 * Why it's still a CHUNK (not inline):
 *   The @timephy build embeds RNNoise as an ~1.9 MB emscripten module with the wasm
 *   inlined as base64 (SINGLE_FILE + WASM_ASYNC_COMPILATION=0), so it instantiates
 *   synchronously with NO fetch — which is exactly what an AudioWorklet needs (it can't
 *   await a promise during addModule) AND what Discord's CSP demands (a wasm fetch
 *   would be blocked). That inline base64 is DATA, ~0 ms V8 pre-parse, so keeping it
 *   out of vencordDesktopRenderer.js doesn't save startup compile — but shipping it as
 *   a standalone file is what lets us read it as text and blob-load it as a worklet in
 *   the first place. A module-top import of a 1.9 MB worklet into the renderer bundle
 *   would be pointless dead weight; the chunk carries it out-of-line.
 *
 * The worklet bundle is self-contained: the RnnoiseProcessor (the 480-sample-frame C
 * API adaptor), the 128→480 circular buffer, the atob/self polyfills the emscripten
 * glue needs in the worklet scope, and the inline wasm — all folded into one IIFE by
 * the chunk build. Importing it here for its SIDE EFFECT (the registerProcessor call)
 * is the whole point; there is nothing to re-export.
 */

import "@timephy/rnnoise-wasm/NoiseSuppressorWorklet";
