/*
 * DockView — MAIN-process attachment converters (native-convert.ts).
 * ---------------------------------------------------------------------------
 * This module runs in the Electron MAIN process (imported by native.ts, so it is
 * bundled into dockviewMain.js — the Node target, which has NO CSP and NO
 * esbuild browser-builtin ban). It holds the per-format converters the
 * convertAttachment IPC dispatches to: formats that CANNOT be decoded in the
 * renderer because they need a Node-only library.
 *
 * WHY THESE TWO FORMATS LIVE HERE (and not in a renderer viewer)
 * -------------------------------------------------------------
 *   .msg  — Outlook's binary OLE message. @kenjiuno/msgreader needs Node `Buffer`
 *           + an OLE/CFB reader; the renderer bans Node builtins and its esbuild
 *           bundle won't carry Buffer. (postal-mime handles .eml in the renderer;
 *           the binary .msg twin is a different container it can't read.)
 *   raw   — camera RAW (cr2/nef/dng/arw/raf/orf/rw2). libraw-wasm — the obvious
 *           browser decoder — uses a *web* Worker + import.meta.url, which throws
 *           "Worker is not defined" under Node (Node has worker_threads, not web
 *           Workers; build-confirmed). So RAW is decoded here with utif (pure-JS
 *           TIFF/DNG IFD decode, no Worker) + a decoder-free embedded-JPEG-preview
 *           extraction, both of which run cleanly in Node main.
 *
 * THE LIBS SHIP IN THE MAIN BUNDLE AUTOMATICALLY
 * ----------------------------------------------
 * scripts/prepare-vencord.mjs's deriveDockviewDeps() scans plugin/**\/*.ts for
 * external import specifiers and `pnpm add`s + bundles them. Because native.ts
 * imports THIS module and this module imports the libs below, they are auto-derived
 * into the disposable build checkout and bundled into dockviewMain.js (Node target — no
 * browser-builtin ban). No hand-maintained dep list.
 *
 * CONTRACT — each converter returns { mime, bytes } (raw output bytes) or throws a
 * plain Error. convertAttachment (native.ts) base64-encodes the bytes and wraps the
 * result for the renderer. Converters NEVER touch the network or disk — native.ts
 * has already fetched the (host-allowlisted) attachment bytes and hands them in.
 */

import { decompressRTF } from "@kenjiuno/decompressrtf";
import MsgReader from "@kenjiuno/msgreader";
// utif (v1) is already a renderer dep (the raster viewer's TIFF path); it decodes
// TIFF/DNG IFDs to RGBA in pure JS with NO web Worker, so it runs in Node main too
// (verified) — reusing it here avoids adding a second TIFF library to the build.
import * as UTIF from "utif";

/** A converted attachment: the output MIME + its raw bytes (convertAttachment
 *  base64-encodes the bytes for the IPC reply). */
export interface ConvertOutput {
    mime: string;
    bytes: Uint8Array;
}

// ── shared HTML escaping (main has no engine/html import path; tiny local copy) ──

