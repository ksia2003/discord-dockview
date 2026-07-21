/*
 * The DICOM viewer — type "dicom".
 *
 * .dcm / .dicom is a DICOM Part-10 medical-image file (CT/MR/X-ray/ultrasound): a
 * header of tagged data elements followed by the raw PIXEL DATA, usually a single
 * 16-bit grayscale slice. There is no browser-native decoder, so — exactly like the
 * raster decoders (tiff/psd/heic) and the DXF→image retype — this loader FETCHES the
 * bytes, PARSES the data set with dicom-parser, reads the pixels + the windowing
 * metadata, maps the (typically 16-bit) samples to 8-bit RGBA with a rescale +
 * window/level transform, paints that to an offscreen <canvas>, exports a same-origin
 * `blob:` PNG url, and RETYPES the file to "image" so the existing image viewer surface
 * (fit-width, wheel-zoom, drag-pan, fullscreen lightbox, rotate) renders the slice —
 * for free, with no second surface to maintain.
 *
 * WHY dicom-parser SHIPS AS A CHUNK: it is small (~32 KB minified, a pure byte→data-set
 * parser), but its source carries a bare `require("zlib")` (used only for the rare
 * deflated transfer syntax). Vencord's esbuild ban-imports plugin scans that literal and
 * rejects it BEFORE the package's `browser:{zlib:false}` field can stub it, so the lib
 * cannot be bundled inline. It is therefore listed in engine/chunkRegistry.ts and shipped
 * as the out-of-bundle chunk-dicomparser.js — externalized from the renderer (so
 * ban-imports never sees the require) and loaded on first .dcm open over the readChunk IPC
 * behind the "Loading DICOM viewer…" dock state, exactly like ag-psd / the pptx renderer.
 * (This is the same chunk-external mechanism every lib whose source trips ban-imports
 * uses; an inline build of dicom-parser is impossible for that reason.)
 *
 * THE PIXEL PIPELINE (the load-bearing correctness bits):
 *   - Transfer syntax (0002,0010) decides the encoding. We handle the UNCOMPRESSED
 *     ones — Implicit VR LE (1.2.840.10008.1.2), Explicit VR LE (…1.2.1), Explicit VR
 *     Big Endian (…1.2.2, deprecated) — and RLE (…1.2.5, a cheap byte-level decode).
 *     COMPRESSED syntaxes (JPEG Baseline/2000/-LS) need heavy codecs we deliberately
 *     don't pull into the renderer, so they surface an honest "compressed DICOM not
 *     supported — download" notice rather than garbage.
 *   - BitsAllocated (0028,0100) = the storage word size (8 or 16). PixelRepresentation
 *     (0028,0103) = 0 unsigned / 1 signed two's-complement → we read the samples as
 *     Uint8/Int16/Uint16 accordingly. BitsStored/HighBit are respected via the value
 *     range the window maps, not masked (real files set BitsStored ≤ BitsAllocated).
 *   - Rescale: stored value → modality value via slope*v + intercept (0028,1053/1052),
 *     e.g. CT Hounsfield units. Applied BEFORE windowing so a window center/width in HU
 *     lines up with the rescaled samples.
 *   - Window/level: WindowCenter (0028,1050) / WindowWidth (0028,1051) define the
 *     contrast ramp (DICOM PS3.3 C.11.2.1.2): below center-width/2 → black, above
 *     center+width/2 → white, linear between. If the file carries no window we
 *     AUTO-window from the actual min/max of the rescaled samples so the image is
 *     always visible (never all-black/all-white).
 *   - Photometric (0028,0004): MONOCHROME1 means min value = WHITE (inverted), so we
 *     flip the ramp; MONOCHROME2 is the normal min=black. RGB / YBR colour images are
 *     painted directly (no window). PALETTE COLOR is a rare LUT case left as a gap.
 *   - Multi-frame (0028,0008 NumberOfFrames > 1): v1 decodes and shows the FIRST frame
 *     (the slice most files carry); a frame selector like the multi-page TIFF nav is a
 *     deferred enhancement (noted in the registry).
 *
 * Single slice in / single image out: this viewer ALWAYS retypes to "image" (no own
 * surface for v1), so its Body never actually mounts — the dispatcher routes to the
 * image viewer once content.type flips. We still supply a placeholder Body to satisfy
 * the Viewer contract, and a dispose() that revokes the blob: url we created.
 *
 * Cache contract (mirrors the DXF / single-image raster path): the entry KEY stays
 * "dicom|<cdn-url>" (set by detectType at open time); we retype entry.type to "image"
 * and park the blob on entry.url so a restore re-points the <img>. The restore
 * descriptor derives its type from the file NAME (".dcm"), so routing type stays "dicom"
 * and the key still matches; dispose revokes the blob on eviction.
 */

