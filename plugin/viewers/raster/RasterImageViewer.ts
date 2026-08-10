/*
 * The RASTER-IMAGE viewer — type "rasterimage".
 *
 * TIFF / PSD / HEIC can't be put into an <img src> directly (the browser has no
 * native decoder for them), so this loader does what the xlsx loader does for the
 * csv grid: it FETCHES the bytes, DECODES them per-format to an RGBA bitmap, paints
 * that to an offscreen <canvas>, exports a same-origin `blob:` PNG/JPEG url, and —
 * for SINGLE-image files — RETYPES the file to "image" so the existing image viewer
 * surface (fit-width, wheel-zoom, drag-pan, fullscreen lightbox) renders it.
 *
 *   tiff/tif  -> utif    (UTIF.decode lists every IFD = page; we decode the chosen one)
 *   psd       -> ag-psd  (readPsd → composited image, ANY bit depth 8/16/32 + Raw/RLE/Zip)
 *   heic/heif -> heic2any (libheif wasm → a PNG/JPEG Blob)
 *   tga       -> tga-js  (Tga.load → getImageData RGBA; we vertically flip bottom-origin
 *                         files ourselves — tga-js leaves them upside-down)
 *   ico/cur   -> icojs   (decodeIco → frames; we pick the LARGEST frame, whose .buffer is
 *                         already PNG bytes for the requested mime → straight to a blob)
 *   jp2/jpx/j2k/j2c -> jpeg2000 (pdf.js JpxImage.parse → interleaved component planes →
 *                         RGBA; parse() needs a Node Buffer view, not a bare Uint8Array)
 *   jxl       -> @jsquash/jxl (libjxl wasm → ImageData; codec + 849 KB wasm ship as the
 *                         out-of-bundle "jxl" chunk, and we hand the codec the wasm bytes
 *                         ourselves so it never fetches — Discord CSP would block that)
 *
 * MULTI-PAGE TIFF (the one case that KEEPS the "rasterimage" type instead of retyping):
 * UTIF.decode returns ALL pages. When there are 2+ pages we keep our own surface — the
 * image render surface wrapped with a small page selector (prev/next + "n / N"), the
 * way the xlsx viewer wraps the csv grid with a sheet switcher. The original TIFF bytes
 * + the page count live on the cache entry (entry.rasterTiff); flipping a page re-decodes
 * that page's IFD → RGBA → canvas → a fresh blob (memoised per page in entry.rasterPageUrls)
 * and re-points content.url at it, with NO re-fetch. The current page is parked in the
 * raster view-state so a cache return reopens the same page. A SINGLE-page TIFF has no
 * page chrome and retypes to "image" exactly as before.
 *
 * Every decoder is loaded with a DYNAMIC import() inside the per-format branch (utif +
 * heic2any inline, ag-psd as an out-of-bundle chunk), so none of them lands in the base
 * renderer eagerly — the code only loads when a file of that type is actually opened.
 *
 * blob: urls are same-origin and NOT subject to Discord's CSP connect-src, so once
 * decoded the picture renders anywhere. The urls are OWNED by this viewer: dispose()
 * revokes them on cache eviction (the single retyped renderUrl AND every page url
 * in entry.rasterPageUrls), so a long session doesn't leak decoded bitmaps.
 *
 * Cache contract (mirrors xlsx): the entry KEY stays "rasterimage|<cdn-url>" (set by
 * detectType at open time). For a single-image file we set renderType to "image" and
 * park the blob on renderUrl (a restore re-points the <img>). For a multi-page TIFF the
 * entry STAYS renderType "rasterimage" (so a restore routes back here, restores the page,
 * and re-blobs it) with renderUrl holding the initial decoded page's blob. The descriptor that re-keys a
 * restore derives its type from the original file NAME (e.g. "scan.tiff"), so the routing
 * type stays "rasterimage" and the key still matches.
 */

import { settings } from "../../settings";
import { getWindowCacheState } from "../../engine/cache";
import { revokeUniqueBlobUrls } from "../../engine/cacheOwnership";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, RasterViewState, Viewer, ViewerContext
} from "../../engine/types";
import { extOf } from "../../engine/detectType";
import { withLibLoading } from "../../engine/lazyLib";
import { resetImgView } from "../image/ImageBody";
import { RasterImageBody, rasterState, resetRasterView } from "./RasterImageBody";
import { RasterHeaderControls } from "./RasterHeaderControls";

