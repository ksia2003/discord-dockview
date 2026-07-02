/*
 * DockView — once-a-day background update check (renderer).
 * ---------------------------------------------------------------------------
 * A quiet, opt-out-able check on plugin start: at most ONCE per 24h, off the boot
 * critical path (requestIdleCallback), DockView asks GitHub whether a newer build
 * is out. If one is, it raises a SINGLE Vencord notice (the same snackbar Vencord's
 * own updater uses) with a button that opens the Updates page, and flips an in-memory
 * flag the Updates row reads to show a highlight. It NEVER auto-applies — the user
 * still clicks Apply on the Updates page.
 *
 * Persistence: the last-check timestamp lives in the settings store (survives
 * restarts) so the 24h throttle is real, not per-session. The "check automatically"
 * switch (settings.autoCheckUpdates) gates the whole thing.
 *
 * NO import cycle + NO module-top webpack: Notices/SettingsRouter are read at call
 * time (guarded), version helpers come from the pure ../version via updateShared,
 * and settings is store-only.
 */

import { settings } from "../settings";
import { STRINGS } from "../strings";
import { DOCKVIEW_PLUGIN_VERSION } from "../version";
import { getNative, getTargetDir, isNewer, OWNER, REPO } from "./updateShared";

const U = STRINGS.update;

/** 24 hours in ms — the minimum gap between two automatic checks. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Set true by a background check that found a newer build, so the Updates sidebar row
 * can show a highlight/badge without re-checking. In-memory only (a fresh boot re-checks
 * and re-derives it); the Updates page also clears it once the user has seen the page.
 */
let updateFlagged = false;
export function isUpdateFlagged(): boolean { return updateFlagged; }
export function clearUpdateFlag(): void { updateFlagged = false; }

/** Read the persisted last-check timestamp (ms). Tolerates a missing/garbage value. */
function readLastCheck(): number {
    const raw = settings.store.lastAutoCheck;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Persist the last-check timestamp (ms). Stored as a decimal string. */
function writeLastCheck(ms: number): void {
    try { settings.store.lastAutoCheck = String(ms); } catch { /* store not ready */ }
}

/** Raise the one-time "update available" notice. The button opens the Updates page
 *  (best-effort — SettingsRouter is a webpack export, read at call time). */
function showUpdateNotice(version: string): void {
    // Read the Vencord Notices API + the settings router lazily off the renderer global,
    // never at module top (webpack proxies aren't safe to touch before Vencord is ready).
    const openUpdatesPage = () => {
        try {
            const { SettingsRouter } = (window as any).Vencord?.Webpack?.Common ?? {};
            // Our DockView pages register as sidebar items with these keys (settingsSection.ts).
            SettingsRouter?.open?.("dockview_updates");
        } catch { /* the notice still informed the user; the page is one click away */ }
    };
    try {
        const Notices = (window as any).Vencord?.Api?.Notices;
        if (Notices?.showNotice) {
            Notices.showNotice(U.noticeUpdate(version), U.noticeButton, () => {
                try { Notices.popNotice?.(); } catch { /* ignore */ }
                openUpdatesPage();
            });
        }
    } catch { /* no notice surface — the row highlight still flags it */ }
}

/** Run one background check now, honouring the switch + the 24h throttle. Any failure
 *  is swallowed (a background check must never surface an error to the user — the
 *  on-demand Updates page is where errors get precise copy). */
async function runCheck(): Promise<void> {
    try {
        if (settings.store.autoCheckUpdates === false) return;

        const now = Date.now();
        const last = readLastCheck();
        // Guard against a clock that jumped backwards (last in the future) too.
        if (last && now - last < CHECK_INTERVAL_MS && now >= last) return;

        const native = getNative();
        const targetDir = getTargetDir();
        if (!native || !targetDir) return;

        // Stamp the attempt BEFORE the network call so a run that then fails still
        // counts against the 24h window (we don't hammer GitHub on every boot when
        // offline). A found update re-checks on demand anyway.
        writeLastCheck(now);

        const found = await native.discoverManifest(OWNER, REPO);
        if (!found.ok) return; // background: stay silent on any check failure

        const latestVer =
            typeof found.manifest?.pluginVersion === "string" ? found.manifest.pluginVersion : null;
        if (!latestVer) return;

        const installed = await native.readInstalledVersion(targetDir).catch(() => null);
        // Newer than BOTH what's on disk and what's running (a patch already applied on
        // disk but pending a reload shouldn't re-notify as if it were new).
        const newerThanDisk = isNewer(latestVer, installed);
        const newerThanRunning = isNewer(latestVer, `dockview:${DOCKVIEW_PLUGIN_VERSION} x x`);
        if (!newerThanDisk || !newerThanRunning) return;

        updateFlagged = true;
        showUpdateNotice(latestVer);
    } catch {
        /* never let a background check throw into the caller */
    }
}

/** Kick off the once-a-day check from plugin start, OFF the boot critical path. Uses
 *  requestIdleCallback when available (a short timeout otherwise). Idempotent-safe:
 *  runCheck's own throttle makes a double-call harmless. */
export function scheduleAutoCheck(): void {
    const ric = (window as any).requestIdleCallback;
    if (typeof ric === "function") ric(() => { void runCheck(); }, { timeout: 8000 });
    else setTimeout(() => { void runCheck(); }, 5000);
}