import { STRINGS } from "../../strings";
import type { CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext } from "../../engine/types";
import { extOf } from "../../engine/detectType";
import { withLibLoading } from "../../engine/lazyLib";
import { resetImgView } from "../image/ImageBody";
import { DicomPlaceholderBody } from "./DicomBody";

/** Past this many pixels the export uses JPEG (lossy, far smaller) so a huge slice
 *  doesn't balloon into a multi-hundred-MB PNG blob. Mirrors the raster viewer. */
const JPEG_PIXEL_THRESHOLD = 8_000_000;

/** Compressed transfer syntaxes we intentionally do NOT decode in the renderer (they
 *  need heavy JPEG/JPEG2000/JPEG-LS codecs). A file in one of these surfaces the honest
 *  "compressed DICOM not supported" notice rather than a garbled image. */
const COMPRESSED_TRANSFER_SYNTAXES = new Set<string>([
    "1.2.840.10008.1.2.4.50", // JPEG Baseline (Process 1)
    "1.2.840.10008.1.2.4.51", // JPEG Extended (Process 2 & 4)
    "1.2.840.10008.1.2.4.57", // JPEG Lossless, Non-Hierarchical (Process 14)
    "1.2.840.10008.1.2.4.70", // JPEG Lossless, Non-Hierarchical, First-Order Prediction
    "1.2.840.10008.1.2.4.80", // JPEG-LS Lossless
    "1.2.840.10008.1.2.4.81", // JPEG-LS Lossy (Near-Lossless)
    "1.2.840.10008.1.2.4.90", // JPEG 2000 Lossless
    "1.2.840.10008.1.2.4.91", // JPEG 2000
    "1.2.840.10008.1.2.4.92", // JPEG 2000 Part 2 Multi-component Lossless
    "1.2.840.10008.1.2.4.93", // JPEG 2000 Part 2 Multi-component
    "1.2.840.10008.1.2.4.94", // JPIP Referenced
    "1.2.840.10008.1.2.4.95", // JPIP Referenced Deflate
    "1.2.840.10008.1.2.4.100", // MPEG2
    "1.2.840.10008.1.2.4.102", // MPEG-4 AVC/H.264
    "1.2.840.10008.1.2.4.103" // MPEG-4 AVC/H.264 BD
]);

/** The RLE transfer syntax — uncompressed-class for our purposes (a cheap byte decode). */
const RLE_TRANSFER_SYNTAX = "1.2.840.10008.1.2.5";
/** Explicit VR Big Endian (retired) — uncompressed but big-endian word order. */
const EXPLICIT_BIG_ENDIAN = "1.2.840.10008.1.2.2";

/** A decoded grayscale frame as floats (already rescaled to modality units) + the
 *  value range, ready for windowing; OR a directly-painted colour frame as RGBA. */
interface GrayFrame { gray: Float32Array; min: number; max: number; width: number; height: number; }
interface ColorFrame { rgba: Uint8ClampedArray; width: number; height: number; }

/** Read SamplesPerPixel etc. from the data set, with sane defaults. dicom-parser's
 *  dataSet exposes typed accessors: uint16(tag) / intString(tag) / floatString(tag) /
 *  string(tag). Tags are the lowercase "xGGGGEEEE" form ("x00280010" = Rows). */
function tag(group: number, element: number): string {
    const g = group.toString(16).padStart(4, "0");
    const e = element.toString(16).padStart(4, "0");
    return "x" + g + e;
}

