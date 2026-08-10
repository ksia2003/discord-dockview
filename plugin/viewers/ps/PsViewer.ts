/*
 * The PostScript viewer — type "postscript" (EPS + Adobe Illustrator .ai).
 *
 * Two formats route here, and both end up rendered by the EXISTING pdf.js viewer:
 *
 *   .ai (Illustrator)  — MANY .ai files are PDF-compatible: Illustrator writes a full PDF
 *                        stream into the file (the "Create PDF Compatible File" option,
 *                        on by default for years). So the loader FIRST sniffs the bytes
 *                        for a `%PDF` header — if present, it routes the file straight to
 *                        the pdf viewer with ZERO conversion (the fast lane, no Ghostscript
 *                        chunk downloaded). Only a non-PDF .ai (pure PostScript, older or
 *                        "PDF compatibility off") falls through to the Ghostscript path.
 *   .eps               — pure PostScript; always converted.
 *
 * The PostScript path uses Ghostscript-WASM (viewers/ps/ghostscript.ts → the
 * chunk-ghostscript.js out-of-bundle chunk) to convert PS → PDF in the RENDERER (proven:
 * a clean --platform=browser esbuild + a live EPS→PDF conversion; CSP-safe via the
 * instantiateWasm hook — no Worker, no native IPC, so the OTA reloads without a relaunch).
 * The produced PDF is wrapped in a same-origin blob: url; the loader then RETYPES the file
 * to "pdf" and hands off to the pdf viewer's own load() (which fetches the blob, runs
 * pdf.js, and drives the full PDF surface: page nav / zoom / fit / find / rotate) — the
 * same decode→retype hand-off the raw/dxf/xlsx viewers use, just retyping to "pdf" and
 * delegating to that viewer's loader (PDF needs the pdf.js parse, not a passive url read).
 *
 * The fetch + (chunk load + convert) round-trip runs under content.loading with a
 * "Converting PostScript…" label (the %PDF fast lane skips straight to the PDF load).
 *
 * Single PS/AI in → a PDF surface out: this viewer ALWAYS retypes content.type to "pdf"
 * before any body renders, so its Body never mounts (the dispatcher routes to the pdf
 * viewer once the type flips). A placeholder Body satisfies the contract; dispose()
 * revokes the blob: url we created (guarded on the blob: scheme so we only revoke urls WE
 * made). The pdf viewer's own dispose() releases the parsed pdf.js doc on eviction.
 */

import { STRINGS } from "../../strings";
import { isCacheEntryLive } from "../../engine/cache";
import { discardStaleBlob } from "../../engine/cacheOwnership";
import type { CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext } from "../../engine/types";
import { PdfViewer } from "../pdf/PdfViewer";
import { looksLikePdf, psToPdf } from "./ghostscript";
import { PsPlaceholderBody } from "./PsBody";

/** Hand a ready PDF (blob: url) to the pdf viewer: keep the source descriptor intact,
 *  point the render payload at the blob, then delegate to PdfViewer.load(). */
function handToPdf(blobUrl: string, opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    if (!token.isCurrent() || (entry != null && !isCacheEntryLive(entry))) {
        discardStaleBlob(
            entry,
            blobUrl,
            url => { try { URL.revokeObjectURL(url); } catch { /* already revoked */ } },
            "PostScript conversion completed after its cache entry was detached"
        );
        return;
    }
    if (entry) {
        entry.renderType = "pdf";
        entry.renderUrl = blobUrl;
    }
    ctx.content.type = "pdf";
    ctx.content.url = blobUrl;
    // Delegate to the pdf viewer's loader with the blob url. It resets content.pdf, fetches
    // the blob, runs pdf.js, and writes content.pdf.doc — the dispatcher (keyed on the now-
    // "pdf" type) mounts PdfBody. noCache is irrelevant for a blob: url (no HTTP cache).
    PdfViewer.load({ ...opts, url: blobUrl, type: "pdf" }, token, entry, ctx);
}

/** PostScript/AI loader: fetch bytes → %PDF fast lane (PDF-compatible .ai) OR Ghostscript
 *  PS→PDF → blob: → retype to "pdf" + delegate to the pdf viewer. */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = STRINGS.error.noSource.title;
        return;
    }
    ctx.content.loading = true;
    ctx.requestRender();

    const reqUrl = opts.url;
    ctx.fetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.arrayBuffer();
        })
        .then(async buf => {
            const bytes = new Uint8Array(buf);
            // FAST LANE: a PDF-compatible .ai already IS a PDF — route it straight to the
            // pdf viewer with no Ghostscript chunk at all.
            if (looksLikePdf(bytes)) {
                const blob = new Blob([bytes], { type: "application/pdf" });
                return URL.createObjectURL(blob);
            }
            // Pure PostScript (.eps, or a non-PDF .ai) → Ghostscript PS → PDF.
            const pdfBytes = await psToPdf(bytes, ctx);
            // Copy into a fresh ArrayBuffer-backed Uint8Array so the Blob owns clean bytes
            // (the FS read may hand back a view over Emscripten heap memory).
            const owned = new Uint8Array(pdfBytes.length);
            owned.set(pdfBytes);
            const blob = new Blob([owned], { type: "application/pdf" });
            return URL.createObjectURL(blob);
        })
        .then(blobUrl => {
            handToPdf(blobUrl, opts, token, entry, ctx);
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (!token.isCurrent()) return;
            ctx.content.loading = false;
            ctx.content.loadingLabel = null;
            ctx.content.error = String(e?.message || e);
            ctx.requestRender();
        });
}

function createState(): Record<string, never> { return {}; }
function resetState(): void { /* no view-state — PS retypes to pdf */ }
function snapshot(): void { /* nothing to persist; the entry retypes to pdf */ }
function restore(): void { /* nothing to restore */ }

/** Revoke the blob: url this viewer created when the cache entry is evicted. Guarded on
 *  the blob: scheme so we only ever revoke urls WE created, never a CDN url. The pdf
 *  viewer's own dispose (registered for "pdf") releases the parsed pdf.js doc; once the
 *  entry has retyped to "pdf" the cache calls THAT dispose, not this one — so this guards
 *  only the (rare) eviction of a still-"postscript" entry whose conversion hadn't finished. */
function dispose(entry: CacheEntry): void {
    const u = entry.renderUrl;
    if (u && u.startsWith("blob:")) {
        try { URL.revokeObjectURL(u); } catch { /* already gone */ }
    }
}

export const PsViewer: Viewer<Record<string, never>> = {
    type: "postscript",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    dispose,
    // load() retypes content.type to "pdf" before the body renders, so the dispatcher
    // always routes to the pdf viewer's Body — this placeholder Body is never mounted.
    Body: PsPlaceholderBody,
    capabilities: { openInWindow: true }
};
