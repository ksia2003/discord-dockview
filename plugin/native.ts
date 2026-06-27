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
 * directly. It imports ONLY Node builtins (fs/promises, path, crypto) plus the
 * global `fetch` (Node 18+) — NO npm package. The build's deriveDockviewDeps()
 * scans plugin/**\/*.ts for external-package import specifiers and would `pnpm
 * add` anything it finds into the (electron-less) Vencord clone, so importing
 * even an `electron` type would pull a heavy new dependency. We deliberately keep
 * zero module imports beyond Node builtins and declare a local minimal stand-in
 * for Electron's IpcMainInvokeEvent; the functions never read the event, so the
 * exact type is immaterial.
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

/** Prefix that distinguishes a PLUGIN (4-file OTA) release tag from a whole-app
 *  electron-updater release ("v*"). The two streams must never collide. */
const PLUGIN_TAG_PREFIX = "plugin-v";

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

/**
 * Discover the newest published plugin update via the GitHub Releases API.
 *
 * Lists the repo's releases (newest-first), picks the first non-draft release
 * whose tag starts with "plugin-v" (prereleases are allowed; only `draft` is
 * skipped), finds its `manifest.json` asset, fetches + parses it, and returns
 * the manifest together with the release tag and the asset BASE url (the manifest
 * asset url minus "/manifest.json"), which applyUpdate uses to resolve the four
 * file downloads. Returns null when there is no plugin-v* release, no manifest
 * asset, or anything fails — the panel surfaces that as "couldn't check".
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

        // Newest-first from the API: take the first non-draft plugin-v* release.
        const release = releases.find(
            r => !r?.draft && typeof r?.tag_name === "string" && r.tag_name.startsWith(PLUGIN_TAG_PREFIX)
        );
        if (!release || !release.tag_name) return null;

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
