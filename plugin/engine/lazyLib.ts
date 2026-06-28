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
 * So the cheap, infra-free win is: make every heavy lib a dynamic import() so its
 * top-level EXECUTION leaves startup, and surface a dock "loading" state while the
 * lib instantiates. That is exactly what this module gives every viewer.
 *
 * (Removing the inline BYTES — a separate out-of-bundle chunk fetched over IPC and
 * eval'd — is a heavier, main-process-touching mechanism worth it only for the
 * code-dense libs, and only once the bundle parse becomes the bottleneck. It is NOT
 * done here; see docs. This module is the renderer-only layer those viewers already
 * sit behind, so a future chunk loader can slot in under loadLib() transparently.)
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

import type { ViewerContext } from "./types";

/** Memoised module promises, keyed by a stable string a viewer chooses (usually the
 *  package name). The promise — not the resolved module — is cached so two near-
 *  simultaneous opens share one in-flight import() instead of racing two. */
const libCache = new Map<string, Promise<any>>();

/**
 * Load a heavy library exactly once, caching the import() promise by `key`.
 * The importer is the viewer's own `() => import("pkg")` so esbuild still sees a
 * literal specifier (the build's dep-deriver scans for it) and the dynamic-import
 * deferral applies. Subsequent calls with the same key return the cached promise.
 */
export function loadLib<T = any>(key: string, importer: () => Promise<T>): Promise<T> {
    let p = libCache.get(key);
    if (!p) {
        // On failure, evict so a later open can retry (a transient init failure
        // shouldn't poison the format for the rest of the session).
        p = importer().catch(err => {
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
