/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * DockView — in-app APP-SHELL updater (main process).
 * ---------------------------------------------------------------------------
 * The plugin bundle updates itself over the air (plugin/native.ts rewrites the
 * files under VENCORD_FILES_DIR and reloads). The SHELL — the Vesktop main/preload
 * that ships inside app.asar — can't be patched that way; only an INSTALLER rewrites
 * it. This module drives that installer from inside the app, so a shell change lands
 * with one Apply instead of a manual download + reinstall.
 *
 * WHY MAIN, NOT THE PLUGIN. The plugin's native.ts runs in the Vencord compilation
 * domain and can't reach Electron's app/quit/relaunch or the OS. The shell installer
 * flow needs exactly those (spawn the setup exe, replace the running AppImage, pkexec
 * dpkg/rpm, then relaunch), so it lives here in Vesktop main and is exposed over the
 * VesktopNative.shellUpdate.* preload bridge — a SEPARATE channel from the plugin
 * updater, matching how the app already keeps its electron-updater channel separate.
 *
 * THREE APPLY PATHS + AN HONEST FALLBACK (see applyShellUpdate):
 *   win-nsis  → download the one-click Setup exe, sha256-verify, run it silently
 *               (/S), then quit so the installer can replace the files and relaunch.
 *   appimage  → download the new .AppImage, sha256-verify, atomically replace the
 *               file THIS process was launched from (process.env.APPIMAGE), keep it
 *               executable, then relaunch it. No admin rights.
 *   deb / rpm → download the package, sha256-verify, install via pkexec (one system
 *               password prompt: dpkg -i / rpm -U), then relaunch. If pkexec is
 *               absent we DON'T silently fail — we return { ok:false, manual:true }
 *               with the download url so the UI can show an honest "install it
 *               yourself" card.
 *   anything else (tar.gz / an unpacked dev run / an install method we can't drive)
 *               → { ok:false, manual:true } with the release page, never a broken
 *               half-apply.
 *
 * INTEGRITY. Every download is sha256-checked against the manifest before it is run
 * or moved into place — the same discipline the plugin updater uses. A hash mismatch
 * or a download failure aborts BEFORE anything live is touched, and the staged temp
 * file is cleaned up.
 *
 * The one Node-only surface here is child_process + fs + crypto + the global fetch;
 * all Electron access (app.quit / relaunch / getPath) comes through the imported
 * `app`, since this file compiles in the Vesktop (not the Vencord) domain and CAN
 * import electron directly.
 */

import { execFile, spawn } from "child_process";
import { createHash } from "crypto";
import { app } from "electron";
import { createReadStream, createWriteStream } from "fs";
import { chmod, copyFile, mkdir, rename, stat, unlink } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

/** How the running app was installed — the key we match a manifest installer on.
 *  "unknown" covers a tar.gz extract, an unpacked dev run, or anything we can't drive. */
export type InstallMethod = "win-nsis" | "appimage" | "deb" | "rpm" | "unknown";

/** What the renderer needs to reason about a shell update: how we're installed, which
 *  CPU arch we are (so it picks the matching installer), and whether we can drive an
 *  in-app apply at all (false → the UI only offers the manual download link). */
export interface ShellUpdateInfo {
    method: InstallMethod;
    arch: string;
    /** A human label for the Updates page, e.g. "AppImage" or "Windows installer". */
    methodLabel: string;
    /** True when applyShellUpdate can actually perform the install for this method. */
    canAutoUpdate: boolean;
}

/** One installer entry as recorded in the manifest's shell.installers map. */
interface ShellInstaller {
    method?: string;
    arch?: string;
    assetName?: string;
    sha256?: string;
    size?: number;
    url?: string;
}

/** The manifest's `shell` block (only the fields we read). */
interface ShellManifest {
    version?: string;
    installers?: Record<string, ShellInstaller>;
}

/** The result of an apply attempt. `manual:true` means we can't drive it here — the
 *  UI should surface `url` (a direct installer download) so the user finishes by hand. */
export interface ShellApplyResult {
    ok: boolean;
    /** We couldn't auto-apply, but here's the download to do it manually. */
    manual?: boolean;
    /** The direct installer url for a manual finish (present when manual is true). */
    url?: string;
    error?: string;
}

/** How long a download may take before we abort (ms). Installers are tens of MB. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Where staged installer downloads land before they're verified + run/committed. */
function stagingDir(): string {
    return join(tmpdir(), "dockview-shell-update");
}

/**
 * Detect how THIS instance was installed. AppImage is unambiguous (the runtime sets
 * process.env.APPIMAGE to the running image path). Windows packaged = the NSIS build.
 * On Linux we can't tell deb from rpm at runtime from process state alone, so we probe
 * the package databases: a dpkg record for our package ⇒ deb, else an rpm record ⇒ rpm.
 * A dev/unpacked run (app.isPackaged false) or anything unrecognised ⇒ "unknown", which
 * the UI treats as manual-only.
 */
export async function detectInstallMethod(): Promise<InstallMethod> {
    // AppImage first — the env var is set by the runtime and is definitive.
    if (process.env.APPIMAGE) return "appimage";

    // A non-packaged run (electron . / linux-unpacked) can't be installer-updated.
    if (!app.isPackaged) return "unknown";

    if (process.platform === "win32") return "win-nsis";

    if (process.platform === "linux") {
        // Ask the package managers whether they own our executable name. dpkg-query
        // succeeds (exit 0) only for an installed .deb; rpm -q likewise for an .rpm.
        if (await packageInstalled("dpkg-query", ["-W", "vesktop"])) return "deb";
        if (await packageInstalled("rpm", ["-q", "vesktop"])) return "rpm";
        return "unknown";
    }

    // macOS (dmg/zip) and anything else: no in-app installer path here.
    return "unknown";
}

/** Run a query command and resolve true iff it exits 0 (the package is installed).
 *  Any spawn error (command absent) resolves false — we simply can't confirm it. */
function packageInstalled(cmd: string, args: string[]): Promise<boolean> {
    return new Promise(resolve => {
        try {
            execFile(cmd, args, { timeout: 5000 }, err => resolve(!err));
        } catch {
            resolve(false);
        }
    });
}

/** A human label per method, for the "Installed via: …" line on the Updates page. */
function methodLabel(method: InstallMethod): string {
    switch (method) {
        case "win-nsis":
            return "Windows installer";
        case "appimage":
            return "AppImage";
        case "deb":
            return "Debian package";
        case "rpm":
            return "RPM package";
        default:
            return "Manual install";
    }
}

/** Gather the info the renderer's Updates page needs. canAutoUpdate is false for
 *  "unknown" (and for deb/rpm we still return true — the manual fallback is decided
 *  at apply time when pkexec is probed, so the button stays available). */
export async function getShellUpdateInfo(): Promise<ShellUpdateInfo> {
    const method = await detectInstallMethod();
    return {
        method,
        arch: process.arch,
        methodLabel: methodLabel(method),
        canAutoUpdate: method !== "unknown"
    };
}

/** Pick the manifest installer that matches this instance's method + arch. Falls back
 *  to a method-only match when no arch-tagged entry exists (older single-arch releases).
 *  Returns null when nothing matches (the UI then shows the manual/no-installer copy). */
function pickInstaller(shell: ShellManifest, method: InstallMethod, arch: string): ShellInstaller | null {
    const installers = shell?.installers;
    if (!installers || typeof installers !== "object") return null;
    const exact = installers[`${method}-${arch}`];
    if (exact) return exact;
    // Fall back to any entry with a matching method (single-arch / legacy key shape).
    for (const entry of Object.values(installers)) {
        if (entry?.method === method) return entry;
    }
    return null;
}

/** Lower-cased hex sha256 of a file's bytes (streamed, so a large installer doesn't
 *  sit fully in memory). */
async function sha256File(path: string): Promise<string> {
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
        const s = createReadStream(path);
        s.on("data", d => hash.update(d));
        s.on("end", () => resolve());
        s.on("error", reject);
    });
    return hash.digest("hex").toLowerCase();
}

