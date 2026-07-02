/*
 * Lazy heavy-library loader — the one place a viewer pulls in a big dependency.
 *
 * WHY THIS EXISTS (measured, not assumed)
 * ---------------------------------------
 * The whole plugin ships as a SINGLE vencordDesktopRenderer.js: Vencord builds the
 * renderer as an esbuild IIFE bundle with no code-splitting, so a dynamic import()
 * does NOT emit a separate chunk — the bytes ship inline either way. What a dynamic
 * import() DOES still buy us is DEFERRED EXECUTION: a statically-imported module runs
 * its top-level code at Vencord init (proven: registry.ts statically importing a
 * viewer drags the viewer's lib top-level into startup); a dynamically-imported one
 * does not run until it is first awaited.
 *
 * The measured split (V8 pre-parse, this build, fresh isolates):
 *   - the heavy libs are ~11 MB of the 12.26 MB renderer;
 *   - their total startup PARSE cost is ~169 ms, but it is NOT proportional to bytes:
 *     code-dense libs cost (mermaid ~72 ms, pdfjs ~28 ms, codemirror ~30 ms) while
 *     DATA/wasm libs are ~0 ms (heic2any 1.29 MB → ~0 ms, @viz-js/viz ~0 ms,
 *     highlight.js ~0 ms) because V8 pre-parse scans function bodies, not data
 *     literals (heic2any's libheif is a base64 string, not code).
 *
 * So the first win is: make every heavy lib a dynamic import() so its top-level
 * EXECUTION leaves startup, and surface a dock "loading" state while the lib
 * instantiates. That is what withLibLoading gives every viewer.
 *
 * The SECOND win — removing the inline BYTES — is now LIVE for the code-dense libs
 * (mermaid, pptx, three, pdfjs, codemirror; see engine/chunkRegistry.ts). Those are
 * EXTERNALIZED from the renderer and built as standalone chunk-<lib>.js files; loadLib
 * routes a chunked key to loadChunk() below — read the chunk source over the readChunk
 * IPC (main reads it off disk next to the renderer bundle) and eval it (Vencord patches
 * 'unsafe-eval' into the CSP). The viewers' withLibLoading call sites do NOT change: the
 * chunk-vs-inline decision lives entirely here, and the loading label finally covers a
 * real async disk read + eval. DATA/wasm-dense libs (heic2any, viz, highlight.js) gain
 * ~0 ms from byte removal, so they stay INLINE (not in the registry).
 *
 * CONTRACT
 *   loadLib(key, () => import("heavy"))  → caches the module promise by key, so the
 *   second open of the same format reuses the already-loaded lib (no re-import, no
 *   re-instantiation). The import() promise itself is memoised: concurrent opens of
 *   two HEICs await the same single load.
 *
 *   withLibLoading(ctx, label, key, importer)  → the viewer-facing helper: flips the
 *   dock into a labelled "Loading <viewer>…" state, awaits the lib, then clears the
 *   label. Returns the module. A viewer wraps its dynamic import in this so the dock
 *   shows the right copy while a multi-MB wasm/lib spins up.
 */

import { CHUNK_BY_KEY, type ChunkSpec } from "./chunkRegistry";
import { DecoderDisabledError, decoderLabelFor, modeFor } from "./decoderModes";
import type { ViewerContext } from "./types";

/** Memoised module promises, keyed by a stable string a viewer chooses (usually the
 *  package name). The promise — not the resolved module — is cached so two near-
 *  simultaneous opens share one in-flight import() instead of racing two. */
const libCache = new Map<string, Promise<any>>();

/** chunk file name → global the chunk's IIFE assigns its exports to. Kept stable
 *  per chunk so concurrent evals of DIFFERENT chunks never clash, and we can read
 *  the export right back off globalThis after a synchronous eval. */
function chunkGlobalName(spec: ChunkSpec): string {
    return `__dockviewChunk_${spec.chunkId}`;
}

/**
 * Load an out-of-bundle CHUNK lib: ask main (over the readChunk IPC) for the
 * chunk-<lib>.js source that ships next to the renderer bundle, eval it (CSP
 * allows 'unsafe-eval'), and hand back the module export. This is the byte-removal
 * path: the lib is NOT inline in vencordDesktopRenderer.js, so its V8 compile cost
 * left startup; the eval here is the deferred, on-first-open cost the dock's
 * loading label already covers.
 *
 * The chunk's IIFE (built with globalName = chunkGlobalName(spec)) assigns its
 * exports object to globalThis.<name>; we read it straight back (eval is sync),
 * normalise to the same shape the inline `import("pkg")` gave the viewer, and
 * return it. Throws (so loadLib evicts + the viewer shows an error) if the bridge
 * is missing, the read fails, or the eval doesn't produce the expected export.
 */
