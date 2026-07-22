/*
 * DockView — shared updater plumbing (renderer).
 * ---------------------------------------------------------------------------
 * The pieces the on-demand Updates page (UpdatePanel.tsx) and the once-a-day
 * background check (autoCheck.ts) both need: the repo coordinates, the native.ts
 * bridge shape + a guarded resolver, and the version helpers that decide whether a
 * discovered build is newer than the one on disk. Kept in ONE place so the two
 * callers can't drift (a repo rename, a bridge-method rename, or a compare rule
 * change lands here once).
 *
 * NO import cycle + NO module-top webpack: this imports only ../version (a pure
 * module) and reads the runtime bridges off `window` at call time (guarded), the
 * same discipline UpdatePanel already uses.
 */

import { compareDockviewVersions, DOCKVIEW_RELEASE_REPOSITORY } from "../version";

/** The public repo the updater checks. */
export const [OWNER, REPO] = DOCKVIEW_RELEASE_REPOSITORY.split("/") as [string, string];

/** The discriminated result native.ts's discoverManifest returns. Mirrors the
 *  DiscoverResult union there (main + renderer share the shape by contract, not by
 *  import — native.ts can't be imported into the renderer). */
export type DiscoverResult =
    | { ok: true; manifest: any; releaseTag: string; baseUrl: string }
    | { ok: false; code: "rateLimited"; resetAt: number | null }
    | { ok: false; code: "network" }
    | { ok: false; code: "noRelease" }
    | { ok: false; code: "malformed" }
    | { ok: false; code: "httpError"; httpStatus: number };

/** The subset of native.ts (main process) the renderer updater calls. Reached via
 *  Vesktop.s fixed DockView bridge, so every method is async (ipcRenderer.invoke). */
export interface DockViewNative {
    discoverManifest: (owner: string, repo: string, includePrerelease?: boolean) => Promise<DiscoverResult>;
    readInstalledVersion: () => Promise<string | null>;
    applyUpdate: (manifest: any, baseUrl: string) => Promise<{ ok: boolean; needsRelaunch: boolean; error?: string }>;
}

export interface ShellUpdateInfo {
    method: "win-nsis" | "appimage" | "deb" | "rpm" | "unknown";
    arch: string;
    methodLabel: string;
    canAutoUpdate: boolean;
}

export interface ShellNative {
    getVersion: () => string;
    getInfo: () => Promise<ShellUpdateInfo>;
    apply: (
        shellManifest: unknown,
        baseUrl: string
    ) => Promise<{ ok: boolean; manual?: boolean; url?: string; error?: string }>;
}

/** Resolve the native updater bridge, or null if this build doesn't expose it.
 *  Mirrors the openExternal.ts guard: optional-chain to the helper, then verify each
 *  function is callable before trusting it. */
export function getNative(): DockViewNative | null {
    try {
        const native = (window as any).VesktopNative?.dockview;
        if (
            native &&
            typeof native.discoverManifest === "function" &&
            typeof native.readInstalledVersion === "function" &&
            typeof native.applyUpdate === "function"
        ) {
            return native as DockViewNative;
        }
    } catch {
        /* fall through to unavailable */
    }
    return null;
}

export function getShellNative(): ShellNative | null {
    try {
        const native = (window as any).VesktopNative?.shellUpdate;
        if (
            native &&
            typeof native.getVersion === "function" &&
            typeof native.getInfo === "function" &&
            typeof native.apply === "function"
        ) return native as ShellNative;
    } catch {
        /* fall through to unavailable */
    }
    return null;
}

export function getShellVersion(): string | null {
    try {
        const value = (window as any).VesktopNative?.shellUpdate?.getVersion?.();
        return typeof value === "string" && value ? value : null;
    } catch {
        return null;
    }
}

export function shellIsNewer(required: string | null, installed: string | null): boolean {
    if (!required) return false;
    const current = (installed ?? "").split(".");
    const next = required.split(".");
    for (let index = 0; index < Math.max(current.length, next.length); index++) {
        const currentPart = parseInt(current[index] ?? "0", 10) || 0;
        const nextPart = parseInt(next[index] ?? "0", 10) || 0;
        if (nextPart > currentPart) return true;
        if (nextPart < currentPart) return false;
    }
    return false;
}

/** Wrap a bare plugin version (e.g. "0.1.1") in the canonical version.txt shape so
 *  compareDockviewVersions — which compares version.txt STRINGS — can order it. The
 *  vencordRef/gitHash slots are placeholders the comparator ignores. "" for a null
 *  input sorts as oldest (the comparator treats unparseable as legacy/oldest). */
export const pluginStamp = (plugin: string | null) => (plugin ? `dockview:${plugin} x x` : "");

/** Is a discovered plugin version newer than what version.txt reports on disk?
 *  `installed` is a raw version.txt string; `latestVer` is a bare plugin version. */
export function isNewer(latestVer: string | null, installed: string | null): boolean {
    return !!latestVer && compareDockviewVersions(pluginStamp(latestVer), installed ?? "") === 1;
}
