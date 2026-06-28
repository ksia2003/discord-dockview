/*
 * The RASTER-IMAGE viewer — type "rasterimage".
 *
 * TIFF / PSD / HEIC can't be put into an <img src> directly (the browser has no
 * native decoder for them), so this loader does what the xlsx loader does for the
 * csv grid: it FETCHES the bytes, DECODES them per-format to an RGBA bitmap, paints
 * that to an offscreen <canvas>, exports a same-origin `blob:` PNG/JPEG url, and
 * RETYPES the file to "image" — so the existing image viewer surface (fit-width,
 * wheel-zoom, drag-pan, fullscreen lightbox) renders it with zero extra UI.
 *
 *   tiff/tif  -> utif         (UTIF.decode + decodeImage + toRGBA8; first page only)
 *   psd       -> @webtoon/psd (Psd.parse(...).composite() → the flattened image)
 *   heic/heif -> heic2any     (libheif wasm → a PNG/JPEG Blob)
 *
 * Every decoder is loaded with a DYNAMIC import() inside the per-format branch, so
 * none of them (and especially not the large heic/libheif wasm) lands in the base
 * renderer bundle — the code only downloads when a file of that type is actually
 * opened.
 *
 * blob: urls are same-origin and NOT subject to Discord's CSP connect-src, so once
 * decoded the picture renders anywhere. The url is OWNED by this viewer: we revoke
 * it in dispose() when the cache entry is evicted, so a long session doesn't leak
 * decoded bitmaps. (The image viewer never creates blob urls itself — only this one
 * does, which is why the cache's generic disposeCacheEntry hands the entry to the
 * owning viewer's dispose.)
 *
 * Cache contract (mirrors xlsx): the entry KEY stays "rasterimage|<cdn-url>" (set by
 * detectType at open time), but after decode we store the BLOB url on entry.url so a
 * cache restore re-points the <img> at the decoded bitmap, not the CSP-blocked CDN
 * url. The descriptor that re-keys a restore derives its type from the original file
 * NAME (e.g. "photo.heic"), so the routing type stays "rasterimage" and the key still
 * matches — the blob url has no extension and would otherwise detect as "unknown".
 */

import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { extOf } from "../../engine/detectType";
import { ImageBody, resetImgView } from "../image/ImageBody";

/** A decoded bitmap: RGBA bytes laid out row-major (4 bytes/px), plus dimensions. */
interface Decoded {
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
}

/** A JPEG (lossy, far smaller) is used past this pixel count so a huge PSD/TIFF
 *  doesn't produce a multi-hundred-MB PNG data copy in the blob. Below it we keep
 *  PNG (lossless). 8 MP ≈ a 4K-ish frame. */
const JPEG_PIXEL_THRESHOLD = 8_000_000;

/** Decode TIFF (first page) with utif. Synchronous; multi-page TIFFs show page 1
 *  (a future depth item — most TIFFs in chat are single-page scans/exports). */
async function decodeTiff(buf: ArrayBuffer): Promise<Decoded> {
    const UTIF: any = (await import("utif")).default ?? (await import("utif"));
    const ifds = UTIF.decode(buf);
    if (!ifds || !ifds.length) throw new Error("No image in TIFF");
    const ifd = ifds[0];
    UTIF.decodeImage(buf, ifd);
    const rgba = UTIF.toRGBA8(ifd); // Uint8Array, length = w*h*4
    const width = ifd.width as number;
    const height = ifd.height as number;
    if (!width || !height) throw new Error("Empty TIFF frame");
    return { rgba: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height };
}

/** Decode a PSD's composited (flattened) image with @webtoon/psd. */
async function decodePsd(buf: ArrayBuffer): Promise<Decoded> {
    const Psd: any = (await import("@webtoon/psd")).default;
    const psd = Psd.parse(buf);
    const rgba: Uint8ClampedArray = await psd.composite(); // RGBA, w*h*4
    const width = psd.width as number;
    const height = psd.height as number;
    if (!width || !height) throw new Error("Empty PSD canvas");
    return { rgba, width, height };
}

/** Paint RGBA → an offscreen canvas → a blob: url (PNG, or JPEG past the pixel
 *  threshold so a huge frame doesn't balloon). Returns the url + dimensions. */
