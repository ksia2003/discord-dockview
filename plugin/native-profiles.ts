/*
 * DockView — MAIN-process multi-account PROFILES (native-profiles.ts).
 * ---------------------------------------------------------------------------
 * This module runs in the Electron MAIN process (imported by native.ts, so it is
 * bundled into vencordDesktopMain.js — the Node target, no CSP, no esbuild
 * browser-builtin ban). It backs the "Profiles" settings page: enumerate / create /
 * open / delete the profile data dirs that the Vesktop-side plumbing (src/main/
 * profiles.ts + constants.ts) turns into isolated app instances.
 *
 * A PROFILE = a fully separate data directory (its own Discord login + its own
 * Vencord/DockView settings + its own Electron storage). "Open" spawns another
 * instance of THIS executable with `--profile=<name>`; the spawned instance's
 * constants.ts scopes DATA_DIR + userData (and thus the single-instance lock) to
 * <profilesRoot>/<name>. No token handling, no shared session — the settings/session
 * collisions the shared-data clients hit (Legcord #685) are structurally impossible.
 *
 * NO ELECTRON IMPORT. Like native.ts, this file deliberately does NOT import
 * "electron": the build's deriveDockviewDeps() scans plugin/**\/*.ts for external
 * package specifiers and would try to `pnpm add electron` into the Vencord clone
 * (electron is the runtime, not an npm dep). So we resolve the profiles root from
 * process.env / process.platform exactly the way Electron's app.getPath("appData")
 * does, and read process.execPath / process.argv directly. This MUST stay in sync
 * with src/main/profiles.ts (PROFILES_ROOT, PROFILE_NAME_RE, the resolution rules) —
 * the two independently compute the same paths.
 */

import { spawn } from "child_process";
import { mkdir, readdir, rm, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

/** A profile's on-disk presence + whether it's the one THIS instance is running. */
export interface ProfileInfo {
    name: string;
    /** true when this profile is the currently-running instance. */
    active: boolean;
}

/** The list result: every profile dir + the active profile name (null = default). */
export interface ProfilesList {
    profiles: ProfileInfo[];
    /** The name of the profile THIS instance runs as, or null for the default install. */
    current: string | null;
    /** Where profile dirs live, surfaced so the UI can show it honestly if needed. */
    root: string;
}

/** Profile-name charset — path-friendly, no traversal. Mirrors src/main/profiles.ts
 *  PROFILE_NAME_RE. Kept deliberately in sync (the two sides must agree). */
const PROFILE_NAME_RE = /^[a-z0-9-_ ]{1,32}$/i;

/**
 * The directory that holds every profile — a sibling of the default data dir under
 * Electron's "appData" path. We compute appData WITHOUT importing electron (see the
 * module header), matching Electron's own algorithm:
 *   linux   → $XDG_CONFIG_HOME or ~/.config
 *   win32   → %APPDATA%  (…/AppData/Roaming)
 *   darwin  → ~/Library/Application Support
 * MUST match src/main/profiles.ts PROFILES_ROOT (= appData/VesktopProfiles).
 */
function appDataDir(): string {
    const home = homedir();
    switch (process.platform) {
        case "win32":
            return process.env.APPDATA || join(home, "AppData", "Roaming");
        case "darwin":
            return join(home, "Library", "Application Support");
        default:
            return process.env.XDG_CONFIG_HOME || join(home, ".config");
    }
}

/** PROFILES_ROOT — must equal src/main/profiles.ts's constant of the same name. */
function profilesRoot(): string {
    return join(appDataDir(), "VesktopProfiles");
}

/**
 * The active profile NAME of THIS instance, or null when running the default
 * (unnamed) install. Mirrors src/main/profiles.ts getActiveProfileName():
 *   - VENCORD_USER_DATA_DIR set → the dir's basename (env-pinned profile).
 *   - --profile=<name>          → the validated name.
 *   - neither                   → null (default install).
 */
function currentProfileName(): string | null {
    const env = process.env.VENCORD_USER_DATA_DIR;
    if (env) {
        const parts = env.replace(/[\\/]+$/, "").split(/[\\/]/);
        return parts[parts.length - 1] || null;
    }
    const argv = process.argv;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        let name: string | null = null;
        if (a === "--profile" && i + 1 < argv.length) name = argv[i + 1].trim();
        else if (a.startsWith("--profile=")) name = a.slice("--profile=".length).trim();
        if (name && PROFILE_NAME_RE.test(name)) return name;
    }
    return null;
}

