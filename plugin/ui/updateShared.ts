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

import { compareDockviewVersions } from "../version";

/** The public repo the updater checks. */
export const OWNER = "ksia2003";
export const REPO = "discord-dockview";

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
 *  Vencord's pluginHelpers bridge, so every method is async (ipcRenderer.invoke). */
export interface DockViewNative {
    discoverManifest: (owner: string, repo: string) => Promise<DiscoverResult>;
    readInstalledVersion: (targetDir: string) => Promise<string | null>;
    applyUpdate: (
        targetDir: string,
        manifest: any,
        baseUrl: string
    ) => Promise<{ ok: boolean; needsRelaunch: boolean; error?: string }>;
}

/** Resolve the native updater bridge, or null if this build doesn't expose it.
 *  Mirrors the openExternal.ts guard: optional-chain to the helper, then verify each
 *  function is callable before trusting it. */
export function getNative(): DockViewNative | null {
    try {
        const native = (window as any).VencordNative?.pluginHelpers?.DockView;
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

/** The install directory the updater writes into (VENCORD_FILES_DIR, honouring a
 *  custom vencordDir). Read synchronously off VesktopNative; null if unavailable. */
export function getTargetDir(): string | null {
    try {
        const dir = (window as any).VesktopNative?.fileManager?.getVencordDir?.();
        return typeof dir === "string" && dir ? dir : null;
    } catch {
        return null;
    }
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