/** Resolve a manifest installer url against the release base (absolute stays put). */
function resolveUrl(url: string, baseUrl: string): string {
    try {
        return new URL(url, baseUrl || undefined).href;
    } catch {
        return url;
    }
}

/**
 * Download `url` to `dest` with a timeout, then sha256-verify against `wantSha`. On any
 * failure (network, timeout, hash mismatch) the partial file is removed and an Error is
 * thrown. Nothing live is touched — the caller only commits/runs a verified file.
 */
async function downloadAndVerify(url: string, dest: string, wantSha: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok || !res.body) {
            throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        }
        await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest, { autoClose: true }));
    } catch (err) {
        await unlink(dest).catch(() => {});
        throw err instanceof Error ? err : new Error(String(err));
    } finally {
        clearTimeout(timer);
    }

    const got = await sha256File(dest);
    const want = (wantSha || "").trim().toLowerCase();
    if (!want || got !== want) {
        await unlink(dest).catch(() => {});
        throw new Error(`sha256 mismatch: expected ${want || "(none)"}, got ${got}`);
    }
}

/** Relaunch the app the same way the shell's own RELAUNCH IPC does (AppImage-aware),
 *  then exit. Used after an AppImage self-replace so the NEW image runs. */
function relaunchAndExit(execTarget?: string): void {
    const args = process.argv.slice(1).concat(["--relaunch"]);
    if (execTarget) {
        // Re-exec the (freshly written) AppImage explicitly, not app.relaunch's copy of
        // the old path — the file at that path is the new one now.
        execFile(execTarget, args);
    } else {
        app.relaunch({ args });
    }
    app.exit();
}

/**
 * Apply a shell update: download the installer for this instance's method + arch,
 * sha256-verify it, then run the method-specific install and relaunch. Returns a
 * structured result; a method we can't drive returns { ok:false, manual:true, url }
 * so the UI shows an honest manual-install card rather than a dead end.
 *
 * The `shell` argument is the manifest's `shell` block; `baseUrl` is the release
 * download base (used to resolve a relative installer url).
 */