/** First numeric value of a possibly multi-valued (backslash-separated) DICOM string
 *  element. WindowCenter/Width are VR DS (decimal string) and can be multi-valued (one
 *  per window preset); we take the first preset. Returns null if absent/unparseable. */
function firstFloat(ds: any, group: number, element: number): number | null {
    const raw = ds.string(tag(group, element));
    if (raw == null || raw === "") return null;
    const first = String(raw).split("\\")[0].trim();
    const n = parseFloat(first);
    return Number.isFinite(n) ? n : null;
}

/** Read a pixel sample array view over the PixelData element's bytes, honouring
 *  BitsAllocated (8/16), PixelRepresentation (signed/unsigned) and endianness. Returns
 *  a typed array (Int16Array/Uint16Array/Uint8Array) whose length is the sample count.
 *  For 16-bit big-endian data we byte-swap into a fresh buffer first. */
function readSamples(
    bytes: Uint8Array,
    offset: number,
    sampleCount: number,
    bitsAllocated: number,
    signed: boolean,
    bigEndian: boolean
): Int16Array | Uint16Array | Uint8Array {
    if (bitsAllocated <= 8) {
        const sub = bytes.subarray(offset, offset + sampleCount);
        return signed
            ? Int16Array.from(new Int8Array(sub.buffer, sub.byteOffset, sampleCount))
            : new Uint8Array(sub.buffer.slice(sub.byteOffset, sub.byteOffset + sampleCount));
    }
    // 16-bit: build a correctly-aligned, native-endian copy.
    const out16 = signed ? new Int16Array(sampleCount) : new Uint16Array(sampleCount);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, sampleCount * 2);
    for (let i = 0; i < sampleCount; i++) {
        out16[i] = signed ? dv.getInt16(i * 2, !bigEndian) : dv.getUint16(i * 2, !bigEndian);
    }
    return out16;
}

/** Decode an RLE-encoded (1.2.840.10008.1.2.5) single segment's bytes (PackBits) into
 *  `out` starting at `outStart`, stepping `stride` bytes per written value (so a 16-bit
 *  sample's two segments interleave into the high/low byte planes). Returns when the
 *  requested number of values is produced. */
function decodeRleSegment(src: Uint8Array, out: Uint8Array, outStart: number, stride: number, count: number): void {
    let i = 0;
    let written = 0;
    let o = outStart;
    while (i < src.length && written < count) {
        const n = src[i++];
        if (n < 128) {
            // literal run of (n+1) bytes
            const run = n + 1;
            for (let k = 0; k < run && written < count; k++) {
                out[o] = src[i++];
                o += stride;
                written++;
            }
        } else if (n > 128) {
            // replicate the next byte (257 - n) times
            const run = 257 - n;
            const val = src[i++];
            for (let k = 0; k < run && written < count; k++) {
                out[o] = val;
                o += stride;
                written++;
            }
        } else {
            // n === 128 → no-op
        }
    }
}

/** Decode RLE PixelData (encapsulated: one fragment holding the RLE Header + segments)
 *  into a flat byte plane laid out as native-endian samples. DICOM RLE stores each byte
 *  plane of a sample as its own segment, MOST-significant plane first; for 16-bit data
 *  segment 0 → high byte, segment 1 → low byte of each little-endian sample. */
function decodeRle(fragment: Uint8Array, sampleCount: number, bitsAllocated: number): Uint8Array {
    const bytesPerSample = bitsAllocated <= 8 ? 1 : 2;
    const out = new Uint8Array(sampleCount * bytesPerSample);
    const dv = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
    const numSegments = dv.getUint32(0, true);
    for (let seg = 0; seg < numSegments && seg < bytesPerSample; seg++) {
        const segOffset = dv.getUint32(4 + seg * 4, true);
        const nextOffset = seg + 1 < numSegments ? dv.getUint32(4 + (seg + 1) * 4, true) : fragment.byteLength;
        const segBytes = fragment.subarray(segOffset, nextOffset || fragment.byteLength);
        // For 16-bit: segment 0 = high byte plane, segment 1 = low byte plane. We write
        // into a little-endian output, so the high byte goes to odd indices, low to even.
        const planeStart = bytesPerSample === 1 ? 0 : (bytesPerSample - 1 - seg);
        decodeRleSegment(segBytes, out, planeStart, bytesPerSample, sampleCount);
    }
    return out;
}

