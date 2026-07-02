/*
 * DockView — self-update settings panel (renderer).
 * ---------------------------------------------------------------------------
 * The React surface for the "DockView updates" section in Vencord's plugin
 * settings (wired in via settings.ts's OptionType.COMPONENT entry). It reports
 * three versions — RUNNING (the compiled DOCKVIEW_PLUGIN_VERSION), ON-DISK (the
 * version.txt in VENCORD_FILES_DIR, which an OTA patch may have already written),
 * and LATEST (the newest DockView v* release on GitHub that carries the plugin
 * bundle) — derives a one line verdict, and drives the native updater with
 * Check / Apply buttons.
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

import { Button, Forms, React, Switch, Text } from "@webpack/common";

import { downloadUrl } from "../external/openExternal";
import { settings } from "../settings";
import { STRINGS } from "../strings";
import { compareDockviewVersions, DOCKVIEW_PLUGIN_VERSION, parseVersionTxt } from "../version";
import { clearUpdateFlag } from "./autoCheck";
import {
    DiscoverResult, getNative, getShellNative, getShellVersion, getTargetDir, OWNER, pluginStamp, REPO,
    shellIsNewer, ShellUpdateInfo
} from "./updateShared";

const U = STRINGS.update;
const SH = STRINGS.update.shell;

/** Turn a discovery FAILURE (never the ok case) into its precise one-line copy. Each
 *  code maps to its own sentence so the panel never shows a silent "—" or a vague
 *  "couldn't check". rateLimited formats the reset time in the user's LOCALE. */
