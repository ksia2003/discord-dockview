/*
 * DockView Examples gallery — on-demand sample loader.
 * ---------------------------------------------------------------------------
 * The gallery's fixtures are NOT inline in vencordDesktopRenderer.js. They ship as
 * chunk-samples.js (built by scripts/build-sample-chunk.mjs), the same out-of-bundle
 * delivery the heavy LIB chunks use: a `"use strict"` file that assigns a base64 map
 * to the `__dockviewChunk_samples` global, shipped next to the renderer and pulled in
 * over the EXISTING readChunk IPC (plugin/native.ts) the first time the gallery is
 * opened. This module is the renderer half of that:
 *
 *   loadSampleChunk()        → read + eval chunk-samples.js once (cached promise),
 *                              returning the { name: base64 } map. Concurrent /
 *                              repeat opens share the one in-flight read.
 *   sampleBlobUrl(file, …)   → decode one fixture's base64 to bytes and hand back a
 *                              blob: URL with the right type (so the dock's CSP is
 *                              bypassed and detectType routes by the file name).
 *
 * This deliberately mirrors engine/lazyLib.ts's loadChunk: the same
 * VesktopNative.dockview.readChunk call and the same eval-via-
 * `new Function` + read-the-global trick (strict eval does NOT leak the var onto
 * globalThis, so we read it through the function's own `return`). No new IPC is
 * needed — readChunk already accepts any `chunk-<safe>.js`.
 */

/** The chunk file name + the global its IIFE assigns the payload to (matches the
 *  `__dockviewChunk_<id>` convention build-sample-chunk.mjs emits). */
const SAMPLE_CHUNK_FILE = "chunk-samples.js";
const SAMPLE_GLOBAL = "__dockviewChunk_samples";

/** filename → base64 of the fixture's bytes. Resolved once, cached for the session. */
type SampleMap = Record<string, string>;

/** Cached load promise — first gallery open does the read+eval, later opens reuse it
 *  (so re-opening the gallery is instant). The PROMISE is cached, so two near-
 *  simultaneous opens share one in-flight read instead of racing two. */
let chunkPromise: Promise<SampleMap> | null = null;

/** blob: URL cache, keyed by fixture file name, so re-opening the same sample reuses
 *  the same object URL instead of decoding + allocating a new blob every click. */
const blobUrlCache = new Map<string, string>();

/**
 * Read + eval chunk-samples.js (once) and return its { name: base64 } map. Throws a
 * clear Error (the gallery surfaces it) if the dir/IPC is unavailable, the file is
 * missing, or the eval doesn't produce the expected global. On failure the cached
 * promise is evicted so a later open can retry a transient read failure.
 */
export function loadSampleChunk(): Promise<SampleMap> {
    if (chunkPromise) return chunkPromise;

    const start = (async (): Promise<SampleMap> => {
        const native = (window as any).VesktopNative?.dockview;
        if (!native || typeof native.readChunk !== "function") {
            throw new Error("readChunk IPC unavailable (build/preload out of date).");
        }

        const src: string | null = await native.readChunk(SAMPLE_CHUNK_FILE);
        if (typeof src !== "string" || !src) {
            throw new Error(`Samples chunk missing or empty: ${SAMPLE_CHUNK_FILE}`);
        }

        // The chunk is `"use strict";var __dockviewChunk_samples = {…};`. Run it as a
        // `new Function` body and return the global straight back — its own strict
        // mode keeps the var function-scoped (it never lands on globalThis), exactly
        // as engine/lazyLib.ts does for the lib chunks. (CSP allows this: Vencord
        // patches in 'unsafe-eval'.)
        let map: any;
        try {
            // eslint-disable-next-line no-new-func
            map = new Function(`${src}\nreturn ${SAMPLE_GLOBAL};`)();
        } catch (e) {
            throw new Error(`Samples chunk failed to evaluate: ${(e as Error)?.message ?? e}`);
        }
        if (!map || typeof map !== "object") {
            throw new Error("Samples chunk did not expose its payload object.");
        }
        return map as SampleMap;
    })();

    chunkPromise = start.catch(err => {
        // Evict so a later open can retry a transient failure.
        chunkPromise = null;
        throw err;
    });
    return chunkPromise;
}

/** True once the samples chunk has loaded this session (lets the UI skip the loading
 *  state on a warm re-open). */
export function isSampleChunkLoaded(): boolean {
    return chunkPromise !== null;
}

/** Decode a base64 string to a Uint8Array (atob → bytes). */
function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Resolve a fixture file to a blob: URL ready to hand to __dockView.load({ name, url }).
 * Loads the chunk if needed, decodes the fixture's base64 once, and caches the blob:
 * URL by file name so re-opening the same sample reuses it. Throws if the fixture is
 * not in the chunk (a catalog/fixtures drift the UI surfaces as an error).
 *
 * A blob: URL with the right MIME type + the file name passed to load() means the
 * dock routes it through detectType exactly like a real attachment chip, and the
 * CSP that would block a data: URL does not apply to blob:.
 */
export async function sampleBlobUrl(file: string, mime = "application/octet-stream"): Promise<string> {
    const cached = blobUrlCache.get(file);
    if (cached) return cached;

    const map = await loadSampleChunk();
    const b64 = map[file];
    if (typeof b64 !== "string") {
        throw new Error(`Sample fixture not found in chunk: ${file}`);
    }
    const blob = new Blob([base64ToBytes(b64)], { type: mime });
    const url = URL.createObjectURL(blob);
    blobUrlCache.set(file, url);
    return url;
}