/** Apply slope/intercept rescale to the raw samples → modality-value floats, tracking
 *  the min/max so an absent window can auto-fit. */
function rescaleToGray(samples: ArrayLike<number>, count: number, slope: number, intercept: number): GrayFrame {
    const gray = new Float32Array(count);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < count; i++) {
        const v = samples[i] * slope + intercept;
        gray[i] = v;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (!Number.isFinite(min)) { min = 0; max = 1; }
    return { gray, min, max, width: 0, height: 0 };
}

/** Window a grayscale frame to 8-bit RGBA using the DICOM linear ramp. `center`/`width`
 *  are in the same (rescaled, modality) units as frame.gray. `invert` flips the ramp
 *  for MONOCHROME1. Returns RGBA bytes (length w*h*4). */
function windowToRgba(frame: GrayFrame, center: number, width: number, invert: boolean): Uint8ClampedArray {
    const { gray, width: w, height: h } = frame;
    const n = w * h;
    const rgba = new Uint8ClampedArray(n * 4);
    // DICOM PS3.3 C.11.2.1.2 linear window: ymin=0, ymax=255. Guard width ≥ 1.
    const ww = Math.max(1, width);
    const low = center - 0.5 - (ww - 1) / 2;
    const scale = 255 / (ww - 1);
    for (let i = 0, p = 0; i < n; i++) {
        let g: number;
        const v = gray[i];
        if (v <= low) g = 0;
        else if (v > low + (ww - 1)) g = 255;
        else g = Math.round((v - low) * scale);
        if (invert) g = 255 - g;
        rgba[p++] = g;
        rgba[p++] = g;
        rgba[p++] = g;
        rgba[p++] = 255;
    }
    return rgba;
}

/** Paint RGBA → an offscreen canvas → a blob: url (PNG, or JPEG past the pixel
 *  threshold so a huge frame doesn't balloon). Mirrors the raster viewer's exporter. */
function rgbaToBlobUrl(rgba: Uint8ClampedArray, width: number, height: number): Promise<string> {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const cx = canvas.getContext("2d");
    if (!cx) throw new Error("No 2D canvas context");
    const expected = width * height * 4;
    if (rgba.length < expected) throw new Error("Truncated DICOM pixel data");
    cx.putImageData(new ImageData(rgba.subarray(0, expected), width, height), 0, 0);
    const huge = width * height > JPEG_PIXEL_THRESHOLD;
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            blob => {
                if (!blob) { reject(new Error("Canvas export failed")); return; }
                resolve(URL.createObjectURL(blob));
            },
            huge ? "image/jpeg" : "image/png",
            huge ? 0.92 : undefined
        );
    });
}

/** Paint a colour (RGB / YBR-converted) frame straight to a blob, no windowing. */
function colorToBlobUrl(frame: ColorFrame): Promise<string> {
    return rgbaToBlobUrl(frame.rgba, frame.width, frame.height);
}

/** Convert a planar/interleaved RGB or YBR colour first frame to RGBA. SamplesPerPixel
 *  is 3; PlanarConfiguration 0 = interleaved R,G,B per pixel, 1 = three colour planes.
 *  YBR_FULL/YBR_FULL_422 are converted to RGB (the common ultrasound/secondary-capture
 *  colour photometrics). */
function colorFrameToRgba(
    samples: Uint8Array,
    width: number,
    height: number,
    planar: number,
    photometric: string
): Uint8ClampedArray {
    const n = width * height;
    const rgba = new Uint8ClampedArray(n * 4);
    const isYbr = photometric.startsWith("YBR");
    for (let i = 0, p = 0; i < n; i++) {
        let r: number, g: number, b: number;
        if (planar === 1) {
            r = samples[i];
            g = samples[n + i];
            b = samples[2 * n + i];
        } else {
            r = samples[i * 3];
            g = samples[i * 3 + 1];
            b = samples[i * 3 + 2];
        }
        if (isYbr) {
            // YBR_FULL → RGB (ITU-R BT.601). Y=r, Cb=g, Cr=b in the read order above.
            const Y = r, Cb = g - 128, Cr = b - 128;
            r = Y + 1.402 * Cr;
            g = Y - 0.344136 * Cb - 0.714136 * Cr;
            b = Y + 1.772 * Cb;
        }
        rgba[p++] = r;
        rgba[p++] = g;
        rgba[p++] = b;
        rgba[p++] = 255;
    }
    return rgba;
}

