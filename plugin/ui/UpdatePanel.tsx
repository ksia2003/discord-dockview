/*
 * DockView — self-update settings panel (renderer).
 * ---------------------------------------------------------------------------
 * The React surface for the "DockView updates" section in Vencord's plugin
 * settings (wired in via settings.ts's OptionType.COMPONENT entry). It reports
 * three versions — RUNNING (the compiled DOCKVIEW_PLUGIN_VERSION), ON-DISK (the
 * version.txt in VENCORD_FILES_DIR, which an OTA patch may have already written),
 * and LATEST (the newest published plugin-v* release on GitHub) — derives a one
 * line verdict, and drives the native updater with Check / Apply buttons.
 *
 * IMPORTANT — no import cycle. This module imports ONLY ../version, @webpack/common,
 * and ../strings. It does NOT import settings.ts, index.tsx, or panel.tsx; the two
 * runtime bridges are read off `window` at call time:
 *   - VesktopNative.fileManager.getVencordDir()  → targetDir (the install dir)
 *   - VesktopNative.app.relaunch()               → relaunch after a main change
 *   - VencordNative.pluginHelpers.DockView.*      → the native.ts updater (main)
 * Each access is guarded (typeof + try/catch) and degrades to an "unavailable"
 * fallback, mirroring plugin/external/openExternal.ts:134. settings.ts can import
 * THIS module at top level without forming a cycle, because nothing here reaches
 * back into it.
 */

import { Button, Forms, React, Text } from "@webpack/common";

import { STRINGS } from "../strings";
import { compareDockviewVersions, DOCKVIEW_PLUGIN_VERSION, parseVersionTxt } from "../version";

const OWNER = "ksia2003";
const REPO = "discord-dockview";

const U = STRINGS.update;

/** Wrap a bare plugin version (e.g. "0.1.1") in the canonical version.txt shape so
 *  compareDockviewVersions — which compares version.txt STRINGS — can order it. The
 *  vencordRef/gitHash slots are placeholders the comparator ignores. "" for a null
 *  input sorts as oldest (the comparator treats unparseable as legacy/oldest). */
const pluginStamp = (plugin: string | null) => (plugin ? `dockview:${plugin} x x` : "");

/** The subset of native.ts (main process) the panel calls. Reached via Vencord's
 *  pluginHelpers bridge, so every method is async (ipcRenderer.invoke). */
interface DockViewNative {
    discoverManifest: (
        owner: string,
        repo: string
    ) => Promise<{ manifest: any; releaseTag: string; baseUrl: string } | null>;
    readInstalledVersion: (targetDir: string) => Promise<string | null>;
    applyUpdate: (
        targetDir: string,
        manifest: any,
        baseUrl: string
    ) => Promise<{ ok: boolean; needsRelaunch: boolean; error?: string }>;
}

/** Resolve the native updater bridge, or null if this build doesn't expose it.
 *  Mirrors the openExternal.ts guard: optional-chain to the helper, then verify
 *  each function is callable before trusting it. */
