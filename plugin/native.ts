/*
 * DockView — main-process native IPC surface (native.ts).
 * ---------------------------------------------------------------------------
 * This module runs in the Electron MAIN process, not the renderer. Vencord
 * auto-registers each exported async function of a plugin's native.ts as an
 * ipcMain handler keyed by the definePlugin `name` ("DockView", see index.tsx):
 *
 *     export async function readChunk(_, dir, name) { ... }
 *        ⇒ ipcMain.handle("VencordPluginNative_DockView_readChunk", ...)
 *        ⇒ renderer calls VencordNative.pluginHelpers.DockView.readChunk(dir, name)
 *
 * Electron injects the IpcMainInvokeEvent as the FIRST argument; the renderer
 * only supplies the real arguments after it. Every export here therefore has the
 * shape `async fn(_: IpcMainInvokeEvent, ...realArgs)` and ignores the event.
 *
 * Main has full Node and no CSP, so this file talks to the disk and the network
 * directly. It imports ONLY Node builtins (fs/promises, path) plus the global
 * `fetch` (Node 18+). The ONE npm dependency is the attachment-converter module
 * (./native-convert), which the convertAttachment IPC dispatches to: those
 * Node-only libs (@kenjiuno/msgreader, utif, …) belong in the MAIN bundle
 * precisely because the renderer can't run them (Buffer / web-Worker bans). The
 * build's deriveDockviewDeps() scans plugin/**\/*.ts for external-package import
 * specifiers and `pnpm add`s + bundles them — so importing native-convert here
 * pulls its libs into vencordDesktopMain.js (Node target, no browser-builtin ban)
 * automatically. We still declare a local minimal stand-in for Electron's
 * IpcMainInvokeEvent rather than importing "electron" (the event is never read, so
 * the exact type is immaterial and an electron type-dep is avoided).
 *
 * Two IPCs live here:
 *   readChunk         — reads an out-of-bundle viewer CHUNK file off the install
 *                       dir and returns its source (the renderer eval()s it).
 *   convertAttachment — fetches + decodes an attachment the renderer can't
 *                       (Outlook .msg, camera RAW) and returns renderable bytes.
 */

import { readFile } from "fs/promises";
import { join } from "path";

import { runConverter } from "./native-convert";

/**
 * Local stand-in for Electron's IpcMainInvokeEvent. We do NOT import it from
 * "electron" on purpose: the build's deriveDockviewDeps() would treat that as an
 * external package and add it to the Vencord clone (which has no electron dep).
 * The event is never read here, so an opaque type is sufficient and honest.
 */
type IpcMainInvokeEvent = unknown;

/** Network timeout for attachment fetches (ms). */
const FETCH_TIMEOUT_MS = 15_000;

/** fetch() with an AbortController timeout. Rejects on network error, timeout,
 *  or (when `expectOk`) a non-2xx status. */