/** A decoded bitmap: RGBA bytes laid out row-major (4 bytes/px), plus dimensions. */
interface Decoded {
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
}

/** A JPEG (lossy, far smaller) is used past this pixel count so a huge PSD/TIFF
 *  doesn't produce a multi-hundred-MB PNG data copy in the blob. Below it we keep
 *  PNG (lossless). 8 MP ≈ a 4K-ish frame. The user can override this to ALWAYS keep
 *  PNG via the Performance page's "large images losslessly" switch (see lossless()). */
const JPEG_PIXEL_THRESHOLD = 8_000_000;

/** Whether the user asked to keep LARGE frames lossless (PNG) instead of dropping to
 *  JPEG past the threshold. Read live at export time; defaults to false (the JPEG path)
 *  if settings aren't resolved yet. */
function lossless(): boolean {
    try {
        return settings.store.largeImageLossless === true;
    } catch {
        return false;
    }
}

/** Load utif once (lazy). The decoder is routed through the lazy-lib loader so the
 *  dock shows a labelled "Loading TIFF decoder…" while it spins up the first time. */
async function loadUtif(ctx: ViewerContext): Promise<any> {
    return withLibLoading(ctx, STRINGS.loading.lib.tiff, "utif",
        async () => (await import("utif")).default ?? (await import("utif")));
}

/** Count the pages (IFDs) in a TIFF without fully decoding pixels. UTIF.decode parses
 *  every IFD header (cheap — it does NOT decode the image data until decodeImage), so
 *  the list length is the page count. */
function tiffPageCount(UTIF: any, buf: ArrayBuffer): number {
    const ifds = UTIF.decode(buf);
    return Array.isArray(ifds) ? ifds.length : 0;
}

/** Decode ONE page (0-based IFD index) of a TIFF to RGBA. UTIF.decode re-lists the
 *  IFDs (cheap header parse); decodeImage + toRGBA8 decode the chosen page's pixels. */
function decodeTiffPage(UTIF: any, buf: ArrayBuffer, pageIndex: number): Decoded {
    const ifds = UTIF.decode(buf);
    if (!ifds || !ifds.length) throw new Error("No image in TIFF");
    const i = Math.min(Math.max(0, pageIndex), ifds.length - 1);
    const ifd = ifds[i];
    UTIF.decodeImage(buf, ifd);
    const rgba = UTIF.toRGBA8(ifd); // Uint8Array, length = w*h*4
    const width = ifd.width as number;
    const height = ifd.height as number;
    if (!width || !height) throw new Error("Empty TIFF frame");
    return { rgba: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height };
}

/**
 * Decode a PSD's composited (flattened) image with ag-psd. ag-psd is the only PSD
 * reader we found that handles every depth/compression chat throws at it — 8/16/32-bit
 * channels and Raw/RLE/Zip composite data — where the previous reader parse-threw on
 * Zip PSDs and its WASM compositor panicked on 16-bit.
 *
 * We read the composite with `useImageData: true` (ag-psd's "keep bytes, not a canvas"
 * mode) and normalise to 8-bit RGBA ourselves — see normalizeImageData for the exact
 * per-channel handling, which is the load-bearing part of the high-bit-depth support.
 * (ag-psd's own `psd.canvas` came out all-black for 16-bit PSDs in this renderer, so we
 * do NOT rely on it; useImageData gives the real pixels.)
 *
 * ag-psd loads as an out-of-bundle CHUNK (engine/chunkRegistry.ts) behind the "Loading
 * PSD decoder…" dock state, so its ~290 KB stays out of the base renderer.
 */
async function decodePsd(buf: ArrayBuffer, ctx: ViewerContext): Promise<Decoded> {
    const mod: any = await withLibLoading(ctx, STRINGS.loading.lib.psd, "ag-psd",
        async () => await import("ag-psd"));
    // ag-psd auto-installs a browser canvas factory when `document` exists; install it
    // explicitly + idempotently so any internal canvas use is deterministic.
    try {
        mod.initializeCanvas?.((w: number, h: number) => {
            const c = document.createElement("canvas");
            c.width = w; c.height = h;
            return c;
        });
    } catch { /* already initialized — fine */ }

    const psd: any = mod.readPsd(buf, {
        useImageData: true,
        skipLayerImageData: true,
        skipThumbnail: true
    });
    const width = psd.width as number;
    const height = psd.height as number;
    if (!width || !height) throw new Error("Empty PSD canvas");

    const id = psd.imageData;
    if (!id || !id.data) throw new Error("PSD has no composite image");
    const rgba = normalizeImageData(id.data, width, height);
    return { rgba, width, height };
}

