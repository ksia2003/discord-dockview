/*
 * Chunk entry for ag-psd — see engine/chunkRegistry.ts.
 * ---------------------------------------------------------------------------
 * The raster viewer decodes PSDs with ag-psd. It is the only PSD reader we found
 * that handles ALL the depths/compressions chat throws at it: 8/16/32-bit channels
 * AND Raw/RLE/Zip composite data. (The previous reader, @webtoon/psd, parse-threw on
 * any Zip-compressed PSD — what ImageMagick and many tools emit — and its WASM
 * compositor PANICKED on 16-bit, so 16-bit PSDs never rendered.)
 *
 * Why a CHUNK (not inline): ag-psd's dist references `require('util').inspect` in a
 * few DEBUG-only console.log paths. Vencord's renderer build BANS importing node
 * builtins in browser code (banImportPlugin), so an inline ag-psd would fail the
 * renderer build outright. Externalising it (this chunk) keeps the renderer build
 * clean — the ban never sees ag-psd — and scripts/build-chunks.mjs bundles this
 * entry with `util` aliased to a no-op stub (the inspect() calls are dead unless a
 * debug flag is set, so the stub is harmless). It also keeps ag-psd's ~290 KB out of
 * the base renderer; the bytes load on first PSD open over the chunk IPC, behind the
 * "Loading PSD decoder…" dock state — exactly like the other chunked heavy libs.
 *
 * exportMode "star": the chunk's namespace object is handed back, and the viewer
 * destructures `const { readPsd, initializeCanvas } = await loadLib("ag-psd", …)`.
 */

export { readPsd, initializeCanvas } from "ag-psd";