/** Parse + window a DICOM to a blob: url. Returns the url, or throws (compressed/
 *  unsupported → a clear message the loader shows). */
async function dicomToBlobUrl(buf: ArrayBuffer, ctx: ViewerContext): Promise<string> {
    const dicomParser: any = await withLibLoading(ctx, STRINGS.loading.lib.dicom, "dicom-parser",
        async () => (await import("dicom-parser")).default ?? (await import("dicom-parser")));

    const bytes = new Uint8Array(buf);
    let ds: any;
    try {
        ds = dicomParser.parseDicom(bytes);
    } catch (e) {
        throw new Error("Couldn't parse the DICOM file: " + ((e as Error)?.message ?? e));
    }

    const transferSyntax = (ds.string(tag(0x0002, 0x0010)) || "").trim();
    if (COMPRESSED_TRANSFER_SYNTAXES.has(transferSyntax)) {
        // Honest gap: compressed pixel data needs a codec we don't ship in the renderer.
        throw new Error(STRINGS.dicom.compressed);
    }

    const pixelElement = ds.elements[tag(0x7fe0, 0x0010)];
    if (!pixelElement) throw new Error("This DICOM has no pixel data to show");

    const rows = ds.uint16(tag(0x0028, 0x0010)) || 0;
    const cols = ds.uint16(tag(0x0028, 0x0011)) || 0;
    if (!rows || !cols) throw new Error("This DICOM has no image dimensions");

    const samplesPerPixel = ds.uint16(tag(0x0028, 0x0002)) || 1;
    const bitsAllocated = ds.uint16(tag(0x0028, 0x0100)) || 16;
    const pixelRepresentation = ds.uint16(tag(0x0028, 0x0103)) || 0; // 1 = signed
    const planar = ds.uint16(tag(0x0028, 0x0006)) || 0;
    const photometric = (ds.string(tag(0x0028, 0x0004)) || "MONOCHROME2").trim().toUpperCase();
    const numFrames = parseInt(ds.string(tag(0x0028, 0x0008)) || "1", 10) || 1;
    const slope = firstFloat(ds, 0x0028, 0x1053) ?? 1; // RescaleSlope
    const intercept = firstFloat(ds, 0x0028, 0x1052) ?? 0; // RescaleIntercept
    const bigEndian = transferSyntax === EXPLICIT_BIG_ENDIAN;

    const pixelsPerFrame = rows * cols;
    const sampleCount = pixelsPerFrame * samplesPerPixel; // samples in ONE frame

    // ── obtain the FIRST frame's raw samples ────────────────────────────────────────
    let rawBytes: Uint8Array;
    if (transferSyntax === RLE_TRANSFER_SYNTAX) {
        // Encapsulated RLE: read the first frame's fragment and PackBits-decode it.
        const frame: Uint8Array = dicomParser.readEncapsulatedImageFrame
            ? dicomParser.readEncapsulatedImageFrame(ds, pixelElement, 0)
            : dicomParser.readEncapsulatedPixelDataFromFragments(ds, pixelElement, 0);
        if (!frame || !frame.length) throw new Error("Couldn't read the DICOM RLE frame");
        rawBytes = decodeRle(frame, sampleCount, bitsAllocated);
    } else if (pixelElement.encapsulatedPixelData) {
        // Encapsulated but not RLE and not in the compressed set we caught → unknown.
        throw new Error(STRINGS.dicom.compressed);
    } else {
        // Native (uncompressed) PixelData: a contiguous run; slice the first frame.
        const bytesPerSample = bitsAllocated <= 8 ? 1 : 2;
        const frameBytes = sampleCount * bytesPerSample;
        const start = pixelElement.dataOffset;
        rawBytes = bytes.subarray(start, start + frameBytes);
    }

    // ── colour vs grayscale ─────────────────────────────────────────────────────────
    if (samplesPerPixel >= 3) {
        // RGB / YBR colour image: paint directly (no window). 8-bit only (the colour
        // photometrics are byte data); a 16-bit colour DICOM is vanishingly rare.
        const colorSamples = bitsAllocated <= 8
            ? rawBytes
            : new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
        const rgba = colorFrameToRgba(colorSamples, cols, rows, planar, photometric);
        return colorToBlobUrl({ rgba, width: cols, height: rows });
    }

    // Grayscale: read the typed samples (signed/unsigned, endianness), rescale, window.
    let samples: Int16Array | Uint16Array | Uint8Array;
    if (transferSyntax === RLE_TRANSFER_SYNTAX) {
        // decodeRle produced native little-endian bytes; read as a typed view.
        samples = readSamples(rawBytes, 0, sampleCount, bitsAllocated, pixelRepresentation === 1, false);
    } else {
        samples = readSamples(rawBytes, 0, sampleCount, bitsAllocated, pixelRepresentation === 1, bigEndian);
    }

    const frame = rescaleToGray(samples, sampleCount, slope, intercept);
    frame.width = cols;
    frame.height = rows;

    // Window: prefer the file's WindowCenter/Width; else auto-window from the data range
    // so the image is always visible. WindowCenter is in rescaled (modality) units.
    let center = firstFloat(ds, 0x0028, 0x1050);
    let width = firstFloat(ds, 0x0028, 0x1051);
    if (center == null || width == null || width <= 0) {
        center = (frame.min + frame.max) / 2;
        width = Math.max(1, frame.max - frame.min);
    }
    // MONOCHROME1: minimum sample is displayed WHITE → invert the ramp. MONOCHROME2 (and
    // anything else grayscale) is the normal min=black.
    const invert = photometric === "MONOCHROME1";

    // NOTE numFrames > 1: only the first frame is shown in v1 (a multi-frame selector,
    // like the multi-page TIFF nav, is a deferred enhancement). `numFrames` is read above
    // so a later frame-nav pass has the count without re-parsing; reference it so the
    // unused-binding lint stays quiet without dead code.
    void numFrames;
    const rgba = windowToRgba(frame, center, width, invert);
    return rgbaToBlobUrl(rgba, cols, rows);
}

