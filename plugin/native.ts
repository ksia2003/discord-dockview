/*
 * DockView — main-process update primitives (native.ts).
 * ---------------------------------------------------------------------------
 * This module runs in the Electron MAIN process, not the renderer. Vencord
 * auto-registers each exported async function of a plugin's native.ts as an
 * ipcMain handler keyed by the definePlugin `name` ("DockView", see index.tsx):
 *
 *     export async function fetchManifest(_, url) { ... }
 *        ⇒ ipcMain.handle("VencordPluginNative_DockView_fetchManifest", ...)
 *        ⇒ renderer calls VencordNative.pluginHelpers.DockView.fetchManifest(url)
 *
 * Electron injects the IpcMainInvokeEvent as the FIRST argument; the renderer
 * only supplies the real arguments after it. Every export here therefore has the
 * shape `async fn(_: IpcMainInvokeEvent, ...realArgs)` and ignores the event.
 *
 * Main has full Node and no CSP, so this file talks to the network and the disk
 * directly. The OTA primitives below import ONLY Node builtins (fs/promises, path,
 * crypto) plus the global `fetch` (Node 18+). The ONE npm dependency is the
 * attachment-converter module (./native-convert), which the convertAttachment IPC
 * dispatches to: those Node-only libs (@kenjiuno/msgreader, utif, …) belong in the
 * MAIN bundle precisely because the renderer can't run them (Buffer / web-Worker
 * bans). The build's deriveDockviewDeps() scans plugin/**\/*.ts for external-package
 * import specifiers and `pnpm add`s + bundles them — so importing native-convert here
 * pulls its libs into vencordDesktopMain.js (Node target, no browser-builtin ban)
 * automatically. We still declare a local minimal stand-in for Electron's
 * IpcMainInvokeEvent rather than importing "electron" (the event is never read, so
 * the exact type is immaterial and an electron type-dep is avoided).
 *
 * ATOMIC APPLY CONTRACT (applyUpdate)
 * -----------------------------------
 * An update is applied in two strict phases so a crash or a bad payload can never
 * leave a half-written, mixed-version install on disk:
 *
 *   Phase A — download + verify, touching NOTHING live. Every file in the
 *     manifest is fetched, sha256-checked against the manifest, and written to a
 *     sibling "<name>.dockview-tmp". ANY fetch failure or hash mismatch aborts the
 *     whole apply before a single real file is touched.
 *   Phase B — commit. Only once ALL files are present and verified as .dockview-tmp
 *     do we rename() each over its real path. version.txt is committed LAST, so a
 *     crash mid-commit leaves an older-but-internally-consistent stamp that the
 *     P2 always-copy guard / recovery path can still reason about.
 *
 * Leftover .dockview-tmp files are cleaned up on any failure. Errors are returned
 * as a structured { ok:false, error } rather than thrown, since the renderer panel
 * surfaces them to the user.
 */

import { createHash } from "crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";

import { runConverter } from "./native-convert";

/**
 * Local stand-in for Electron's IpcMainInvokeEvent. We do NOT import it from
 * "electron" on purpose: the build's deriveDockviewDeps() would treat that as an
 * external package and add it to the Vencord clone (which has no electron dep).
 * The event is never read here, so an opaque type is sufficient and honest.
 */
type IpcMainInvokeEvent = unknown;

/** Network timeout for manifest + file fetches (ms). */
const FETCH_TIMEOUT_MS = 15_000;

/** Suffix for staged, not-yet-committed payloads written during Phase A. */
const TMP_SUFFIX = ".dockview-tmp";

/** The four renderer/main bundle files plus the version stamp. version.txt is
 *  optional in a manifest but, when present, is committed LAST (see applyUpdate). */
const VERSION_FILE = "version.txt";

/** Shape of a single entry in manifest.files (see P4 make-plugin-manifest.mjs). */
interface ManifestFile {
    sha256: string;
    url: string;
}

/** The plugin update manifest (P4). Only the fields native.ts needs are typed;
 *  unknown fields are tolerated. */