function getNative(): DockViewNative | null {
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
function getTargetDir(): string | null {
    try {
        const dir = (window as any).VesktopNative?.fileManager?.getVencordDir?.();
        return typeof dir === "string" && dir ? dir : null;
    } catch {
        return null;
    }
}

/** Best-effort relaunch of the whole app (main/preload changed). */
function relaunchApp(): void {
    try {
        (window as any).VesktopNative?.app?.relaunch?.();
    } catch {
        /* ignore — fall back to a reload at the call site */
    }
}

/** One version row: a muted label and its value (or an em-dash when unknown). */
function versionRow(label: string, value: string | null) {
    return React.createElement(
        "div",
        { style: { display: "flex", justifyContent: "space-between", gap: "12px", margin: "2px 0" } },
        React.createElement(Text, { variant: "text-sm/normal", style: { color: "var(--text-muted)" } }, label),
        React.createElement(
            Text,
            { variant: "text-sm/medium", style: { fontVariantNumeric: "tabular-nums" } },
            value ?? "—"
        )
    );
}

export function UpdatePanel() {
    const { useState, useCallback, useEffect } = React;

    const native = getNative();
    const targetDir = getTargetDir();

    // On-disk version.txt (read once on mount). null until read / if unreadable.
    const [installed, setInstalled] = useState<string | null>(null);
    // The fetched latest manifest + its plugin version, after a successful Check.
    const [latest, setLatest] = useState<{ manifest: any; baseUrl: string; version: string | null } | null>(null);
    const [checking, setChecking] = useState(false);
    const [applying, setApplying] = useState(false);
    // A one-line status; null = show the derived verdict instead.
    const [status, setStatus] = useState<string | null>(null);
    const [applied, setApplied] = useState(false);

    // Read the on-disk stamp once (transient pre-render shows "—").
    useEffect(() => {
        if (!native || !targetDir) return;
        let live = true;
        native
            .readInstalledVersion(targetDir)
            .then(raw => { if (live) setInstalled(raw); })
            .catch(() => { if (live) setInstalled(null); });
        return () => { live = false; };
    }, []);

    const onCheck = useCallback(async () => {
        if (!native) return;
        setChecking(true);
        setStatus(null);
        try {
            const found = await native.discoverManifest(OWNER, REPO);
            if (!found) {
                setLatest(null);
                setStatus(U.noRelease);
                return;
            }
            const pv = found.manifest?.pluginVersion;
            const version = typeof pv === "string" && pv ? pv : null;
            setLatest({ manifest: found.manifest, baseUrl: found.baseUrl, version });
        } catch (err) {
            setLatest(null);
            setStatus(U.error((err as Error)?.message ?? String(err)));
        } finally {
            setChecking(false);
        }
    }, [native]);

    const onApply = useCallback(async () => {
        if (!native || !targetDir || !latest) return;
        setApplying(true);
        setStatus(null);
        try {
            const res = await native.applyUpdate(targetDir, latest.manifest, latest.baseUrl);
            if (res.ok) {
                setApplied(true);
                if (res.needsRelaunch) {
                    setStatus(U.needsRelaunch);
                    relaunchApp();
                } else {
                    setStatus(U.appliedNeedsReload);
                    location.reload();
                }
            } else {
                setStatus(U.error(res.error ?? "unknown error"));
            }
        } catch (err) {
            setStatus(U.error((err as Error)?.message ?? String(err)));
        } finally {
            setApplying(false);
        }
    }, [native, targetDir, latest]);

    // --- updater missing entirely → a single sober fallback line. -----------
    if (!native) {
        return React.createElement(
            "div",
            null,
            React.createElement(Forms.FormTitle, { tag: "h3" }, U.sectionTitle),
            React.createElement(
                Forms.FormText,
                { style: { color: "var(--text-muted)" } },
                U.unavailable
            )
        );
    }

    const current = DOCKVIEW_PLUGIN_VERSION;
    const latestVer = latest?.version ?? null;

    // Is the latest published build newer than what's on disk? (installed is a raw
    // version.txt string; latestVer is a bare plugin version → stamp it to compare.)
    const updateAvailable =
        !!latestVer && compareDockviewVersions(pluginStamp(latestVer), installed ?? "") === 1;
    // A patch is on disk but the running code is older → a reload runs it.
    const patchPending =
        !!installed && compareDockviewVersions(installed, pluginStamp(current)) === 1;

    // Derive the verdict line shown when there's no transient status set.
    let verdict: string;
    if (applied) {
        verdict = status ?? U.appliedNeedsReload;
    } else if (status) {
        verdict = status;
    } else if (latest === null) {
        verdict = patchPending ? U.appliedNeedsReload : U.notChecked;
    } else if (updateAvailable && latestVer) {
        verdict = U.updateAvailable(latestVer);
    } else if (patchPending) {
        verdict = U.appliedNeedsReload;
    } else {
        verdict = U.upToDate;
    }

    return React.createElement(
        "div",
        null,
        React.createElement(Forms.FormTitle, { tag: "h3" }, U.sectionTitle),
        React.createElement(
            Forms.FormText,
            { style: { marginBottom: "8px", color: "var(--text-muted)" } },
            U.intro
        ),
        React.createElement(
            "div",
            { style: { margin: "8px 0" } },
            versionRow(U.current, current),
            versionRow(U.onDisk, parseVersionTxt(installed ?? "").plugin ?? installed),
            versionRow(U.latest, latestVer)
        ),
        React.createElement(
            Text,
            { variant: "text-sm/normal", style: { display: "block", margin: "8px 0", color: "var(--text-muted)" } },
            verdict
        ),
        React.createElement(
            "div",
            { style: { display: "flex", gap: "8px", marginTop: "10px" } },
            React.createElement(
                Button,
                {
                    size: Button.Sizes.SMALL,
                    color: Button.Colors.PRIMARY,
                    disabled: checking || applying,
                    onClick: onCheck
                },
                checking ? U.checking : U.check
            ),
            React.createElement(
                Button,
                {
                    size: Button.Sizes.SMALL,
                    color: Button.Colors.BRAND,
                    disabled: applying || checking || !updateAvailable || !targetDir,
                    onClick: onApply
                },
                applying ? U.applying : U.apply
            )
        )
    );
}