function escHtml(s: string): string {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
    return escHtml(s).replace(/"/g, "&quot;");
}

// ════════════════════════════════════════════════════════════════════════════
//  .msg  →  clean HTML document
// ════════════════════════════════════════════════════════════════════════════

/** The subset of msgreader's getFileData() result we read. Kept structural so this
 *  module doesn't depend on msgreader's exported types across versions. */
interface MsgRecipient {
    name?: string;
    email?: string;
    smtpAddress?: string;
    recipType?: string; // "to" | "cc" | "bcc"
}
interface MsgAttachment {
    fileName?: string;
    name?: string;
    contentLength?: number;
}
interface MsgData {
    subject?: string;
    senderName?: string;
    senderEmail?: string;
    senderSmtpAddress?: string;
    body?: string; // plain-text body
    bodyHtml?: string; // HTML body when Outlook stored one directly
    compressedRtf?: Uint8Array; // LZFu-compressed RTF (may encapsulate HTML)
    messageDeliveryTime?: string;
    clientSubmitTime?: string;
    creationTime?: string;
    recipients?: MsgRecipient[];
    attachments?: MsgAttachment[];
}

/** Format one recipient/sender as "Name <email>" (HTML-escaped), or just whichever
 *  half is present. */
function fmtAddr(name?: string, email?: string): string {
    const n = (name || "").trim();
    const e = (email || "").trim();
    if (n && e && n !== e) {
        return `<span class="dv-eml-addr">${escHtml(n)}</span> ` +
            `<span class="dv-eml-email">&lt;${escHtml(e)}&gt;</span>`;
    }
    if (e) return `<span class="dv-eml-email">${escHtml(e)}</span>`;
    if (n) return `<span class="dv-eml-addr">${escHtml(n)}</span>`;
    return "";
}

/** Format a recipients list filtered by recipType ("to"/"cc"), comma-joined. */
function fmtRecipients(recips: MsgRecipient[] | undefined, kind: string): string {
    if (!recips || !recips.length) return "";
    return recips
        .filter(r => (r.recipType || "to").toLowerCase() === kind)
        .map(r => fmtAddr(r.name, r.email || r.smtpAddress))
        .filter(Boolean)
        .join(", ");
}

/** A locale-formatted date, falling back to the raw string. */
function fmtDate(raw: string | undefined): string {
    if (!raw) return "";
    const d = new Date(raw);
    if (isNaN(d.getTime())) return escHtml(raw);
    try {
        return escHtml(d.toLocaleString(undefined, {
            year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
        }));
    } catch {
        return escHtml(raw);
    }
}

/** One header row, emitted only when the value is non-empty. */
function row(label: string, valueHtml: string): string {
    if (!valueHtml) return "";
    return `<div class="dv-eml-row">` +
        `<span class="dv-eml-label">${escHtml(label)}</span>` +
        `<span class="dv-eml-val">${valueHtml}</span></div>`;
}

/**
 * SANITISE an HTML body for the renderer's null-origin sandbox.
 *
 * The renderer renders this through the SAME dark sandboxed iframe the .eml/docx
 * viewers use (sandbox="allow-scripts", no allow-same-origin). The sandbox blocks
 * host-DOM access but NOT network image loads, so — exactly like the .eml path —
 * we neutralise remote content HERE in main, with a regex pass over the source
 * (main has no DOMParser): <script>/<style>/<link>/<iframe>/<object>/<embed>/on*=
 * handlers + javascript: urls are ALWAYS removed. data: images are kept (no network).
 * This is a defensive belt-and-braces pass; the iframe sandbox is the primary
 * isolation.
 *
 * `allowRemote` mirrors the .eml path's Privacy switch, threaded down as an ARGUMENT
 * from the renderer through the convertAttachment IPC (main stays stateless — it holds
 * no setting, it's told per-call): when false (default) every remote <img> becomes a
 * "blocked" pill and remote CSS background-image url() is stripped, so no tracking-pixel
 * request is made; when true the remote <img>/background is left to load.
 */
function sanitizeHtmlBody(html: string, allowRemote: boolean): string {
    let s = html;
    // Drop active / network / restyling elements wholesale (with their content).
    s = s.replace(/<(script|style|iframe|object|embed|link|base|meta|form)\b[\s\S]*?<\/\1\s*>/gi, "");
    // Self-closing / unmatched variants of the same tags.
    s = s.replace(/<(script|style|iframe|object|embed|link|base|meta|form)\b[^>]*\/?>/gi, "");
    // Strip inline event handlers (on...="..."/on...='...').
    s = s.replace(/\son[a-z]+\s*=\s*"(?:[^"]*)"/gi, "");
    s = s.replace(/\son[a-z]+\s*=\s*'(?:[^']*)'/gi, "");
    // Strip javascript: in href/src.
    s = s.replace(/\s(href|src)\s*=\s*"(?:\s*javascript:[^"]*)"/gi, "");
    s = s.replace(/\s(href|src)\s*=\s*'(?:\s*javascript:[^']*)'/gi, "");
    if (!allowRemote) {
        // Neutralise REMOTE images (http/https/protocol-relative): replace the whole
        // <img …> with a "blocked" pill so no tracking-pixel request is ever made.
        // data: images carry no network request and are left untouched.
        s = s.replace(/<img\b[^>]*\bsrc\s*=\s*(["'])(https?:\/\/|\/\/)[^"']*\1[^>]*>/gi,
            '<span class="dv-eml-blocked">remote image blocked</span>');
        // Strip remote background-image url() in inline styles (another fetch vector).
        s = s.replace(/background(-image)?\s*:[^;"']*url\(\s*['"]?\s*(?:https?:)?\/\/[^)]*\)[^;"']*;?/gi, "");
    }
    return s;
}

/** De-encapsulate the HTML stored inside an Outlook `\fromhtml` RTF stream.
 *  Outlook wraps the original HTML in RTF: the real HTML tags sit between
 *  `\htmlrtf0` … `\htmlrtf1` regions (htmlrtf1 = RTF-only, skip; htmlrtf0 = HTML,
 *  keep). We strip the RTF control words and unescape the few escapes Outlook uses,
 *  recovering the source HTML. Returns null when the RTF is not `\fromhtml`. */
function htmlFromRtf(rtf: string): string | null {
    if (!/\\fromhtml1?/.test(rtf)) return null;
    // Pull the body of the RTF group, then walk it dropping \htmlrtf1 … \htmlrtf0
    // (RTF-only) spans and emitting the rest with control words removed.
    let out = "";
    let htmlrtfDepth = 0; // >0 ⇒ inside a \htmlrtf (RTF-only) region, skip output
    let i = 0;
    const n = rtf.length;
    while (i < n) {
        const ch = rtf[i];
        if (ch === "\\") {
            // A control word or control symbol.
            const m = /^\\([a-zA-Z]+)(-?\d+)?[ ]?/.exec(rtf.slice(i));
            if (m) {
                const word = m[1];
                const param = m[2];
                if (word === "htmlrtf") {
                    // \htmlrtf or \htmlrtf1 enters RTF-only; \htmlrtf0 exits it.
                    htmlrtfDepth = param === "0" ? 0 : 1;
                } else if (word === "htmltag") {
                    // \*\htmltag... introduces literal HTML in the following group;
                    // its destination text is the HTML we want — fall through (the
                    // group's text is emitted by the normal text path below).
                } else if (word === "par") {
                    if (htmlrtfDepth === 0) out += "\n";
                } else if (word === "tab") {
                    if (htmlrtfDepth === 0) out += "\t";
                } else if (word === "lquote") { if (!htmlrtfDepth) out += "‘"; }
                else if (word === "rquote") { if (!htmlrtfDepth) out += "’"; }
                else if (word === "ldblquote") { if (!htmlrtfDepth) out += "“"; }
                else if (word === "rdblquote") { if (!htmlrtfDepth) out += "”"; }
                else if (word === "endash") { if (!htmlrtfDepth) out += "–"; }
                else if (word === "emdash") { if (!htmlrtfDepth) out += "—"; }
                // \uNNNN unicode char.
                else if (word === "u" && param != null) {
                    if (!htmlrtfDepth) {
                        const code = parseInt(param, 10);
                        if (!isNaN(code)) out += String.fromCharCode(code < 0 ? code + 65536 : code);
                    }
                    // skip the following fallback byte (commonly "?")
                    let j = i + m[0].length;
                    if (rtf[j] === "?") j++;
                    i = j;
                    continue;
                }
                // every other control word is RTF formatting — drop it.
                i += m[0].length;
                continue;
            }
            // Control symbol: \\ \{ \} are literal; \'hh is a hex byte.
            const c2 = rtf[i + 1];
            if (c2 === "\\" || c2 === "{" || c2 === "}") {
                if (!htmlrtfDepth) out += c2;
                i += 2;
                continue;
            }
            if (c2 === "'") {
                const hex = rtf.slice(i + 2, i + 4);
                if (!htmlrtfDepth) {
                    const code = parseInt(hex, 16);
                    if (!isNaN(code)) out += String.fromCharCode(code);
                }
                i += 4;
                continue;
            }
            // unknown control symbol — skip the backslash + next char.
            i += 2;
            continue;
        }
        if (ch === "{" || ch === "}") { i++; continue; } // group delimiters — drop
        if (ch === "\r" || ch === "\n") { i++; continue; } // RTF line breaks are not content
        if (htmlrtfDepth === 0) out += ch;
        i++;
    }
    out = out.trim();
    // Only treat it as HTML if it actually contains tags; otherwise let the caller
    // fall through to the plain-text body.
    return /<\s*\w+[^>]*>/.test(out) ? out : null;
}

/** Build the attachment list HTML (filename + size). */
function renderMsgAttachments(atts: MsgAttachment[] | undefined): string {
    const real = (atts || []).filter(a => (a.fileName || a.name));
    if (!real.length) return "";
    const items = real.map(a => {
        const nm = (a.fileName || a.name || "(unnamed attachment)").trim();
        const sz = a.contentLength ? humanSize(a.contentLength) : "";
        return `<li class="dv-eml-att-item">` +
            `<span class="dv-eml-att-icon">📎</span>` +
            `<span class="dv-eml-att-name" title="${escAttr(nm)}">${escHtml(nm)}</span>` +
            (sz ? `<span class="dv-eml-att-size">${escHtml(sz)}</span>` : "") +
            `</li>`;
    }).join("");
    const label = real.length === 1 ? "1 attachment" : `${real.length} attachments`;
    return `<div class="dv-eml-att"><div class="dv-eml-att-title">${escHtml(label)}</div>` +
        `<ul class="dv-eml-att-list">${items}</ul></div>`;
}

function humanSize(bytes: number): string {
    if (!bytes || bytes < 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let nu = bytes, u = 0;
    while (nu >= 1024 && u < units.length - 1) { nu /= 1024; u++; }
    return `${u === 0 ? nu : nu.toFixed(1)} ${units[u]}`;
}

/**
 * Parse a .msg (binary Outlook OLE message) and build ONE body-HTML fragment — the
 * SAME shape the .eml viewer produces — so the renderer can render it through its
 * existing dark sandboxed-iframe shell with no special-casing. Returns the fragment
 * bytes as UTF-8 with mime text/html.
 *
 * Body precedence: a direct HTML body (sanitised) → encapsulated HTML inside the
 * compressed RTF (de-encapsulated + sanitised) → the plain-text body → empty-state.
 * Remote content is neutralised here (main has no DOMParser, so via a regex pass)
 * UNLESS `allowRemote` (the renderer's Privacy switch, passed through the IPC); the
 * renderer's null-origin sandbox is the primary isolation either way.
 */
function convertMsg(input: Uint8Array, allowRemote: boolean): ConvertOutput {
    // msgreader's class is the CJS default-of-default under ESM interop.
    const Ctor: any = (MsgReader as any)?.default ?? MsgReader;
    const reader = new Ctor(input);
    const data: MsgData = reader.getFileData();
    if (!data || (data as any).error) {
        throw new Error("Couldn't parse the Outlook message");
    }

    const subject = (data.subject || "").trim();
    const subjectHtml = subject
        ? escHtml(subject)
        : `<span class="dv-eml-empty">(no subject)</span>`;

    const fromHtml = fmtAddr(data.senderName, data.senderEmail || data.senderSmtpAddress);
    const toHtml = fmtRecipients(data.recipients, "to");
    const ccHtml = fmtRecipients(data.recipients, "cc");
    const dateHtml = fmtDate(data.messageDeliveryTime || data.clientSubmitTime || data.creationTime);

    const head =
        `<div class="dv-eml-head">` +
        `<div class="dv-eml-subject">${subjectHtml}</div>` +
        row("From", fromHtml) +
        row("To", toHtml) +
        row("Cc", ccHtml) +
        row("Date", dateHtml) +
        `</div>`;

    // Body precedence.
    let bodyHtml: string;
    if (data.bodyHtml && data.bodyHtml.trim()) {
        bodyHtml = `<div class="dv-eml-body">${sanitizeHtmlBody(data.bodyHtml, allowRemote)}</div>`;
    } else if (data.compressedRtf && data.compressedRtf.length) {
        let recovered: string | null = null;
        try {
            const rtfBytes = decompressRTF(data.compressedRtf);
            const rtf = Buffer.from(rtfBytes).toString("latin1");
            recovered = htmlFromRtf(rtf);
        } catch {
            recovered = null;
        }
        if (recovered) {
            bodyHtml = `<div class="dv-eml-body">${sanitizeHtmlBody(recovered, allowRemote)}</div>`;
        } else if (data.body && data.body.trim()) {
            bodyHtml = `<div class="dv-eml-body dv-eml-body-text">${escHtml(data.body)}</div>`;
        } else {
            bodyHtml = `<div class="dv-eml-body dv-eml-empty">This message has no body.</div>`;
        }
    } else if (data.body && data.body.trim()) {
        bodyHtml = `<div class="dv-eml-body dv-eml-body-text">${escHtml(data.body)}</div>`;
    } else {
        bodyHtml = `<div class="dv-eml-body dv-eml-empty">This message has no body.</div>`;
    }

    const fragment = head + bodyHtml + renderMsgAttachments(data.attachments);
    return { mime: "text/html", bytes: new TextEncoder().encode(fragment) };
}

// ════════════════════════════════════════════════════════════════════════════
//  RAW camera files  →  PNG
// ════════════════════════════════════════════════════════════════════════════

/**
 * Scan a buffer for a REAL embedded JPEG (FFD8 … FFD9) that carries a baseline/
 * progressive SOF marker (so we don't mistake coincidental FFD8 bytes in the raw
 * sensor stream for an image). Returns the LARGEST such JPEG's bytes, or null.
 *
 * This is the fast, decoder-free preview path: nearly every camera RAW embeds a
 * full- or medium-resolution JPEG preview (it's what the camera LCD + OS thumbnails
 * use), so for the common case we hand that straight back with no heavy decode.
 */
function largestEmbeddedJpeg(u: Uint8Array): Uint8Array | null {
    let best: { start: number; end: number; len: number } | null = null;
    const n = u.length;
    for (let i = 0; i + 1 < n; i++) {
        if (u[i] !== 0xFF || u[i + 1] !== 0xD8) continue;
        let hasSOF = false;
        let j = i + 2;
        while (j + 1 < n) {
            if (u[j] !== 0xFF) { j++; continue; }
            const marker = u[j + 1];
            if (marker === 0xD9) {
                // End of image. A real JPEG must have had an SOF (frame header).
                if (hasSOF) {
                    const len = j + 2 - i;
                    if (!best || len > best.len) best = { start: i, end: j + 2, len };
                }
                i = j + 1;
                break;
            }
            // SOF0..SOF15 except DHT(C4)/JPG(C8)/DAC(CC) = a real frame header.
            if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                hasSOF = true;
            }
            // Standalone markers (RSTn D0-D7, SOI D8, EOI D9, TEM 01) carry no length.
            if ((marker >= 0xD0 && marker <= 0xD9) || marker === 0x01 || marker === 0xFF) {
                j += 2;
                continue;
            }
            // Every other marker is followed by a 2-byte segment length; skip it.
            const segLen = (u[j + 2] << 8) | u[j + 3];
            if (segLen < 2) { j += 2; continue; } // malformed — step on
            j += 2 + segLen;
        }
    }
    if (!best) return null;
    return u.slice(best.start, best.end);
}

/**
 * Decode a camera RAW to PNG bytes.
 *
 * Strategy (decoder-free first, then a pure-JS full decode):
 *   1. Pull the LARGEST embedded JPEG preview out of the file (largestEmbeddedJpeg).
 *      Most RAWs embed a full/medium JPEG preview; returning it is fast, faithful,
 *      and needs no decoder. We return it as image/jpeg (the renderer's <img> shows
 *      JPEG natively — no PNG re-encode needed). A heuristic guards against a tiny
 *      thumbnail: we only take the embedded JPEG when it's a meaningful size.
 *   2. Otherwise (no usable embedded preview — e.g. an uncompressed/odd RAW), decode
 *      the TIFF/DNG IFD with utif (pure-JS, no Worker — libraw-wasm's web Worker
 *      throws in Node main) to RGBA, and encode RGBA→PNG with a minimal pure-JS PNG
 *      writer.
 *
 * Throws a plain Error when neither path yields an image (a format utif can't read
 * and that carries no embedded preview — the renderer surfaces it as a load error).
 */
function convertRaw(input: Uint8Array): ConvertOutput {
    // ---- 1. embedded JPEG preview (fast, decoder-free) ----
    const jpeg = largestEmbeddedJpeg(input);
    // Guard against a tiny embedded thumbnail when a bigger decode is possible: take
    // the embedded JPEG when it's a reasonable preview (>= 8 KB) OR when there's no
    // TIFF IFD to decode as a fallback.
    if (jpeg && jpeg.length >= 8192) {
        return { mime: "image/jpeg", bytes: jpeg };
    }

    // ---- 2. utif full decode → RGBA → PNG (pure-JS, no Worker) ----
    try {
        const ab = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
        const ifds: any[] = (UTIF as any).decode(ab);
        if (ifds && ifds.length) {
            // Pick the IFD with the largest pixel area = the full image, not a thumb.
            let best = ifds[0];
            for (const ifd of ifds) {
                const area = (ifd.width || 0) * (ifd.height || 0);
                const bestArea = (best.width || 0) * (best.height || 0);
                if (area > bestArea) best = ifd;
            }
            (UTIF as any).decodeImage(ab, best);
            const rgba: Uint8Array = (UTIF as any).toRGBA8(best);
            const w = best.width, h = best.height;
            if (rgba && w && h && rgba.length >= w * h * 4) {
                return { mime: "image/png", bytes: encodePng(rgba, w, h) };
            }
        }
    } catch {
        /* fall through to the embedded-preview fallback / throw */
    }

    // ---- 3. last resort: a smaller embedded JPEG (a thumbnail is better than nothing) ----
    if (jpeg) return { mime: "image/jpeg", bytes: jpeg };

    throw new Error("Couldn't decode this RAW file");
}

// ── minimal pure-JS PNG encoder (RGBA → PNG), no canvas / no native dep ──────────
// A single IDAT, filter-type 0 per row, zlib-stored (uncompressed) deflate blocks.
// We do NOT compress: the output is larger but correct, the encode is O(n) with no
// dependency, and the bytes only travel the in-process IPC → blob: (never the
// network), so size is not a concern. (utif/pngjs would also work, but a tiny
// self-contained encoder keeps the main bundle lean and the path obvious.)

function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
    // 1. Build the raw image data: one filter byte (0) per row + the row's RGBA.
    const rowLen = width * 4;
    const raw = new Uint8Array((rowLen + 1) * height);
    for (let y = 0; y < height; y++) {
        const src = y * rowLen;
        const dst = y * (rowLen + 1);
        raw[dst] = 0; // filter type 0 (None)
        raw.set(rgba.subarray(src, src + rowLen), dst + 1);
    }
    // 2. zlib-wrap with stored (uncompressed) deflate blocks + an Adler-32 checksum.
    const compressed = zlibStore(raw);
    // 3. Assemble the PNG: signature + IHDR + IDAT + IEND.
    const sig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // colour type 6 = truecolour + alpha (RGBA)
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    const chunks = [
        chunk("IHDR", ihdr),
        chunk("IDAT", compressed),
        chunk("IEND", new Uint8Array(0))
    ];
    let total = sig.length;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    out.set(sig, off); off += sig.length;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

/** A PNG chunk: length(4) + type(4) + data + crc(4). */
function chunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
    const out = new Uint8Array(4 + 4 + data.length + 4);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(typeBytes, 4);
    out.set(data, 8);
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(data, 4);
    dv.setUint32(8 + data.length, crc32(crcInput));
    return out;
}