/**
 * Normalise ag-psd's `useImageData` composite buffer to 8-bit RGBA (length w*h*4).
 *
 * ag-psd's useImageData output is NOT uniformly scaled across depths/channels:
 *   - 8-bit PSD  → Uint8ClampedArray/Uint8Array, all channels 0..255  → pass through.
 *   - 16-bit PSD → Uint16Array where the COLOUR channels (R,G,B) are already 8-bit-scaled
 *                  (0..255) but ALPHA is full 16-bit (0..65535). Scaling the whole array
 *                  by >> 8 turns the (already-byte) colours to ~0 → a black image (the bug
 *                  the first cut hit). So we detect per-channel: a channel whose max is
 *                  > 255 is 16-bit (scale by /257 → 0..255); a channel whose max is ≤ 255
 *                  is already a byte (pass through). This makes RGB pass through and ALPHA
 *                  down-convert — the correct result.
 *   - 32-bit PSD → Float32Array; same per-channel rule, but a float channel (max ≤ 1.0 for
 *                  normalised, or 0..255-ish) is scaled by its own max to fill 0..255.
 * Per-channel detection (not a single global rule) is what makes this robust to ag-psd's
 * mixed scaling without hard-coding "RGB is bytes, alpha is 16-bit".
 */
function normalizeImageData(data: ArrayLike<number>, width: number, height: number): Uint8ClampedArray {
    const need = width * height * 4;
    if (data.length < need) throw new Error("Truncated PSD pixel data");

    // Fast path: already an 8-bit byte buffer.
    if (data instanceof Uint8ClampedArray) return data;
    if (data instanceof Uint8Array) return new Uint8ClampedArray(data.buffer, data.byteOffset, need);

    const isFloat = data instanceof Float32Array || data instanceof Float64Array;

    // Per-channel max over the 4 interleaved channels (R,G,B,A), so each channel is scaled
    // by what it actually carries (ag-psd mixes byte colours with 16-bit alpha).
    const max = [0, 0, 0, 0];
    for (let i = 0; i < need; i++) {
        const c = i & 3;
        const v = data[i] as number;
        if (v > max[c]) max[c] = v;
    }
    // Per-channel scale to map that channel's range onto 0..255:
    //   byte channel (max ≤ 255, integer)  → factor 1 (pass through)
    //   16-bit channel (max > 255)         → 255 / max  (≈ /257 for full-scale 65535)
    //   float channel                      → 255 / max  (normalises 0..max → 0..255)
    const scale = max.map(m => {
        if (m <= 0) return 0;
        if (!isFloat && m <= 255) return 1; // already a byte
        return 255 / m;
    });

    const out = new Uint8ClampedArray(need);
    for (let i = 0; i < need; i++) {
        const c = i & 3;
        const f = scale[c];
        out[i] = f === 1 ? (data[i] as number) : Math.round((data[i] as number) * f);
    }
    // A fully-opaque image whose alpha channel was absent (max 0) must not render fully
    // transparent: if alpha came through as all-zero, force it opaque.
    if (max[3] === 0) {
        for (let i = 3; i < need; i += 4) out[i] = 255;
    }
    return out;
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
    // Past the threshold we drop to JPEG to keep the in-memory blob small — UNLESS the
    // user turned on lossless large images, which keeps PNG at any size (bigger blob).
    const huge = d.width * d.height > JPEG_PIXEL_THRESHOLD && !lossless();
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
async function heicToBlobUrl(buf: ArrayBuffer, ctx: ViewerContext): Promise<{ url: string }> {
    const heic2any: any = await withLibLoading(ctx, STRINGS.loading.lib.heic, "heic2any",
        async () => (await import("heic2any")).default);
    const out = await heic2any({ blob: new Blob([buf]), toType: "image/png" });
    const blob: Blob = Array.isArray(out) ? out[0] : out; // multi-image HEIC → first frame
    if (!blob) throw new Error("HEIC produced no image");
    return { url: URL.createObjectURL(blob) };
}

/**
 * Decode a TGA (Truevision Targa) to RGBA with tga-js. tga-js's Tga.load parses the
 * header + pixel data; getImageData() writes RGBA into the buffer we hand it.
 *
 * ORIGIN FLIP (the load-bearing correctness fix): a TGA stores its origin in header
 * flag bit 5 (0x20) — set = top-left origin, clear = BOTTOM-left (the common default
 * ImageMagick / Photoshop write). tga-js's getImageData does NOT correctly un-flip a
 * bottom-origin file (verified: a bottom-origin Targa comes out vertically mirrored),
 * so we flip the rows ourselves when bit 5 is clear. A top-origin file is left as-is.
 */
async function decodeTga(buf: ArrayBuffer, ctx: ViewerContext): Promise<Decoded> {
    const TgaCtor: any = await withLibLoading(ctx, STRINGS.loading.lib.tga, "tga-js",
        async () => (await import("tga-js")).default);
    const tga = new TgaCtor();
    tga.load(new Uint8Array(buf));
    const width = tga.header?.width as number;
    const height = tga.header?.height as number;
    if (!width || !height) throw new Error("Empty TGA frame");
    const out = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    tga.getImageData(out);
    let rgba = out.data;
    // bit 5 clear ⇒ bottom-origin ⇒ flip rows so the image is top-down (browser order).
    const topOrigin = !!((tga.header.flags as number) & 0x20);
    if (!topOrigin) {
        const rowBytes = width * 4;
        const flipped = new Uint8ClampedArray(rgba.length);
        for (let y = 0; y < height; y++) {
            flipped.set(rgba.subarray(y * rowBytes, y * rowBytes + rowBytes), (height - 1 - y) * rowBytes);
        }
        rgba = flipped;
    }
    return { rgba, width, height };
}

/**
 * Decode an ICO/CUR to a blob: url with icojs. decodeIco returns every frame; the
 * browser build's converter hands each frame's pixels back already RE-ENCODED to the
 * requested mime (image/png), so a frame's `.buffer` is PNG bytes — we pick the
 * LARGEST frame (most pixels) and wrap its PNG buffer straight as a blob: url, no
 * second canvas round-trip. (icojs uses createImageBitmap internally, a browser API,
 * so this path only runs in the renderer, never headless.)
 */
async function icoToBlobUrl(buf: ArrayBuffer, ctx: ViewerContext): Promise<{ url: string }> {
    const mod: any = await withLibLoading(ctx, STRINGS.loading.lib.ico, "icojs",
        async () => await import("icojs"));
    const decodeIco = mod.decodeIco ?? mod.default?.decodeIco;
    if (typeof decodeIco !== "function") throw new Error("icojs decoder unavailable");
    const frames: Array<{ width: number; height: number; buffer: ArrayBuffer }> =
        await decodeIco(buf, "image/png");
    if (!frames || !frames.length) throw new Error("No image in icon");
    const largest = frames.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    if (!largest.buffer || !largest.buffer.byteLength) throw new Error("Empty icon frame");
    const blob = new Blob([largest.buffer], { type: "image/png" });
    return { url: URL.createObjectURL(blob) };
}

/**
 * Decode a JPEG 2000 (.jp2/.jpx/.j2k/.j2c) to RGBA with the pdf.js JpxImage port.
 * parse() reads the codestream OR the JP2 box container; afterwards width/height/
 * componentsCount + tiles[0].items (the interleaved component samples, length =
 * w*h*componentsCount) describe the image. We fold the component planes to RGBA:
 *   1 comp → greyscale, 3 → RGB, 4 → RGBA (CMYK is rare from chat tools; treat the
 *   4th plane as alpha, which matches an RGBA-origin .jp2).
 *
 * BUFFER REQUIREMENT (the load-bearing browser fix): JpxImage reads the input with
 * Node Buffer methods (data.readInt8 / readUInt16BE / readUInt32BE), which a bare
 * Uint8Array does NOT have — parse(new Uint8Array(buf)) throws "readUInt16BE is not a
 * function". Rather than pull in the node `buffer` polyfill (Vencord's browser build
 * BANS node builtins), we hand parse() a tiny Uint8Array SUBCLASS that adds exactly the
 * three big-endian readers it calls — keeping all native Uint8Array behaviour (indexing,
 * .length, .subarray) the decoder also relies on. This is the minimal, dependency-free
 * way to satisfy the lib's Node-Buffer expectation in the browser.
 */
class BufferLikeBytes extends Uint8Array {
    readInt8(o: number): number { return (this[o] << 24) >> 24; }
    readUInt16BE(o: number): number { return (this[o] << 8) | this[o + 1]; }
    readUInt32BE(o: number): number {
        return ((this[o] << 24) | (this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]) >>> 0;
    }
}

/**
 * Decode a JPEG-XL (.jxl) to RGBA with @jsquash/jxl (the Squoosh libjxl codec). The
 * codec + its 849 KB jxl_dec.wasm ship as the out-of-bundle "jxl" CHUNK
 * (engine/chunks/jxl.entry.ts), loaded here on first .jxl open behind the "Loading
 * JPEG XL decoder…" dock state — keeping the wasm off the base renderer + every Vesktop
 * startup.
 *
 * WASM HANDOFF (the load-bearing CSP fix): the codec's default path fetches
 * `new URL("jxl_dec.wasm", import.meta.url)`, which Discord's CSP connect-src BLOCKS in
 * the renderer (and which throws "fetch failed" even headless). @jsquash/jxl's init()
 * accepts a WebAssembly.Module as its first argument and wires it through Emscripten's
 * instantiateWasm hook (no fetch). The chunk carries the raw wasm bytes (esbuild binary
 * loader) as `mod.wasm`; we compile a WebAssembly.Module from them ONCE per session
 * (memoised) and init() the codec with it, then decode(buffer) → ImageData. This mirrors
 * how the HEIC path hands libheif its own wasm rather than letting it fetch.
 */
let jxlInited: Promise<void> | null = null;
async function decodeJxl(buf: ArrayBuffer, ctx: ViewerContext): Promise<Decoded> {
    const mod: any = await withLibLoading(ctx, STRINGS.loading.lib.jxl, "jxl",
        async () => await import("@jsquash/jxl/decode"));
    // The chunk exposes { init, decode, wasm }. Compile + init the codec with OUR wasm
    // bytes exactly once per session so it never fetches; concurrent first opens share
    // the one init via the cached promise.
    if (!jxlInited) {
        jxlInited = (async () => {
            const bytes: Uint8Array = mod.wasm;
            if (!bytes || !bytes.byteLength) throw new Error("JPEG XL codec wasm missing from chunk");
            const wasmModule = await WebAssembly.compile(bytes);
            // Pass a no-op locateFile so the codec takes its `Module["locateFile"]`
            // branch ("jxl_dec.wasm" → locateFile(...)) instead of the else branch,
            // which does `new URL("jxl_dec.wasm", import.meta.url)`. In the eval'd chunk
            // `import.meta.url` is undefined, so that `new URL` throws "Invalid URL"
            // BEFORE our instantiateWasm short-circuits the (never-run) fetch — verified
            // live. With locateFile set, wasmBinaryFile is just a harmless string and our
            // WebAssembly.Module is what actually instantiates (no fetch). (`p => p`.)
            await mod.init(wasmModule, { locateFile: (p: string) => p });
        })().catch(e => { jxlInited = null; throw e; });
    }
    await jxlInited;
    const image: { data: ArrayLike<number>; width: number; height: number } = await mod.decode(buf);
    const width = image.width;
    const height = image.height;
    if (!width || !height) throw new Error("Empty JPEG XL frame");
    const src = image.data;
    const rgba = src instanceof Uint8ClampedArray
        ? src
        : new Uint8ClampedArray(width * height * 4);
    if (!(src instanceof Uint8ClampedArray)) {
        for (let i = 0; i < rgba.length; i++) rgba[i] = src[i] as number;
    }
    return { rgba, width, height };
}

async function decodeJp2(buf: ArrayBuffer, ctx: ViewerContext): Promise<Decoded> {
    const mod: any = await withLibLoading(ctx, STRINGS.loading.lib.jp2, "jpeg2000",
        async () => await import("jpeg2000"));
    const JpxImage = mod.JpxImage ?? mod.default?.JpxImage;
    if (typeof JpxImage !== "function") throw new Error("JPEG 2000 decoder unavailable");
    const jpx = new JpxImage();
    jpx.parse(new BufferLikeBytes(buf));
    const width = jpx.width as number;
    const height = jpx.height as number;
    const comps = jpx.componentsCount as number;
    const tile = jpx.tiles && jpx.tiles[0];
    if (!width || !height || !tile || !tile.items) throw new Error("Empty JPEG 2000 frame");
    const items: ArrayLike<number> = tile.items;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, p = 0; i < width * height; i++) {
        const s = i * comps;
        if (comps >= 3) {
            rgba[p++] = items[s];
            rgba[p++] = items[s + 1];
            rgba[p++] = items[s + 2];
            rgba[p++] = comps >= 4 ? items[s + 3] : 255;
        } else {
            const g = items[s];
            rgba[p++] = g; rgba[p++] = g; rgba[p++] = g; rgba[p++] = 255;
        }
    }
    return { rgba, width, height };
}

