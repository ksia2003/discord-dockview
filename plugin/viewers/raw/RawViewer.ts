/*
 * The RAW viewer — type "raw" (camera RAW: cr2/nef/dng/arw/raf/orf/rw2).
 *
 * A camera RAW can't be decoded in the renderer: libraw-wasm (the obvious browser
 * decoder) uses a web Worker + import.meta.url, and that web Worker throws "Worker is
 * not defined" under Node — but the heavy decode has to live in main anyway (a RAW is
 * a Node-only decode). So this viewer asks the MAIN process: it calls the
 * convertAttachment("raw", url) IPC, which fetches the RAW in main, extracts the
 * embedded JPEG preview (most RAWs carry a full/medium one) or, failing that, decodes
 * the TIFF/DNG IFD with utif and encodes a PNG — and returns the image bytes. The
 * viewer wraps those bytes in a same-origin `blob:` url and RETYPES the file to
 * "image", so the existing image viewer surface (fit-width, wheel-zoom, drag-pan,
 * fullscreen lightbox) renders the photo — exactly the decode→retype trick the
 * tiff/heic raster path and the dxf viewer use, just with the decode in main.
 *
 * The network-fetch-in-main + decode round-trip runs under content.loading with a
 * "Decoding RAW image…" label.
 *
 * Single RAW in / single image out: this viewer ALWAYS retypes to "image", so its Body
 * never actually mounts (the dispatcher routes to the image viewer once content.type
 * flips). We supply a placeholder Body to satisfy the contract + a dispose() that
 * revokes the blob: url we created (guarded on the blob: scheme so we only revoke urls
 * WE made, never the CDN url).
 */

import { convertAttachment } from "../../engine/convertAttachment";
import { STRINGS } from "../../strings";
import type { CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext } from "../../engine/types";
import { resetImgView } from "../image/ImageBody";
import { RawPlaceholderBody } from "./RawBody";

/** RAW loader: ask main (convertAttachment IPC) to decode → blob: → retype to "image". */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = STRINGS.error.noSource.title;
        return;
    }
    ctx.content.loading = true;
    ctx.content.loadingLabel = STRINGS.loading.lib.raw;
    ctx.requestRender();

    const reqUrl = opts.url;
    convertAttachment("raw", reqUrl)
        .then(({ blobUrl }) => {
            if (entry) {
                entry.renderType = "image";
                entry.renderUrl = blobUrl;
                entry.loading = false;
                entry.error = null;
            }
            if (!token.isCurrent()) return; // superseded — entry holds the blob; dispose revokes it
            ctx.content.type = "image";
            ctx.content.url = blobUrl;
            resetImgView(ctx.window);
            ctx.content.loading = false;
            ctx.content.loadingLabel = null;
            ctx.content.error = null;
            ctx.requestRender();
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
function resetState(): void { /* no view-state — RAW retypes to image */ }
function snapshot(): void { /* nothing to persist; the entry retypes to image */ }
function restore(): void { /* nothing to restore */ }

/** Revoke the blob: url this viewer created when the cache entry is evicted. Guarded on
 *  the blob: scheme so we only ever revoke urls WE created, never a CDN url. */
function dispose(entry: CacheEntry): void {
    const u = entry.renderUrl;
    if (u && u.startsWith("blob:")) {
        try { URL.revokeObjectURL(u); } catch { /* already gone */ }
    }
}

export const RawViewer: Viewer<Record<string, never>> = {
    type: "raw",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    dispose,
    // load() retypes content.type to "image" before the body renders, so the dispatcher
    // always routes to the image viewer's Body — this placeholder Body is never mounted.
    Body: RawPlaceholderBody,
    capabilities: { openInWindow: true }
};