interface UpdateManifest {
    schema?: unknown;
    pluginVersion?: string;
    vencordRef?: string;
    needsRelaunch?: boolean;
    files?: Record<string, ManifestFile>;
}

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

/** Resolve a manifest file url: absolute urls are used as-is, otherwise the url
 *  is resolved against baseUrl (the release/download base). */
function resolveUrl(url: string, baseUrl: string): string {
    try {
        // Absolute (http(s)://, //host, etc.) stays put; relative resolves on base.
        return new URL(url, baseUrl || undefined).href;
    } catch {
        return url;
    }
}

/** Lower-cased hex sha256 of a byte buffer. */
function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex").toLowerCase();
}

/**
 * Fetch the public manifest.json (no auth — public repo), parse it, and return
 * the object. Throws a clear Error on a non-200 response or a JSON parse failure;
 * the renderer catches and surfaces it.
 */
export async function fetchManifest(_: IpcMainInvokeEvent, manifestUrl: string): Promise<any> {
    const res = await fetchWithTimeout(manifestUrl, true);
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error(`Manifest at ${manifestUrl} is not valid JSON: ${(err as Error)?.message ?? err}`);
    }
}

/**
 * Read "<targetDir>/version.txt" (utf-8, trimmed) and return the raw string, or
 * null if it is missing or unreadable. Comparison is the renderer's job (it uses
 * plugin/version.ts's comparator); native does not interpret the value.
 */
export async function readInstalledVersion(_: IpcMainInvokeEvent, targetDir: string): Promise<string | null> {
    try {
        const raw = await readFile(join(targetDir, VERSION_FILE), "utf-8");
        return raw.trim();
    } catch {
        return null;
    }
}

/**
 * Read an out-of-bundle CHUNK file's source text from the install dir.
 * ---------------------------------------------------------------------------
 * The code-dense heavy libs (mermaid, pptx, codemirror, pdfjs, three) are built
 * as standalone chunk-<lib>.js files that ship ALONGSIDE the renderer/main
 * bundles in VENCORD_FILES_DIR (the same dir an OTA writes into). They are NOT
 * inline in vencordDesktopRenderer.js — that is the whole point (their bytes no
 * longer cost V8 compile at startup). The renderer pulls one in on first use via
 * this IPC: engine/lazyLib.ts asks for "chunk-mermaid.js", main reads it off disk
 * and returns the source, and the renderer eval()s it (CSP allows 'unsafe-eval').
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
export async function convertAttachment(_: IpcMainInvokeEvent, kind: string, url: string, allowRemote?: boolean): Promise<ConvertResult> {
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

    // Fetch the attachment bytes in main (no CSP here — same path as OTA fetches),
    // size-capped to keep a pathological url from exhausting memory.
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
    // allowRemote (the renderer's Privacy switch) is passed through to the converter so
    // main stays stateless — it holds no setting, it's told per-call. Only msg reads it.
    try {
        const out = runConverter(kind, input, { allowRemote: allowRemote === true });
        return { ok: true, mime: out.mime, b64: Buffer.from(out.bytes).toString("base64") };
    } catch (err) {
        return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
}

/**
 * Atomically apply an update into targetDir. See the ATOMIC APPLY CONTRACT in the
 * module header: download + sha256-verify EVERY file to ".dockview-tmp" first,
 * then rename them all over the live files (version.txt last). Never returns a
 * partially-applied install. Returns a structured result instead of throwing.
 */