/**
 * Re-blob a specific page of an already-decoded multi-page TIFF and point the live
 * content.url (+ entry.renderUrl) at it. Used by the page selector: it re-decodes the chosen
 * IFD from the cached TIFF bytes (no re-fetch), memoising the blob per page on the
 * entry so flipping back is instant. Returns the blob url. Throws if the page can't be
 * decoded (the caller surfaces it). The utif lib is already loaded by the initial open.
 */
export async function blobForTiffPage(entry: CacheEntry, ctx: ViewerContext, pageIndex0: number): Promise<string> {
    const tiff = entry.rasterTiff;
    if (!tiff) throw new Error("No TIFF source on entry");
    const urls = entry.rasterPageUrls || (entry.rasterPageUrls = []);
    const cached = urls[pageIndex0];
    if (cached) return cached;
    const UTIF = await loadUtif(ctx);
    const decoded = decodeTiffPage(UTIF, tiff.buf, pageIndex0);
    const { url } = await rgbaToBlobUrl(decoded);
    urls[pageIndex0] = url;
    return url;
}

/** RASTER-IMAGE loader: fetch bytes → decode per ext. SINGLE-image files (psd / heic /
 *  single-page tiff) retype to "image"; a MULTI-page tiff keeps the "rasterimage" type
 *  and drives a page selector over the image surface. Always writes the cache `entry`
 *  (even when superseded, so dispose can revoke the blob), only writes live `content`
 *  while the token is current. */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    resetRasterView(ctx.window);
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
            if (ext === "tiff" || ext === "tif") {
                await loadTiff(buf, opts, token, entry, ctx);
                return;
            }
            // Single-image formats: decode → blob → retype to "image".
            let blobUrl: string;
            if (ext === "heic" || ext === "heif") {
                blobUrl = (await heicToBlobUrl(buf, ctx)).url;
            } else if (ext === "psd") {
                blobUrl = (await rgbaToBlobUrl(await decodePsd(buf, ctx))).url;
            } else if (ext === "tga") {
                blobUrl = (await rgbaToBlobUrl(await decodeTga(buf, ctx))).url;
            } else if (ext === "ico" || ext === "cur") {
                blobUrl = (await icoToBlobUrl(buf, ctx)).url;
            } else if (ext === "jp2" || ext === "jpx" || ext === "j2k" || ext === "j2c") {
                blobUrl = (await rgbaToBlobUrl(await decodeJp2(buf, ctx))).url;
            } else if (ext === "jxl") {
                blobUrl = (await rgbaToBlobUrl(await decodeJxl(buf, ctx))).url;
            } else {
                // any other raster ext that mapped here without a branch — treat as PSD
                // (the only remaining single-image decoder) rather than silently failing.
                blobUrl = (await rgbaToBlobUrl(await decodePsd(buf, ctx))).url;
            }
            finishAsImage(blobUrl, token, entry, ctx);
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