/** DICOM loader: fetch bytes → parse + window → blob → retype to "image". */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = STRINGS.error.noSource.title;
        return;
    }
    ctx.content.loading = true;
    const reqUrl = opts.url;
    const ext = extOf(opts.url) || extOf(opts.name);
    if (ext !== "dcm" && ext !== "dicom") {
        // routed here only for .dcm/.dicom; defensive guard
        ctx.content.loading = false;
        ctx.content.error = STRINGS.unsupported.title;
        return;
    }

    ctx.fetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.arrayBuffer();
        })
        .then(buf => dicomToBlobUrl(buf, ctx))
        .then(blobUrl => {
            if (entry) {
                entry.type = "image";
                entry.url = blobUrl;
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
function resetState(): void { /* no view-state — DICOM retypes to image */ }
function snapshot(): void { /* nothing to persist; the entry retypes to image */ }
function restore(): void { /* nothing to restore */ }

/** Revoke the blob: url this viewer created when the cache entry is evicted. Guarded on
 *  the blob: scheme so we only ever revoke urls WE created, never a CDN url. */
function dispose(entry: CacheEntry): void {
    const u = entry.url;
    if (u && u.startsWith("blob:")) {
        try { URL.revokeObjectURL(u); } catch { /* already gone */ }
    }
}

export const DicomViewer: Viewer<Record<string, never>> = {
    type: "dicom",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    dispose,
    // load() retypes content.type to "image" before the body renders, so the dispatcher
    // always routes to the image viewer's Body — this placeholder Body is never mounted.
    Body: DicomPlaceholderBody,
    capabilities: { openInWindow: true }
};