async function fetchWithTimeout(url: string, expectOk = true): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (expectOk && !res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        }
        return res;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Read an out-of-bundle CHUNK file's source text from the install dir.
 * ---------------------------------------------------------------------------
 * The code-dense heavy libs (mermaid, pptx, codemirror, pdfjs, three) are built
 * as standalone chunk-<lib>.js files that ship ALONGSIDE the renderer/main
 * bundles in VENCORD_FILES_DIR. They are NOT inline in vencordDesktopRenderer.js
 * — that is the whole point (their bytes no longer cost V8 compile at startup).
 * The renderer pulls one in on first use via this IPC: engine/lazyLib.ts asks for
 * "chunk-mermaid.js", main reads it off disk and returns the source, and the
 * renderer eval()s it (CSP allows 'unsafe-eval').
 *
 * SECURITY: `name` is constrained to `chunk-<id>.js` (alphanumerics, dash, dot)
 * and joined onto targetDir, so it cannot escape the install dir via "../" or an
 * absolute path. Anything else returns null. The renderer only ever passes names
 * from its compiled-in chunk registry, but this guard keeps the IPC honest.
 *
 * Returns the file's utf-8 text, or null if missing/unreadable/rejected — the
 * renderer surfaces that as a load failure (and a chunked viewer can't render).
 */
export async function readChunk(_: IpcMainInvokeEvent, targetDir: string, name: string): Promise<string | null> {
    // Only `chunk-<safe>.js`, no path separators — cannot traverse out of targetDir.
    if (typeof name !== "string" || !/^chunk-[A-Za-z0-9._-]+\.js$/.test(name)) return null;
    if (typeof targetDir !== "string" || !targetDir) return null;
    try {
        return await readFile(join(targetDir, name), "utf-8");
    } catch {
        return null;
    }
}

/** Discord CDN hosts the convertAttachment IPC will fetch from. The IPC is NOT an
 *  open proxy: only an attachment served from one of these hosts is fetched, so a
 *  compromised/poisoned renderer can't turn main into a general-purpose fetcher. */
const ALLOWED_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** Cap the bytes the converter will fetch (a RAW can be large, but a 64 MB ceiling
 *  keeps a pathological/hostile url from exhausting main's memory). */
const CONVERT_MAX_BYTES = 64 * 1024 * 1024;

/** The shape convertAttachment returns to the renderer. On success `mime` + `b64`
 *  carry the converted bytes (base64); on failure `error` carries a short message
 *  the renderer surfaces as a load error. */
interface ConvertResult { ok: boolean; mime?: string; b64?: string; error?: string; }

/**
 * Convert an attachment that the RENDERER cannot decode (its CSP / its esbuild
 * browser-builtin ban), by fetching + decoding it HERE in main and handing back
 * renderable bytes.
 * ---------------------------------------------------------------------------
 * The renderer calls VencordNative.pluginHelpers.DockView.convertAttachment(kind, url)
 * for two formats that need a Node-only library:
 *   kind "msg" → @kenjiuno/msgreader parses the binary Outlook OLE message → a clean
 *                HTML doc (header block + body + attachment list; remote images
 *                neutralised). Returned as mime "text/html".
 *   kind "raw" → a camera RAW (cr2/nef/dng/arw/raf/orf/rw2) → its embedded JPEG
 *                preview (fast, decoder-free) or, failing that, a utif full decode →
 *                PNG. Returned as mime "image/jpeg" or "image/png".
 * (Both libs run in Node main with NO web Worker — libraw-wasm's web Worker throws
 * "Worker is not defined" under Node, build-confirmed, which is exactly why RAW
 * uses utif + the embedded-preview path here. See native-convert.ts.)
 *
 * SECURITY: main has no CSP, so this could be an open proxy if it fetched any url.
 * It does NOT: `url` MUST parse and resolve to a Discord CDN host (ALLOWED_CDN_HOSTS)
 * over https, or the call returns { ok:false } without fetching. The fetched body is
 * size-capped (CONVERT_MAX_BYTES). The converter output is bytes only (HTML/PNG/JPEG)
 * the renderer wraps in a same-origin blob: — never executed in main.
 *
 * Errors (bad host, fetch failure, parse/decoder failure, size cap) are returned as
 * { ok:false, error } rather than thrown — the renderer shows the message on the
 * dock's error card.
 */
export async function convertAttachment(_: IpcMainInvokeEvent, kind: string, url: string): Promise<ConvertResult> {
    if (typeof kind !== "string" || (kind !== "msg" && kind !== "raw")) {
        return { ok: false, error: "Unsupported conversion" };
    }
    if (typeof url !== "string" || !url) {
        return { ok: false, error: "No source to convert" };
    }

    // Host allowlist — only Discord CDN over https; never an open proxy.
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, error: "Invalid file URL" };
    }
    if (parsed.protocol !== "https:" || !ALLOWED_CDN_HOSTS.has(parsed.hostname)) {
        return { ok: false, error: "This file can't be converted (unexpected host)" };
    }

    // Fetch the attachment bytes in main (no CSP here), size-capped to keep a
    // pathological url from exhausting memory.
    let input: Uint8Array;
    try {
        const res = await fetchWithTimeout(url, true);
        const len = Number(res.headers.get("content-length") || 0);
        if (len && len > CONVERT_MAX_BYTES) {
            return { ok: false, error: "File is too large to preview" };
        }
        const buf = await res.arrayBuffer();
        if (buf.byteLength > CONVERT_MAX_BYTES) {
            return { ok: false, error: "File is too large to preview" };
        }
        input = new Uint8Array(buf);
    } catch (err) {
        return { ok: false, error: `Couldn't fetch the file: ${(err as Error)?.message ?? err}` };
    }

    // Decode (synchronous, pure-JS — no Worker). A throw becomes a structured error.
    try {
        const out = runConverter(kind, input);
        return { ok: true, mime: out.mime, b64: Buffer.from(out.bytes).toString("base64") };
    } catch (err) {
        return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
}
