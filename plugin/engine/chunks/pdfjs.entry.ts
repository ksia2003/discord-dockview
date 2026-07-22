/*
 * Chunk entry for PDF.JS — see engine/chunkRegistry.ts (exportMode "star").
 * ---------------------------------------------------------------------------
 * pdf.js is code-dense (~28 ms of startup V8 compile, measured) and is taken OUT
 * of dockviewRenderer.js as chunk-pdfjs.js. The PDF viewer needs the main
 * pdfjs surface (getDocument, TextLayer, …) PLUS the worker module's
 * WorkerMessageHandler export — the renderer registers it on globalThis.pdfjsWorker
 * so pdf.js runs the worker handler ON THE MAIN THREAD (CSP-safe; no real Worker /
 * blob URL). Both go in one deduped chunk so they share pdf.js internals.
 *
 * The chunk's namespace is:
 *   { lib: <pdfjs module>, WorkerMessageHandler: <class> }
 * viewers/pdf/pdfWorker.ts reads `mod.lib` (the pdfjs surface) and
 * `mod.WorkerMessageHandler` (to register the main-thread worker), exactly as it
 * used to from the two separate dynamic imports.
 */

export * as lib from "pdfjs-dist";
export { WorkerMessageHandler } from "pdfjs-dist/build/pdf.worker.mjs";
