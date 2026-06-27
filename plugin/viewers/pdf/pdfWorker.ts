/*
 * The LAZY pdf.js loader — the same once-guarded dynamic-import pattern as the
 * text engine's loadCM (viewers/text/cm.ts).
 *
 * pdf.js (and its worker module) MUST NOT be touched at plugin module-eval. The
 * old monolith imported pdfjs + the worker statically and ran installUpsert /
 * registered globalThis.pdfjsWorker at module top — which was safe THERE only
 * because that file was the whole plugin. In the modular tree the engine↔viewer
 * import cycle makes any module-top WORK fatal: the plugin loads silently dead
 * (window.__dockView / Vencord.Plugins.plugins.DockView undefined, no dock). So
 * EVERYTHING the old top-of-file did — the dynamic import of pdfjs + the worker,
 * the Map/WeakMap upsert polyfill, and registering the worker handler on
 * globalThis — is deferred behind loadPdfjs(), which runs exactly ONCE on the
 * FIRST PDF open (a cached promise), mirroring loadCM.
 *
 * VERBATIM (measured / live-verified — do not "clean up"):
 *  - Main-thread worker. We register the bundled WorkerMessageHandler on
 *    globalThis.pdfjsWorker so pdf.js runs the worker message handler ON THE MAIN
 *    THREAD (its "fake worker" path) using THIS already-bundled code. No
 *    `new Worker(url)`, no blob: URL, no runtime dynamic import of a worker file —
 *    all three of which Discord's CSP would block in the desktop renderer.
 *  - Map/WeakMap `getOrInsert` / `getOrInsertComputed` upsert polyfill. pdf.js v6
 *    uses the TC39 "Upsert" methods internally; they are NOT yet shipped in this
 *    Electron/Chromium V8 build, so without these shims page.render() rejects.
 *    Installed in a try/catch, exactly as the original did.
 */

// The resolved pdfjs module surface (whatever pdfjs-dist exports — getDocument,
// TextLayer, GlobalWorkerOptions, …). Typed loose; callers cast what they use.
export type Pdfjs = any;

// pdf.js v6 uses the TC39 "Upsert" methods Map/WeakMap.prototype.getOrInsert &
// getOrInsertComputed internally. They are NOT yet shipped in this
// Electron/Chromium V8 build, so without these shims page.render() rejects.
function installUpsert(Ctor: any): void {
    const proto = Ctor && Ctor.prototype;
    if (!proto) return;
    if (typeof proto.getOrInsert !== "function") {
        Object.defineProperty(proto, "getOrInsert", {
            configurable: true,
            writable: true,
            value(key: any, value: any) {
                if (this.has(key)) return this.get(key);
                this.set(key, value);
                return value;
            }
        });
    }
    if (typeof proto.getOrInsertComputed !== "function") {
        Object.defineProperty(proto, "getOrInsertComputed", {
            configurable: true,
            writable: true,
            value(key: any, callbackFn: (k: any) => any) {
                if (this.has(key)) return this.get(key);
                const v = callbackFn(key);
                this.set(key, v);
                return v;
            }
        });
    }
}

let pdfjsPromise: Promise<Pdfjs> | null = null;

/** Resolve pdf.js (and wire its main-thread worker) behind a single dynamic
 *  import(), ONCE. The first PDF open pays the import; every later one reuses the
 *  cached promise. The dynamic imports MUST NOT be hoisted to module top — a
 *  static pdfjs / pdf.worker import THROWS during the engine↔viewer import cycle
 *  and silently kills the whole plugin (same failure class as a module-top
 *  React.createElement). */
export function loadPdfjs(): Promise<Pdfjs> {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = (async () => {
        // Dynamic imports — deferred to the first PDF open (see the file header).
        // We import the worker module ALONGSIDE pdfjs and register it on
        // globalThis.pdfjsWorker so pdf.js runs the worker message handler on the
        // MAIN THREAD using this bundled code (CSP-safe; no new Worker / blob URL).
        const pdfjsLib = await import("pdfjs-dist");
        const { WorkerMessageHandler } = await import("pdfjs-dist/build/pdf.worker.mjs");

        // Runtime polyfill: Map/WeakMap upsert helpers pdf.js v6 needs. In a
        // try/catch as the original did — a defineProperty failure must not abort
        // the load (getDocument would still mostly work, just noisier).
        try {
            installUpsert(Map);
            installUpsert(WeakMap);
        } catch {
            /* ignore — defineProperty refusal is non-fatal */
        }

        // Register the bundled worker handler for pdf.js's main-thread fallback.
        try {
            (globalThis as any).pdfjsWorker = { WorkerMessageHandler };
        } catch {
            /* ignore — getDocument will still fall back, just noisier */
        }

        return pdfjsLib as Pdfjs;
    })();
    return pdfjsPromise;
}
