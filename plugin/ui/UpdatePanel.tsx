/*
 * DockView — self-update settings panel (renderer).
 * ---------------------------------------------------------------------------
 * DockView's independent runtime can update separately from Vencord and the
 * Vesktop application. Vesktop itself deliberately keeps upstream's
 * electron-updater; this panel does not duplicate app-installer behavior.
 */

import { Button, Forms, React, Switch, Text } from "@vencord/types/webpack/common";

import { downloadUrl } from "../external/openExternal";
import { settings } from "../settings";
import { STRINGS } from "../strings";
import { compareDockviewVersions, DOCKVIEW_PLUGIN_VERSION } from "../version";
import { clearUpdateFlag } from "./autoCheck";
import {
    DiscoverResult, getNative, getShellNative, getShellVersion, OWNER, pluginStamp, REPO,
    shellIsNewer, ShellUpdateInfo
} from "./updateShared";

const U = STRINGS.update;
const SH = U.shell;

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

function relaunchApp(): void {
    try {
        (window as any).VesktopNative?.app?.relaunch?.();
    } catch {
        /* fall back to a renderer reload at the call site */
    }
}

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

function versionFromStamp(value: string | null): string | null {
    return value?.match(/^dockview:(\S+)/)?.[1] ?? value;
}

export function UpdatePanel() {
    const { useState, useCallback, useEffect } = React;
    const native = getNative();
    const store = settings.use(["autoCheckUpdates", "devChannel"]);

    const [installed, setInstalled] = useState<string | null>(null);
    const [latest, setLatest] = useState<{ manifest: any; baseUrl: string; version: string | null } | null>(null);
    const [checking, setChecking] = useState(false);
    const [applying, setApplying] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [checkFailed, setCheckFailed] = useState(false);
    const [applied, setApplied] = useState(false);
    const [rollbackVersion, setRollbackVersion] = useState<string | null>(null);
    const [rollingBack, setRollingBack] = useState(false);
    const shellNative = getShellNative();
    const shellVersion = getShellVersion();
    const [shellInfo, setShellInfo] = useState<ShellUpdateInfo | null>(null);
    const [shellApplying, setShellApplying] = useState(false);
    const [shellStatus, setShellStatus] = useState<string | null>(null);
    const [shellManualUrl, setShellManualUrl] = useState<string | null>(null);

    useEffect(() => {
        clearUpdateFlag();
        if (!native) return;
        let live = true;
        native
            .readInstalledVersion()
            .then(raw => { if (live) setInstalled(raw); })
            .catch(() => { if (live) setInstalled(null); });
        native
            .readRollbackVersion?.()
            .then(raw => { if (live) setRollbackVersion(raw); })
            .catch(() => { if (live) setRollbackVersion(null); });
        return () => { live = false; };
    }, []);

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
            const found = await native.discoverManifest(OWNER, REPO, settings.store.devChannel);
            if (!found.ok) {
                setLatest(null);
                setStatus(failCopy(found));
                setCheckFailed(true);
                return;
            }
            const pv = found.manifest?.pluginVersion;
            const version = typeof pv === "string" && pv ? pv : null;
            setLatest({ manifest: found.manifest, baseUrl: found.baseUrl, version });
        } catch (err) {
            setLatest(null);
            setStatus(U.error((err as Error)?.message ?? String(err)));
            setCheckFailed(true);
        } finally {
            setChecking(false);
        }
    }, [native]);

    const onApply = useCallback(async () => {
        if (!native || !latest) return;
        setApplying(true);
        setStatus(null);
        try {
            const res = await native.applyUpdate(latest.manifest, latest.baseUrl);
            if (!res.ok) {
                setStatus(U.error(res.error ?? "unknown error"));
                return;
            }

            setApplied(true);
            setRollbackVersion(installed);
            if (res.needsRelaunch) {
                setStatus(U.needsRelaunch);
                relaunchApp();
            } else {
                setStatus(U.appliedNeedsReload);
                location.reload();
            }
        } catch (err) {
            setStatus(U.error((err as Error)?.message ?? String(err)));
        } finally {
            setApplying(false);
        }
    }, [native, latest, installed]);

    const onRollback = useCallback(async () => {
        if (!native?.rollbackUpdate) return;
        setRollingBack(true);
        setStatus(null);
        try {
            const res = await native.rollbackUpdate();
            if (!res.ok) {
                setStatus(U.error(res.error ?? "unknown error"));
                return;
            }
            setStatus(U.rollbackApplied);
            relaunchApp();
        } catch (err) {
            setStatus(U.error((err as Error)?.message ?? String(err)));
        } finally {
            setRollingBack(false);
        }
    }, [native]);

    const onShellApply = useCallback(async () => {
        if (!shellNative || !latest?.manifest?.shell) return;
        setShellApplying(true);
        setShellStatus(null);
        setShellManualUrl(null);
        try {
            const res = await shellNative.apply(latest.manifest.shell, latest.baseUrl);
            if (res.ok) setShellStatus(SH.launched);
            else if (res.manual) setShellManualUrl(res.url ?? null);
            else setShellStatus(SH.error(res.error ?? "unknown error"));
        } catch (err) {
            setShellStatus(SH.error((err as Error)?.message ?? String(err)));
        } finally {
            setShellApplying(false);
        }
    }, [shellNative, latest]);

    if (!native) {
        return React.createElement(
            "div",
            null,
            React.createElement(Forms.FormTitle, { tag: "h3" }, U.sectionTitle),
            React.createElement(Forms.FormText, { style: { color: "var(--text-muted)" } }, U.unavailable)
        );
    }

    const current = DOCKVIEW_PLUGIN_VERSION;
    const latestVer = latest?.version ?? null;
    const updateAvailable =
        !!latestVer && compareDockviewVersions(pluginStamp(latestVer), installed ?? "") === 1;
    const patchPending =
        !!installed && compareDockviewVersions(installed, pluginStamp(current)) === 1;
    const requiredShell =
        typeof latest?.manifest?.shellVersion === "string" ? latest.manifest.shellVersion : null;
    const shellUpdateNeeded = shellIsNewer(requiredShell, shellVersion);
    const shellManualOnly = shellUpdateNeeded && !!shellManualUrl;
    const anyUpdateAvailable = updateAvailable || shellUpdateNeeded;
    const busyApplying = applying || shellApplying || rollingBack;

    let verdict: string;
    if (applied) verdict = status ?? U.appliedNeedsReload;
    else if (shellStatus) verdict = shellStatus;
    else if (status) verdict = status;
    else if (latest === null) verdict = patchPending ? U.appliedNeedsReload : U.notChecked;
    else if (shellUpdateNeeded && requiredShell) verdict = U.appUpdateAvailable(requiredShell);
    else if (updateAvailable && latestVer) verdict = U.updateAvailable(latestVer);
    else if (patchPending) verdict = U.appliedNeedsReload;
    else verdict = U.upToDate;

    const onApplyUnified = () => {
        if (!shellUpdateNeeded) {
            void onApply();
        } else if (shellManualUrl) {
            downloadUrl(shellManualUrl);
        } else {
            void onShellApply();
        }
    };

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
            versionRow(U.latest, latestVer),
            rollbackVersion ? versionRow(U.previous, versionFromStamp(rollbackVersion)) : null
        ),
        shellInfo
            ? React.createElement(
                Text,
                {
                    variant: "text-xs/normal",
                    style: { display: "block", margin: "-2px 0 6px", color: "var(--text-muted)" }
                },
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
                    disabled: checking || busyApplying,
                    onClick: onCheck
                },
                checking ? U.checking : checkFailed ? STRINGS.actions.retry : U.check
            ),
            React.createElement(
                Button,
                {
                    size: Button.Sizes.SMALL,
                    color: Button.Colors.BRAND,
                    disabled: busyApplying || checking || !anyUpdateAvailable || (shellUpdateNeeded && !shellNative),
                    onClick: onApplyUnified
                },
                busyApplying ? (shellApplying ? SH.updating : U.applying) : shellManualOnly ? SH.download : U.apply
            ),
            rollbackVersion && native.rollbackUpdate
                ? React.createElement(
                    Button,
                    {
                        size: Button.Sizes.SMALL,
                        color: Button.Colors.PRIMARY,
                        disabled: busyApplying || checking,
                        onClick: onRollback
                    },
                    rollingBack ? U.rollingBack : U.rollback
                )
                : null
        ),
        shellManualOnly
            ? React.createElement(
                Text,
                { variant: "text-sm/normal", style: { display: "block", marginTop: "8px", color: "var(--text-muted)" } },
                SH.manual
            )
            : null,
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
        ),
        React.createElement(
            Switch,
            {
                value: store.devChannel === true,
                note: U.devChannelNote,
                hideBorder: true,
                onChange: (v: boolean) => { store.devChannel = v; }
            },
            U.devChannelTitle
        )
    );
}