function rgbaToBlobUrl(d: Decoded): Promise<{ url: string; width: number; height: number }> {
    const canvas = document.createElement("canvas");
    canvas.width = d.width;
    canvas.height = d.height;
    const cx = canvas.getContext("2d");
    if (!cx) throw new Error("No 2D canvas context");
    const expected = d.width * d.height * 4;
    if (d.rgba.length < expected) throw new Error("Truncated pixel data");
    cx.putImageData(new ImageData(d.rgba.subarray(0, expected), d.width, d.height), 0, 0);
    const huge = d.width * d.height > JPEG_PIXEL_THRESHOLD;
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            blob => {
                if (!blob) { reject(new Error("Canvas export failed")); return; }
                resolve({ url: URL.createObjectURL(blob), width: d.width, height: d.height });
            },
            huge ? "image/jpeg" : "image/png",
            huge ? 0.9 : undefined
        );
    });
}

/** Decode HEIC/HEIF straight to a Blob with heic2any (libheif wasm), then wrap it in
 *  a blob: url. heic2any already paints through libheif → canvas internally and hands
 *  back a PNG/JPEG Blob, so we don't go via our own canvas for this branch. */
async function heicToBlobUrl(buf: ArrayBuffer): Promise<{ url: string }> {
    const heic2any: any = (await import("heic2any")).default;
    const out = await heic2any({ blob: new Blob([buf]), toType: "image/png" });
    const blob: Blob = Array.isArray(out) ? out[0] : out; // multi-image HEIC → first frame
    if (!blob) throw new Error("HEIC produced no image");
    return { url: URL.createObjectURL(blob) };
}

/** RASTER-IMAGE loader: fetch bytes → decode per ext → blob: url → retype to "image".
 *  Always writes the cache `entry` (even when superseded, so dispose can revoke the
 *  blob), only writes live `content` while the token is current. */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = STRINGS.error.noSource.title;
        return;
    }
    ctx.content.loading = true;
    const reqUrl = opts.url;
    const ext = extOf(opts.url) || extOf(opts.name);

    ctx.fetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.arrayBuffer();
        })
        .then(async buf => {
            let blobUrl: string;
            if (ext === "heic" || ext === "heif") {
                blobUrl = (await heicToBlobUrl(buf)).url;
            } else if (ext === "psd") {
                blobUrl = (await rgbaToBlobUrl(await decodePsd(buf))).url;
            } else {
                // tiff / tif (and any future raster ext routed here)
                blobUrl = (await rgbaToBlobUrl(await decodeTiff(buf))).url;
            }

            // Park the decoded result on the entry as an "image" so a cache restore
            // re-points the <img> at the blob (mountFromCache sets content.url = e.url).
            // The KEY stays "rasterimage|<cdn-url>"; only the render type + url change.
            if (entry) {
                entry.type = "image";
                entry.url = blobUrl;
                entry.loading = false;
                entry.error = null;
            }

            if (!token.isCurrent()) {
                // Superseded mid-decode: the entry holds the blob (dispose will revoke
                // it on eviction); don't touch live content.
                return;
            }
            ctx.content.type = "image";
            ctx.content.url = blobUrl;
            resetImgView(ctx.window); // a fresh open lands at fit, like a normal image
            ctx.content.loading = false;
            ctx.content.error = null;
            ctx.requestRender();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (!token.isCurrent()) return;
            ctx.content.loading = false;
            ctx.content.error = String(e?.message || e);
            ctx.requestRender();
        });
}

function createState(): unknown {
    return {};
}
function resetState(): void {
    /* no rasterimage-specific view-state — it renders through the image viewer
       post-retype, which owns the zoom/pan slice keyed "image". */
}
function snapshot(): void {
    /* nothing format-specific to park (the image viewer parks its own zoom/pan) */
}
function restore(): void {
    /* nothing format-specific to restore */
}

/** Revoke the decoded blob: url when the cache entry is evicted, so a long session
 *  doesn't leak decoded bitmaps. By eviction time entry.type is "image" and
 *  entry.url is the blob: url (the loader retyped it); guard on the blob: scheme so
 *  we only ever revoke urls WE created, never a CDN url. */
function dispose(entry: CacheEntry): void {
    const u = entry.url;
    if (u && u.startsWith("blob:")) {
        try { URL.revokeObjectURL(u); } catch { /* already gone */ }
    }
}

export const RasterImageViewer: Viewer = {
    type: "rasterimage",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    dispose,
    // Body is never actually mounted for "rasterimage": load() retypes content.type to
    // "image" before the body renders, so the dispatcher routes to the image viewer's
    // Body. ImageBody is the right placeholder to satisfy the contract (it reads
    // content.url, which by then is the decoded blob). No HeaderControls / gallery /
    // editable here — those belong to the image viewer the retype hands off to.
    Body: ImageBody,
};