/** Decode a TIFF: count pages, decode the FIRST page (or the cache-restored page), and
 *  either retype to "image" (single page) or keep "rasterimage" with the page state +
 *  the source bytes parked on the entry for page switching (multi-page). */
async function loadTiff(buf: ArrayBuffer, _opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): Promise<void> {
    const UTIF = await loadUtif(ctx);
    const pages = tiffPageCount(UTIF, buf);
    if (!pages) throw new Error("No image in TIFF");

    const vs = rasterState(ctx.window);
    // The page to open: a cache restore set vs.page via restore(); clamp into range.
    // A fresh open lands on page 1.
    const startPage = Math.min(Math.max(1, vs.page || 1), pages);
    const decoded = decodeTiffPage(UTIF, buf, startPage - 1);
    const { url } = await rgbaToBlobUrl(decoded);

    if (pages <= 1) {
        // Single-page TIFF — behave exactly like before (plain image surface, no nav).
        finishAsImage(url, token, entry, ctx);
        return;
    }

    // Multi-page TIFF — keep the "rasterimage" surface (image + page selector). Park the
    // source bytes + page count on the entry so page switches re-blob with no re-fetch.
    if (entry) {
        const state = getWindowCacheState(ctx.window, entry.key)!;
        entry.renderType = "rasterimage";
        state.view.rasterPage = startPage;
        state.renderUrl = url;
        // Keep the decoded initial page on the shared payload. A fresh window derives
        // its own page/render URL overlay from this blob's index in rasterPageUrls.
        entry.renderUrl = url;
        entry.rasterTiff = { buf, pages };
        entry.rasterPageUrls = [];
        entry.rasterPageUrls[startPage - 1] = url;
        entry.loading = false;
        entry.error = null;
    }
    if (!token.isCurrent()) return;
    vs.total = pages;
    vs.page = startPage;
    ctx.content.type = "rasterimage";
    ctx.content.url = url;
    resetImgView(ctx.window); // a fresh open lands at fit, like a normal image
    ctx.content.loading = false;
    ctx.content.loadingLabel = null;
    ctx.content.error = null;
    ctx.requestRender();
}