export async function applyUpdate(
    _: IpcMainInvokeEvent,
    targetDir: string,
    manifest: UpdateManifest,
    baseUrl: string
): Promise<{ ok: boolean; needsRelaunch: boolean; error?: string }> {
    const files = manifest?.files;
    if (!files || typeof files !== "object") {
        return { ok: false, needsRelaunch: false, error: "Manifest has no files map" };
    }

    // Order the names so version.txt is committed LAST in Phase B. Every other
    // file (the four bundles, or any future addition) is committed before it.
    const names = Object.keys(files);
    if (names.length === 0) {
        return { ok: false, needsRelaunch: false, error: "Manifest files map is empty" };
    }
    const commitOrder = [
        ...names.filter(n => n !== VERSION_FILE),
        ...names.filter(n => n === VERSION_FILE)
    ];

    const tmpPathOf = (name: string) => join(targetDir, name + TMP_SUFFIX);

    // Best-effort cleanup of every staged tmp file (used on any abort/failure).
    const cleanupTmps = async () => {
        await Promise.all(
            commitOrder.map(name => unlink(tmpPathOf(name)).catch(() => { /* not present */ }))
        );
    };

    try {
        // Ensure the target directory exists (custom vencordDir may be fresh).
        await mkdir(targetDir, { recursive: true });

        // ---- Phase A: download + verify EVERY file to .dockview-tmp. ----
        // Touch NOTHING live here. On the FIRST failure, clean up and abort.
        for (const name of commitOrder) {
            const entry = files[name];
            if (!entry || typeof entry.url !== "string" || typeof entry.sha256 !== "string") {
                await cleanupTmps();
                return { ok: false, needsRelaunch: false, error: `Manifest entry for "${name}" is malformed` };
            }

            const url = resolveUrl(entry.url, baseUrl);
            let bytes: Uint8Array;
            try {
                const res = await fetchWithTimeout(url, true);
                bytes = new Uint8Array(await res.arrayBuffer());
            } catch (err) {
                await cleanupTmps();
                return {
                    ok: false,
                    needsRelaunch: false,
                    error: `Download failed for "${name}": ${(err as Error)?.message ?? err}`
                };
            }

            const got = sha256Hex(bytes);
            const want = entry.sha256.trim().toLowerCase();
            if (got !== want) {
                await cleanupTmps();
                return {
                    ok: false,
                    needsRelaunch: false,
                    error: `sha256 mismatch for "${name}": expected ${want}, got ${got}`
                };
            }

            try {
                await writeFile(tmpPathOf(name), bytes);
            } catch (err) {
                await cleanupTmps();
                return {
                    ok: false,
                    needsRelaunch: false,
                    error: `Could not stage "${name}": ${(err as Error)?.message ?? err}`
                };
            }
        }

        // ---- Phase B: commit. All files verified — rename each over its real ----
        // path, version.txt LAST. A crash mid-loop leaves an older-but-consistent
        // version.txt (the guard/recovery still recover).
        for (const name of commitOrder) {
            try {
                await rename(tmpPathOf(name), join(targetDir, name));
            } catch (err) {
                // A failure here is partial (some renames already landed) but every
                // committed file is a verified payload; only the stamp may lag. Clean
                // up the remaining tmps and report.
                await cleanupTmps();
                return {
                    ok: false,
                    needsRelaunch: false,
                    error: `Commit (rename) failed for "${name}": ${(err as Error)?.message ?? err}`
                };
            }
        }

        return { ok: true, needsRelaunch: !!manifest.needsRelaunch };
    } catch (err) {
        await cleanupTmps();
        return { ok: false, needsRelaunch: false, error: `Apply failed: ${(err as Error)?.message ?? err}` };
    }
}

/** Prefix of the DockView-versioned release tags ("vX.Y.Z"). These are the SAME
 *  clean releases that carry the app installers; the plugin bundle now ships as
 *  extra assets on them (a manifest.json + the four bundle files + chunks), so the
 *  in-app updater and the installers share one release stream. This is a SEPARATE
 *  update channel from the app's electron-updater (which is tied to the Vesktop
 *  version) — it delivers DockView-version plugin updates. discoverManifest only
 *  ever picks a release that actually HAS the manifest.json asset, so an
 *  installer-only release without the bundle is skipped, not mistaken for a plugin
 *  update. */
const PLUGIN_TAG_PREFIX = "v";