async function loadChunk(spec: ChunkSpec): Promise<any> {
    const w = window as any;
    const dir: string | null = (() => {
        try {
            const d = w.VesktopNative?.fileManager?.getVencordDir?.();
            return typeof d === "string" && d ? d : null;
        } catch {
            return null;
        }
    })();
    if (!dir) throw new Error("DockView: cannot locate Vencord files dir to load chunk " + spec.chunkId);

    const native = w.VencordNative?.pluginHelpers?.DockView;
    if (!native || typeof native.readChunk !== "function") {
        throw new Error("DockView: readChunk IPC unavailable (build/preload out of date) for " + spec.chunkId);
    }

    const fileName = `chunk-${spec.chunkId}.js`;
    const src: string | null = await native.readChunk(dir, fileName);
    if (typeof src !== "string" || !src) {
        throw new Error("DockView: chunk file missing or empty: " + fileName);
    }

    const globalName = chunkGlobalName(spec);
    // The chunk is an esbuild IIFE: `"use strict";var <globalName>=(()=>{…})();`.
    // We run it as the body of a `new Function`, then `return <globalName>`. The
    // chunk's own "use strict" makes the function body strict, so `var <globalName>`
    // is FUNCTION-scoped (not a global-object property — strict eval/indirect-eval
    // does NOT attach top-level vars to globalThis), and the trailing `return` reads
    // it straight back. This keeps globalThis clean and works under Discord's strict
    // module renderer. (CSP allows this: Vencord patches in 'unsafe-eval'.)
    let exportsObj: any;
    try {
        // eslint-disable-next-line no-new-func
        exportsObj = new Function(`${src}\nreturn ${globalName};`)();
    } catch (e) {
        throw new Error(`DockView: chunk ${spec.chunkId} failed to evaluate: ${(e as Error)?.message ?? e}`);
    }
    if (!exportsObj) {
        throw new Error("DockView: chunk did not expose its export object: " + globalName);
    }
    // Match the shape the viewer's inline importer returned: "default" mode hands
    // back the package's default export; "star" mode the whole namespace object.
    return spec.exportMode === "default" ? exportsObj.default : exportsObj;
}

/**
 * Load a heavy library exactly once, caching the load promise by `key`.
 *
 * Two paths, chosen by whether `key` is in the chunk registry:
 *   - CHUNKED key → ignore `importer` entirely; read + eval the on-disk chunk file
 *     (loadChunk). The lib's bytes are not in the renderer bundle, so the literal
 *     `import("pkg")` inside `importer` is dead code that never runs (the renderer
 *     build marks `pkg` external; nothing reaches the importer).
 *   - INLINE key → call the viewer's `() => import("pkg")`. esbuild sees the literal
 *     specifier (the build's dep-deriver scans for it) so the lib ships inline and
 *     the import() resolves in a microtask.
 * Subsequent calls with the same key return the cached promise either way.
 */
export function loadLib<T = any>(key: string, importer: () => Promise<T>): Promise<T> {
    let p = libCache.get(key);
    if (!p) {
        // Performance page gate: a user-controllable heavy decoder set to "disabled"
        // must NOT load its chunk. Reject BEFORE caching (so flipping back to on-demand
        // retries cleanly) with a tagged error the viewer's catch surfaces as a notice
        // card. A decoder already loaded this session hit the cache above, so switching
        // to "disabled" only blocks the NEXT, not-yet-loaded open (already-loaded chunks
        // stay loaded). Non-controllable keys have no control → always on-demand.
        const label = decoderLabelFor(key);
        if (label && modeFor(key) === "disabled") {
            return Promise.reject(new DecoderDisabledError(label));
        }
        const spec = CHUNK_BY_KEY.get(key);
        const start = spec ? loadChunk(spec) : importer();
        // On failure, evict so a later open can retry (a transient init/read failure
        // shouldn't poison the format for the rest of the session).
        p = start.catch(err => {
            libCache.delete(key);
            throw err;
        });
        libCache.set(key, p);
    }
    return p;
}

/** True once a lib has been loaded (its promise resolved) this session — lets a
 *  viewer skip the loading label on a warm second open (the import is instant). */
export function isLibLoaded(key: string): boolean {
    return libCache.has(key);
}

/**
 * Viewer-facing wrapper: show a labelled dock loading state for a heavy viewer, load
 * its lib (cached), and hand back the module.
 *
 * WHY THE LABEL IS SET FOR THE WHOLE LOADING SPAN, NOT JUST AROUND import()
 * ------------------------------------------------------------------------
 * The plugin ships as one IIFE bundle with no code-splitting, so import("heavy") of an
 * inline module resolves in a microtask — too fast to ever paint a label. The visible
 * cost of a heavy viewer is the work AFTER the import: heic2any's libheif wasm decode,
 * mermaid's DOM render, viz's wasm instantiate, mammoth's docx walk. That whole span
 * runs under content.loading === true, so we set content.loadingLabel here and DELIBER-
 * ATELY DO NOT clear it: it stays as the spinner's caption until the loader flips
 * content.loading false (LoadingBody only renders while loading) and the next load's
 * showContent reset (content.loadingLabel = null) wipes it. A stale label on a loaded
 * body is never shown, so leaving it set is safe and gives the spinner the right name
 * for the entire decode — exactly what the dock should say while a multi-MB viewer
 * warms up. (When the future out-of-bundle chunk loader makes import() a real async
 * IPC read, the same call already labels that wait too.)
 *
 * On a warm second open the lib is cached and the decode is the only cost; we still
 * label it (cheap, and the format name is still the honest caption). The viewer can
 * pass isLibLoaded(key) itself if it wants to suppress the label on warm opens.
 */
export async function withLibLoading<T = any>(
    ctx: ViewerContext,
    label: string,
    key: string,
    importer: () => Promise<T>
): Promise<T> {
    ctx.content.loadingLabel = label;
    ctx.requestRender();
    // The label persists through the post-import decode (see header); the loader's
    // content.loading=false + the next load's reset clear it. We never clear it here.
    return loadLib(key, importer);
}
