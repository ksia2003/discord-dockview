/*
 * Ghostscript-WASM bridge — convert PostScript (EPS / non-PDF Illustrator .ai) to PDF.
 *
 * @jspawn/ghostscript-wasm is GPL Ghostscript 9.56.0 compiled to WASM via Emscripten.
 * It ships out-of-bundle as chunk-ghostscript.js (the ~16 MB wasm is folded into the
 * chunk as a binary literal, so it costs ~0 ms at Vesktop startup and only loads on the
 * first .eps / non-PDF .ai open over the chunk IPC — see engine/chunkRegistry.ts).
 *
 * Two things this module owns:
 *
 *   1. CSP-safe wasm instantiation. The Emscripten glue would default-fetch its wasm via
 *      `fetch(new URL("gs.wasm", import.meta.url))`, which Discord's CSP connect-src
 *      blocks. So we hand the interpreter the wasm bytes (carried in the chunk) through
 *      Emscripten's `instantiateWasm` Module hook — identical to how @jsquash/jxl hands
 *      its codec a pre-compiled module. The WebAssembly.Module is compiled ONCE and
 *      memoised so a second conversion reuses it.
 *
 *   2. The convert call. Ghostscript is a CLI: we mount the input bytes into the module's
 *      in-memory FS, run `callMain([...gs args])` with the pdfwrite device, then read the
 *      produced PDF back out of the FS. A FRESH module instance is created per conversion
 *      (Emscripten's libc + Ghostscript global state aren't safely re-entrant across
 *      callMain runs), but the compiled wasm Module is shared, so the per-call cost is a
 *      cheap instantiate, not a recompile.
 *
 * No module-top executable work — only imports + function decls; the lib is loaded lazily
 * inside psToPdf() via withLibLoading, so nothing runs at Vencord init.
 */

import { withLibLoading } from "../../engine/lazyLib";
import { STRINGS } from "../../strings";
import type { ViewerContext } from "../../engine/types";

/** The chunk's exported shape (engine/chunks/ghostscript.entry.ts, exportMode "star"). */
interface GsChunk {
    /** The Emscripten module factory (gs.mjs default export). */
    createModule: (opts: any) => Promise<any>;
    /** The interpreter's wasm bytes (esbuild binary loader → Uint8Array). */
    wasm: Uint8Array;
}

/** The compiled wasm module, memoised across conversions (compile once, instantiate
 *  per call). null until the first psToPdf() compiles it. */
let wasmModule: WebAssembly.Module | null = null;

/**
 * Convert PostScript / EPS bytes to a PDF (Uint8Array). Loads the Ghostscript chunk on
 * first use (showing the dock's "Converting PostScript…" loading state through ctx), then
 * runs `gs -sDEVICE=pdfwrite` over the input. -dEPSCrop trims an EPS to its BoundingBox so
 * the resulting PDF is the artwork's size (not a full page with the EPS in a corner).
 *
 * Throws a plain Error (surfaced on the dock error card) if the chunk is unavailable, the
 * interpreter exits non-zero, or it produced no PDF.
 */
export async function psToPdf(bytes: Uint8Array, ctx: ViewerContext): Promise<Uint8Array> {
    const { createModule, wasm }: GsChunk = await withLibLoading(
        ctx,
        STRINGS.loading.lib.postscript,
        "ghostscript",
        // Dead inline path: "ghostscript" is in the chunk registry, so loadLib routes to
        // the on-disk chunk (loadChunk) and never calls this importer. Present so the
        // build's dep-deriver sees the specifier and adds the package.
        () => import("@jspawn/ghostscript-wasm/gs.mjs") as any
    );

    if (!wasmModule) {
        // Compile the interpreter's wasm ONCE; reused for every later conversion.
        wasmModule = await WebAssembly.compile(
            wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)
        );
    }

    // Collect Ghostscript's stderr so a failure carries a real diagnostic.
    const errLines: string[] = [];
    const Module = await createModule({
        noInitialRun: true,
        // CSP-safe: hand Emscripten the already-compiled module instead of letting it
        // fetch the wasm by URL (which Discord's CSP would block).
        instantiateWasm(imports: WebAssembly.Imports, success: (inst: WebAssembly.Instance, mod: WebAssembly.Module) => void) {
            WebAssembly.instantiate(wasmModule as WebAssembly.Module, imports).then(inst => {
                success(inst, wasmModule as WebAssembly.Module);
            });
            return {};
        },
        printErr: (line: string) => { errLines.push(line); },
        // swallow stdout (Ghostscript chatter) — we only care about the FS output.
        print: () => { /* ignore */ }
    });

    Module.FS.writeFile("in.ps", bytes);
    const rc: number = Module.callMain([
        "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dEPSCrop",
        "-sDEVICE=pdfwrite", "-sOutputFile=out.pdf", "in.ps"
    ]);
    if (rc !== 0) {
        const tail = errLines.slice(-4).join(" ").trim();
        throw new Error(tail ? `Ghostscript: ${tail}` : `Ghostscript exited ${rc}`);
    }

    let out: Uint8Array;
    try {
        out = Module.FS.readFile("out.pdf");
    } catch {
        throw new Error("Ghostscript produced no PDF");
    }
    if (!out || out.length === 0) throw new Error("Ghostscript produced an empty PDF");
    return out;
}

/** True iff the bytes start with a `%PDF` signature (within the first 1 KB — some files
 *  carry a few leading bytes before the header). Many Illustrator .ai files are
 *  PDF-compatible (they embed a full PDF stream), so a `%PDF`-headed .ai can route
 *  straight to the existing pdf.js viewer with no Ghostscript pass at all. */
export function looksLikePdf(bytes: Uint8Array): boolean {
    const n = Math.min(bytes.length, 1024);
    for (let i = 0; i + 3 < n; i++) {
        if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) {
            return true; // "%PDF"
        }
    }
    return false;
}