export async function applyShellUpdate(shell: ShellManifest, baseUrl: string): Promise<ShellApplyResult> {
    const method = await detectInstallMethod();
    const installer = pickInstaller(shell, method, process.arch);

    // No installer for us in this release, or we can't drive this method → manual.
    if (method === "unknown") {
        return { ok: false, manual: true, url: installer?.url ? resolveUrl(installer.url, baseUrl) : undefined };
    }
    if (!installer || !installer.url || !installer.sha256) {
        return { ok: false, manual: true, url: installer?.url ? resolveUrl(installer.url, baseUrl) : undefined };
    }

    const url = resolveUrl(installer.url, baseUrl);
    const dir = stagingDir();
    const dest = join(dir, installer.assetName || basename(new URL(url).pathname) || "installer.bin");

    try {
        await mkdir(dir, { recursive: true });
        await downloadAndVerify(url, dest, installer.sha256);
    } catch (err) {
        return { ok: false, error: `Download failed: ${(err as Error)?.message ?? err}` };
    }

    try {
        switch (method) {
            case "win-nsis":
                return await applyWindows(dest);
            case "appimage":
                return await applyAppImage(dest);
            case "deb":
                return await applyLinuxPackage(dest, "deb", url);
            case "rpm":
                return await applyLinuxPackage(dest, "rpm", url);
            default:
                return { ok: false, manual: true, url };
        }
    } catch (err) {
        await unlink(dest).catch(() => {});
        return { ok: false, error: `Install failed: ${(err as Error)?.message ?? err}` };
    }
}

/**
 * Windows: run the one-click NSIS Setup exe silently (/S), detached so it outlives us,
 * then quit. electron-builder's one-click installer replaces the install and relaunches
 * the app itself when it finishes, so we do NOT relaunch here (a relaunch would race the
 * installer over locked files). We give the spawn a beat, then app.quit().
 */
async function applyWindows(setupExe: string): Promise<ShellApplyResult> {
    const child = spawn(setupExe, ["/S"], { detached: true, stdio: "ignore" });
    child.unref();
    // Quit shortly after so the running exe isn't holding files the installer replaces.
    setTimeout(() => app.quit(), 1500);
    return { ok: true };
}

/**
 * AppImage: atomically replace the running image. Write the new bytes next to the old
 * image as "<name>.new", copy the old file's mode (keep it executable), then rename it
 * over the original (rename is atomic on the same filesystem). Finally re-exec the new
 * image. process.env.APPIMAGE is the path the runtime launched us from.
 */
async function applyAppImage(newImage: string): Promise<ShellApplyResult> {
    const target = process.env.APPIMAGE;
    if (!target) return { ok: false, error: "Not running from an AppImage." };

    const finalTmp = join(dirname(target), `${basename(target)}.new`);
    try {
        // Copy the downloaded image next to the target (same fs → rename is atomic).
        await copyFile(newImage, finalTmp);
        // Preserve executability (match the old image's mode, default 0o755).
        let mode = 0o755;
        try {
            mode = (await stat(target)).mode;
        } catch {
            /* target stat failed — fall back to 0o755 */
        }
        await chmod(finalTmp, mode);
        await rename(finalTmp, target);
    } catch (err) {
        await unlink(finalTmp).catch(() => {});
        throw err;
    } finally {
        await unlink(newImage).catch(() => {});
    }

    relaunchAndExit(target);
    return { ok: true };
}

/**
 * Linux deb/rpm: install via pkexec (one graphical system-password prompt), then
 * relaunch. If pkexec is missing we can't elevate, so we return a MANUAL result with
 * the download url — an honest "install this yourself" card, never a silent failure.
 * The install command is method-specific: `dpkg -i <file>` / `rpm -U --force <file>`.
 */
async function applyLinuxPackage(pkgFile: string, kind: "deb" | "rpm", url: string): Promise<ShellApplyResult> {
    const hasPkexec = await commandExists("pkexec");
    if (!hasPkexec) {
        await unlink(pkgFile).catch(() => {});
        return { ok: false, manual: true, url };
    }

    const installArgs =
        kind === "deb" ? ["pkexec", "dpkg", "-i", pkgFile] : ["pkexec", "rpm", "-U", "--force", pkgFile];

    await new Promise<void>((resolve, reject) => {
        execFile(installArgs[0], installArgs.slice(1), { timeout: 5 * 60 * 1000 }, err => {
            if (err) reject(err);
            else resolve();
        });
    });

    await unlink(pkgFile).catch(() => {});
    // A packaged install rewrites the on-disk app; relaunch runs the new one.
    relaunchAndExit();
    return { ok: true };
}

/** Whether a command is on PATH (used to gate the pkexec elevation path). */
function commandExists(cmd: string): Promise<boolean> {
    return new Promise(resolve => {
        try {
            execFile("which", [cmd], { timeout: 5000 }, err => resolve(!err));
        } catch {
            resolve(false);
        }
    });
}