function failCopy(res: Extract<DiscoverResult, { ok: false }>): string {
    switch (res.code) {
        case "rateLimited": {
            let time: string | null = null;
            if (res.resetAt) {
                try {
                    time = new Date(res.resetAt * 1000).toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit"
                    });
                } catch { time = null; }
            }
            return U.fail.rateLimited(time);
        }
        case "network": return U.fail.network;
        case "httpError": return U.fail.http(res.httpStatus);
        case "malformed": return U.fail.malformed;
        case "noRelease": return U.fail.noRelease;
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

    // The reactive settings store — the auto-check switch persists + re-renders through it.
    const store = settings.use(["autoCheckUpdates"]);

    // On-disk version.txt (read once on mount). null until read / if unreadable.
    const [installed, setInstalled] = useState<string | null>(null);
    // The fetched latest manifest + its plugin version, after a successful Check.
    const [latest, setLatest] = useState<{ manifest: any; baseUrl: string; version: string | null } | null>(null);
    const [checking, setChecking] = useState(false);
    const [applying, setApplying] = useState(false);
    // A one-line status; null = show the derived verdict instead.
    const [status, setStatus] = useState<string | null>(null);
    // True when the LAST check failed (any discovery error) → the panel offers Retry.
    const [checkFailed, setCheckFailed] = useState(false);
    const [applied, setApplied] = useState(false);

    // --- app-shell state (the installer-driven update of Vesktop itself) ---------
    // How the app is installed (for the "Installed via:" line + which installer to
    // fetch), read once on mount. The compiled-in shell version is read synchronously.
    const shellNative = getShellNative();
    const shellVersion = getShellVersion();
    const [shellInfo, setShellInfo] = useState<ShellUpdateInfo | null>(null);
    const [shellApplying, setShellApplying] = useState(false);
    const [shellStatus, setShellStatus] = useState<string | null>(null);
    // Set when a shell apply couldn't run here (unsupported method / no pkexec): the
    // panel then shows a manual-download card with this url.
    const [shellManualUrl, setShellManualUrl] = useState<string | null>(null);

    // Read the on-disk stamp once (transient pre-render shows "—"). Also clear the
    // background-check highlight flag: opening this page means the user has seen it.
    useEffect(() => {
        clearUpdateFlag();
        if (!native || !targetDir) return;
        let live = true;
        native
            .readInstalledVersion(targetDir)
            .then(raw => { if (live) setInstalled(raw); })
            .catch(() => { if (live) setInstalled(null); });
        return () => { live = false; };
    }, []);

    // Read the shell install info once (how we're installed + can we auto-update).
    useEffect(() => {
        if (!shellNative) return;
        let live = true;
        shellNative
            .getInfo()
            .then(info => { if (live) setShellInfo(info); })
            .catch(() => { if (live) setShellInfo(null); });
        return () => { live = false; };
    }, []);

    const onCheck = useCallback(async () => {
        if (!native) return;
        setChecking(true);
        setStatus(null);
        setCheckFailed(false);
        try {
            const found = await native.discoverManifest(OWNER, REPO);
            if (!found.ok) {
                // Typed failure → precise per-code copy + a Retry affordance. Never "—".
                setLatest(null);
                setStatus(failCopy(found));
                setCheckFailed(true);
                return;
            }
            const pv = found.manifest?.pluginVersion;
            const version = typeof pv === "string" && pv ? pv : null;
            setLatest({ manifest: found.manifest, baseUrl: found.baseUrl, version });
        } catch (err) {
            // The IPC bridge itself threw (should be rare — native returns a typed result).
            setLatest(null);
            setStatus(U.error((err as Error)?.message ?? String(err)));
            setCheckFailed(true);
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

    // Apply the SHELL update: hand the manifest's shell block to the shell bridge,
    // which downloads + verifies + runs the installer for this platform (or reports
    // { manual, url } when it can't drive the method — we then show the download card).
    const onShellApply = useCallback(async () => {
        if (!shellNative || !latest?.manifest?.shell) return;
        setShellApplying(true);
        setShellStatus(null);
        setShellManualUrl(null);
        try {
            const res = await shellNative.apply(latest.manifest.shell, latest.baseUrl);
            if (res.ok) {
                setShellStatus(SH.launched);
            } else if (res.manual) {
                setShellManualUrl(res.url ?? null);
                setShellStatus(null);
            } else {
                setShellStatus(SH.error(res.error ?? "unknown error"));
            }
        } catch (err) {
            setShellStatus(SH.error((err as Error)?.message ?? String(err)));
        } finally {
            setShellApplying(false);
        }
    }, [shellNative, latest]);

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

    // The release's required shell version (manifest.shellVersion), and whether it is
    // newer than the shell running now → the app itself (not just the plugin) needs an
    // installer update. Only meaningful once a Check has fetched the manifest.
    const requiredShell: string | null =
        typeof latest?.manifest?.shellVersion === "string" ? latest.manifest.shellVersion : null;
    const shellUpdateNeeded = shellIsNewer(requiredShell, shellVersion);

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
            versionRow(U.latest, latestVer),
            // The app-shell version row only appears when the shell bridge is present
            // (an older shell without shellUpdate simply omits it).
            shellVersion ? versionRow(SH.shellVersion, shellVersion) : null
        ),
        // "Installed via: AppImage" — how the app is installed, shown once detected.
        shellInfo
            ? React.createElement(
                Text,
                { variant: "text-xs/normal", style: { display: "block", margin: "-2px 0 6px", color: "var(--text-muted)" } },
                SH.installedVia(shellInfo.methodLabel)
            )
            : null,
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
                // A failed check flips the button to "Try again" — the Retry affordance
                // the panel always offers instead of a dead end.
                checking ? U.checking : checkFailed ? STRINGS.actions.retry : U.check
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
        ),

        // --- app-shell update (only when a fetched release needs a newer shell) -----
        // Surfaced after a Check reveals the release requires a shell newer than the one
        // running. A driveable install method gets an "Update app" button; a method we
        // can't drive (or a shell apply that returned manual) gets a download card. The
        // shell status line (launched / error) shows under either.
        shellUpdateNeeded && shellNative
            ? React.createElement(
                "div",
                { style: { marginTop: "14px", paddingTop: "12px", borderTop: "1px solid var(--background-modifier-accent)" } },
                React.createElement(
                    Text,
                    { variant: "text-sm/normal", style: { display: "block", marginBottom: "8px" } },
                    SH.updateAvailable(requiredShell!)
                ),
                // Manual card: no driveable method, or a prior apply came back manual.
                shellManualUrl || (shellInfo && !shellInfo.canAutoUpdate)
                    ? React.createElement(
                        "div",
                        null,
                        React.createElement(
                            Text,
                            { variant: "text-sm/normal", style: { display: "block", marginBottom: "8px", color: "var(--text-muted)" } },
                            SH.manual
                        ),
                        React.createElement(
                            Button,
                            {
                                size: Button.Sizes.SMALL,
                                color: Button.Colors.PRIMARY,
                                disabled: !shellManualUrl,
                                onClick: () => shellManualUrl && downloadUrl(shellManualUrl)
                            },
                            SH.download
                        )
                    )
                    : React.createElement(
                        Button,
                        {
                            size: Button.Sizes.SMALL,
                            color: Button.Colors.BRAND,
                            disabled: shellApplying,
                            onClick: onShellApply
                        },
                        shellApplying ? SH.updating : SH.update
                    ),
                shellStatus
                    ? React.createElement(
                        Text,
                        { variant: "text-sm/normal", style: { display: "block", marginTop: "8px", color: "var(--text-muted)" } },
                        shellStatus
                    )
                    : null
            )
            : null,

        // --- automatic-check switch (opt out of the daily background check) -----
        React.createElement(Forms.FormDivider, { style: { margin: "16px 0" } }),
        React.createElement(
            Switch,
            {
                value: store.autoCheckUpdates !== false,
                note: U.autoCheckNote,
                hideBorder: true,
                onChange: (v: boolean) => { store.autoCheckUpdates = v; }
            },
            U.autoCheckTitle
        )
    );
}
