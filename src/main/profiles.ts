/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * DockView — multi-account PROFILES (data-dir isolation).
 * ---------------------------------------------------------------------------
 * A "profile" is a fully separate data directory: its own Discord login, its own
 * Vencord/DockView settings, its own Electron storage. Opening a profile spawns
 * another instance of this app pointed at that directory — there is no token
 * handling and no shared session, so the settings/session collisions the shared-
 * data clients suffer (Legcord #685) are structurally impossible here.
 *
 * This module ONLY resolves the active profile's data dir + the profiles root. It
 * is imported early by constants.ts (before any lock / app.ready) so DATA_DIR — and
 * the userData path the single-instance lock keys on — scope to the profile. The
 * profile UX (list / create / open / delete) lives in the DockView plugin's native
 * side (plugin/native.ts); this file is the small main-process footprint that must
 * survive Vesktop rebases, so it stays minimal and self-contained.
 *
 * RESOLUTION (explicit env wins):
 *   1. VENCORD_USER_DATA_DIR set  → that exact dir is the data dir (an env-pinned
 *      profile; the test rig uses this). No --profile layout is applied.
 *   2. --profile=<name>           → <profilesRoot>/<name>.
 *   3. neither                    → the DEFAULT install (app.getPath("userData")),
 *      byte-identical to a build without this feature.
 *
 * profilesRoot = <appData>/VesktopProfiles — a clearly-named SIBLING of the default
 * data dir that groups every profile and can never be confused with it.
 */

import { app } from "electron";
import { readdirSync } from "fs";
import { join } from "path";

/** The directory that holds every named profile. A sibling of the default data
 *  dir (both under app.getPath("appData")), grouped under one obvious name. */
export const PROFILES_ROOT = join(app.getPath("appData"), "VesktopProfiles");

/** A profile name is restricted to a safe, path-friendly character set so it can
 *  never traverse out of PROFILES_ROOT or produce a surprising directory. Kept in
 *  sync with the plugin-side validation (native.ts createProfile). */
export const PROFILE_NAME_RE = /^[a-z0-9-_ ]{1,32}$/i;

/** Read the --profile=<name> CLI value, trimmed, or null when absent/blank. We
 *  scan process.argv directly (constants.ts loads before cli.ts's parseArgs would
 *  be convenient, and this keeps the lookup dependency-free + robust to arg order).
 *  Both "--profile=name" and "--profile name" are accepted. */
export function getProfileArg(): string | null {
    const { argv } = process;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--profile" && i + 1 < argv.length) {
            const v = argv[i + 1].trim();
            return v || null;
        }
        if (a.startsWith("--profile=")) {
            const v = a.slice("--profile=".length).trim();
            return v || null;
        }
    }
    return null;
}

/** The active profile NAME, or null when running the default (unnamed) install.
 *  An explicit VENCORD_USER_DATA_DIR (env-pinned profile / the rig) reports its
 *  basename as the name so the tray + About can still label the instance; a
 *  --profile arg reports its (validated) name. */
export function getActiveProfileName(): string | null {
    const env = process.env.VENCORD_USER_DATA_DIR;
    if (env) {
        // Env-pinned: label with the dir's basename (best-effort; never affects paths).
        const parts = env.replace(/[\\/]+$/, "").split(/[\\/]/);
        return parts[parts.length - 1] || null;
    }
    const name = getProfileArg();
    if (name && PROFILE_NAME_RE.test(name)) return name;
    return null;
}

/** Synchronously enumerate the named profile dirs under PROFILES_ROOT (sorted). Used by
 *  the tray, which builds its menu synchronously. A missing root = no profiles yet (not
 *  an error); only real directories with a valid name count. Mirrors the plugin-side
 *  listProfilesImpl enumeration (the two independently read the same dir). */
export function listProfileNames(): string[] {
    try {
        return readdirSync(PROFILES_ROOT, { withFileTypes: true })
            .filter(e => e.isDirectory() && PROFILE_NAME_RE.test(e.name))
            .map(e => e.name)
            .sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

/** Resolve the data dir for the active profile, or null when this is the default
 *  install (no env override, no valid --profile). constants.ts uses null to mean
 *  "leave DATA_DIR + userData exactly as upstream". An explicit env override is
 *  handled by constants.ts itself (it already wins there), so this only returns a
 *  path for the --profile case. */
export function getProfileDataDir(): string | null {
    // An explicit env override wins and is applied by constants.ts directly; don't
    // shadow it here.
    if (process.env.VENCORD_USER_DATA_DIR) return null;

    const name = getProfileArg();
    if (!name) return null;
    if (!PROFILE_NAME_RE.test(name)) {
        // A malformed --profile is ignored (falls back to default) rather than
        // crashing at boot; the plugin only ever spawns validated names.
        console.error(`Ignoring invalid --profile name: ${JSON.stringify(name)}`);
        return null;
    }
    return join(PROFILES_ROOT, name);
}