/** zlib stream with STORED (uncompressed) deflate blocks. */
function zlibStore(data: Uint8Array): Uint8Array {
    const MAX = 0xFFFF; // max stored-block payload
    const nBlocks = Math.max(1, Math.ceil(data.length / MAX));
    // header(2) + per-block [1 + 2 + 2] + payload + adler(4)
    const out = new Uint8Array(2 + nBlocks * 5 + data.length + 4);
    let p = 0;
    out[p++] = 0x78; // zlib CMF (deflate, 32K window)
    out[p++] = 0x01; // FLG (no dict, fastest) — (0x78<<8 | 0x01) % 31 === 0
    let i = 0;
    while (i < data.length || (i === 0 && data.length === 0)) {
        const remaining = data.length - i;
        const blockLen = Math.min(remaining, MAX);
        const isLast = i + blockLen >= data.length;
        out[p++] = isLast ? 1 : 0; // BFINAL bit, BTYPE 00 (stored)
        out[p++] = blockLen & 0xFF;
        out[p++] = (blockLen >> 8) & 0xFF;
        out[p++] = ~blockLen & 0xFF;
        out[p++] = (~blockLen >> 8) & 0xFF;
        out.set(data.subarray(i, i + blockLen), p);
        p += blockLen;
        i += blockLen;
        if (blockLen === 0) break;
    }
    const adler = adler32(data);
    out[p++] = (adler >>> 24) & 0xFF;
    out[p++] = (adler >>> 16) & 0xFF;
    out[p++] = (adler >>> 8) & 0xFF;
    out[p++] = adler & 0xFF;
    return out.subarray(0, p);
}