/** Enumerate the profile dirs + report which one is running. Missing root = no
 *  profiles yet (not an error). Only real directories with a valid name count. */
export async function listProfilesImpl(): Promise<ProfilesList> {
    const root = profilesRoot();
    const current = currentProfileName();
    let names: string[] = [];
    try {
        const entries = await readdir(root, { withFileTypes: true });
        names = entries.filter(e => e.isDirectory() && PROFILE_NAME_RE.test(e.name)).map(e => e.name);
    } catch {
        // Root doesn't exist yet → no profiles. Not an error.
        names = [];
    }
    names.sort((a, b) => a.localeCompare(b));
    const profiles = names.map(name => ({ name, active: name === current }));
    return { profiles, current, root };
}

/** Create a profile dir under the root. Validates the name, refuses a duplicate,
 *  and mkdir -p's <root>/<name>. Returns the created name on success. */
export async function createProfileImpl(name: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) return { ok: false, error: "Enter a profile name." };
    if (!PROFILE_NAME_RE.test(trimmed)) {
        return { ok: false, error: "Use letters, numbers, spaces, - or _ (max 32 characters)." };
    }
    const dir = join(profilesRoot(), trimmed);
    try {
        const s = await stat(dir).catch(() => null);
        if (s) return { ok: false, error: "A profile with that name already exists." };
        await mkdir(dir, { recursive: true });
        return { ok: true, name: trimmed };
    } catch (err) {
        return { ok: false, error: `Couldn't create the profile: ${(err as Error)?.message ?? err}` };
    }
}

/**
 * Open a profile in a NEW, DETACHED instance of this executable with
 * `--profile=<name>`. Works for both a packaged build and a linux-unpacked run —
 * process.execPath is the app binary in both. The child's env is cleaned of
 * VENCORD_USER_DATA_DIR so it doesn't inherit an env-pinned data dir from this
 * process (which would override --profile). detached + unref so the child outlives
 * the launcher, and its stdio is ignored.
 *
 * `extraArgs` lets a caller pass through additional flags (e.g. a distinct
 * --remote-debugging-port for engineering/CDP inspection of the spawned instance);
 * it defaults to none for normal use.
 */
export async function openProfileImpl(
    name: string,
    extraArgs: string[] = []
): Promise<{ ok: boolean; error?: string }> {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed || !PROFILE_NAME_RE.test(trimmed)) {
        return { ok: false, error: "Invalid profile name." };
    }
    try {
        // Ensure the dir exists so a first Open right after Create is safe.
        await mkdir(join(profilesRoot(), trimmed), { recursive: true });

        // Clean env so the child doesn't inherit THIS instance's env-pinned data dir.
        const env = { ...process.env };
        delete env.VENCORD_USER_DATA_DIR;

        const args = [`--profile=${trimmed}`, ...(Array.isArray(extraArgs) ? extraArgs : [])];
        const child = spawn(process.execPath, args, {
            detached: true,
            stdio: "ignore",
            env
        });
        child.unref();
        return { ok: true };
    } catch (err) {
        return { ok: false, error: `Couldn't open the profile: ${(err as Error)?.message ?? err}` };
    }
}

/**
 * Delete a profile dir (recursive). REFUSES to delete the profile THIS instance is
 * running as (you can't pull the rug out from under the live login). Also refuses a
 * name that isn't a real profile dir. The default install has no dir here and can't
 * be deleted through this path.
 */
export async function deleteProfileImpl(name: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed || !PROFILE_NAME_RE.test(trimmed)) {
        return { ok: false, error: "Invalid profile name." };
    }
    if (trimmed === currentProfileName()) {
        return { ok: false, error: "You can't delete the profile you're currently using. Open another profile first." };
    }
    const dir = join(profilesRoot(), trimmed);
    try {
        const s = await stat(dir).catch(() => null);
        if (!s || !s.isDirectory()) return { ok: false, error: "That profile doesn't exist." };
        await rm(dir, { recursive: true, force: true });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: `Couldn't delete the profile: ${(err as Error)?.message ?? err}` };
    }
}