/** GitHub requires a User-Agent on the REST API; the repo is public so no token. */
const GH_HEADERS = {
    "User-Agent": "DockView-Updater",
    Accept: "application/vnd.github+json"
} as const;

/** Minimal shape of the GitHub release objects we read (only the fields we use). */
interface GhAsset { name?: string; browser_download_url?: string; }
interface GhRelease {
    tag_name?: string;
    draft?: boolean;
    prerelease?: boolean;
    assets?: GhAsset[];
}

/** Compare two "vX.Y.Z" tags by NUMERIC version (so 0.1.10 > 0.1.9, which a
 *  lexical compare gets wrong). Returns >0 when `a` is the newer version. Self-
 *  contained (native.ts imports only Node builtins, so no shared compare helper). */
function cmpPluginTag(a: string, b: string): number {
    const ver = (t: string) => t.slice(PLUGIN_TAG_PREFIX.length).split(".").map(n => parseInt(n, 10) || 0);
    const av = ver(a);
    const bv = ver(b);
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
        const d = (av[i] || 0) - (bv[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

/**
 * Discover the newest published plugin update via the GitHub Releases API.
 *
 * Lists the repo's releases, keeps only the non-draft "v*" releases that ACTUALLY
 * CARRY a `manifest.json` asset (an installer-only release without the plugin
 * bundle is skipped here rather than picked-then-nulled), picks the one with the
 * highest NUMERIC version, fetches + parses its manifest, and returns the manifest
 * together with the release tag and the asset BASE url (the manifest asset url
 * minus "/manifest.json"), which applyUpdate uses to resolve the file downloads.
 * Returns null when no such release exists or anything fails — the panel surfaces
 * that as "couldn't check".
 *
 * Network-only (the `fetch` global + the shared fetchWithTimeout); imports no new
 * module. The leading IpcMainInvokeEvent is injected by Electron and ignored.
 */
export async function discoverManifest(
    _: IpcMainInvokeEvent,
    owner: string,
    repo: string
): Promise<{ manifest: any; releaseTag: string; baseUrl: string } | null> {
    try {
        const listUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let releases: GhRelease[];
        try {
            const res = await fetch(listUrl, { signal: controller.signal, headers: GH_HEADERS });
            if (!res.ok) return null;
            releases = (await res.json()) as GhRelease[];
        } finally {
            clearTimeout(timer);
        }
        if (!Array.isArray(releases)) return null;

        // The GitHub API list order is NOT reliably newest-first BY VERSION (a two-digit
        // patch like 0.1.10 lands after 0.1.9 in the list). Keep only the non-draft "v*"
        // releases that actually carry the plugin's manifest.json asset (the clean
        // DockView releases also carry the installers, and an installer-only release has
        // no manifest.json — skip it here rather than pick it then null out), then take
        // the one with the highest NUMERIC version.
        const candidates = releases.filter(
            r =>
                !r?.draft &&
                typeof r?.tag_name === "string" &&
                r.tag_name.startsWith(PLUGIN_TAG_PREFIX) &&
                (r.assets ?? []).some(a => a?.name === "manifest.json")
        );
        if (!candidates.length) return null;
        const release = candidates.reduce((best, r) => (cmpPluginTag(r.tag_name!, best.tag_name!) > 0 ? r : best));
        if (!release.tag_name) return null;

        const manifestAsset = (release.assets ?? []).find(a => a?.name === "manifest.json");
        const manifestUrl = manifestAsset?.browser_download_url;
        if (!manifestUrl) return null;

        // The asset download base = the manifest url minus its "/manifest.json"
        // tail. applyUpdate resolves each file's (relative or absolute) url on it.
        const baseUrl = manifestUrl.replace(/\/manifest\.json$/i, "");

        const manRes = await fetchWithTimeout(manifestUrl, true);
        const text = await manRes.text();
        let manifest: any;
        try {
            manifest = JSON.parse(text);
        } catch {
            return null;
        }

        return { manifest, releaseTag: release.tag_name, baseUrl };
    } catch {
        return null;
    }
}