/** Adler-32 (zlib trailer checksum). */
function adler32(data: Uint8Array): number {
    let a = 1, b = 0;
    const MOD = 65521;
    for (let i = 0; i < data.length; i++) {
        a = (a + data[i]) % MOD;
        b = (b + a) % MOD;
    }
    return ((b << 16) | a) >>> 0;
}

/** CRC-32 (PNG chunk checksum), table built once. */
let CRC_TABLE: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[n] = c >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ════════════════════════════════════════════════════════════════════════════
//  dispatch
// ════════════════════════════════════════════════════════════════════════════

/** Per-call options a converter may honour. `allowRemote` (msg only) mirrors the .eml
 *  Privacy switch — passed down from the renderer through the IPC so main stays
 *  stateless. RAW ignores it. */
export interface ConvertOptions {
    allowRemote?: boolean;
}

/** Run the converter for `kind` over the fetched attachment bytes. Throws a plain
 *  Error for an unknown kind or a conversion failure; convertAttachment (native.ts)
 *  catches and returns it as { ok:false, error }. */
export function runConverter(kind: string, input: Uint8Array, opts: ConvertOptions = {}): ConvertOutput {
    switch (kind) {
        case "msg":
            return convertMsg(input, opts.allowRemote === true);
        case "raw":
            return convertRaw(input);
        default:
            throw new Error(`Unknown convert kind: ${kind}`);
    }
}