/** Park a decoded single-image blob on the entry as an "image" and (if current) point
 *  live content at it, retyping to the image viewer surface. */
function finishAsImage(blobUrl: string, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
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
}

function createState(): RasterViewState {
    return { page: 1, total: 1 };
}
function resetState(vs: RasterViewState): void {
    if (!vs) return;
    vs.page = 1;
    vs.total = 1;
}

/** Park the current TIFF page on the entry so a cache return reopens it on the same
 *  page (single-image files retype to "image" before this fires and never reach here). */
function snapshot(vs: RasterViewState, entry: CacheEntry): void {
    if (entry.renderType !== "rasterimage") return;
    entry.view.rasterPage = vs?.page ?? 1;
}

/** Restore the saved TIFF page on a cache return. The total is re-derived from the
 *  cached source bytes (entry.rasterTiff.pages) so the selector is right before the
 *  body mounts; the page is clamped into range. */
function restore(vs: RasterViewState, entry: CacheEntry): void {
    if (!vs) return;
    const pages = entry.rasterTiff?.pages ?? 1;
    vs.total = pages;
    vs.page = Math.min(Math.max(1, entry.view.rasterPage ?? 1), Math.max(1, pages));
}

/** Revoke every decoded blob: url this viewer created when the cache entry is evicted.
 *  A single-image file leaves one URL on entry.renderUrl (entry.renderType === "image"); a multi-
 *  page TIFF leaves the per-page urls in entry.rasterPageUrls (entry.type stays
 *  "rasterimage", entry.renderUrl is one of those page urls). Guard on the blob: scheme so we
 *  only ever revoke urls WE created, never a CDN url. */
function dispose(entry: CacheEntry): void {
    revokeUniqueBlobUrls(
        [entry.renderUrl, ...(entry.rasterPageUrls ?? [])],
        url => { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
    );
    entry.rasterPageUrls = [];
    entry.rasterTiff = null;
}

export const RasterImageViewer: Viewer<RasterViewState> = {
    type: "rasterimage",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    dispose,
    // For a SINGLE-image file load() retypes content.type to "image" before the body
    // renders, so the dispatcher routes to the image viewer's Body — this Body is never
    // mounted for those. For a MULTI-page TIFF content.type stays "rasterimage", so the
    // dispatcher mounts RasterImageBody (the image surface + a page selector) and
    // RasterHeaderControls (the image controls + page nav).
    Body: RasterImageBody,
    HeaderControls: RasterHeaderControls,
    // The multi-page surface renders the same <img> the image viewer uses (sits in
    // .dockview-body) — the default scroller is correct.
    capabilities: { openInWindow: true }
};
