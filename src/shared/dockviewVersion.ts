/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * DockView — app/build-domain copy of version.txt parsing/comparison.
 * ---------------------------------------------------------------------------
 * This is an INTENTIONAL second copy of the parse/compare/format logic that
 * lives in plugin/version.ts. The plugin/ tree is compiled inside the Vencord
 * clone (a separate compilation domain) and CANNOT import from src/shared, so
 * the app domain (main process, build scripts via TS) gets its own copy here.
 * Keep the two comparator copies byte-identical in BEHAVIOUR.
 *
 * DOCKVIEW_PLUGIN_VERSION is intentionally NOT redeclared here: plugin/version.ts
 * is its single home (the build reads that literal). This file only carries the
 * parse/compare/format helpers — plus DOCKVIEW_SHELL_VERSION below.
 *
 * DOCKVIEW_SHELL_VERSION, by contrast, DOES live here. It stamps the app SHELL
 * (the Vesktop main/preload/renderer that ships inside app.asar) — the layer the
 * in-app DockView updater CAN'T touch, since a runtime patch only rewrites files
 * under dockviewFiles, never app.asar. Bump it by hand whenever a shell
 * change ships (a new src/main IPC, a tray item, an account-switch fix, …), the
 * same way plugin/version.ts is bumped per plugin change. The release manifest
 * records the shell version a release REQUIRES; the shell-update flow compares this
 * compiled-in value against it to decide whether the installer needs to run.
 */

/** The compiled-in app-shell build. Bump per shell (Vesktop main/preload) change
 *  that ships in a release; only an installer can update the running value. */
export const DOCKVIEW_SHELL_VERSION = "0.2.0";

export interface ParsedVersionTxt {
    plugin: string | null;
    vencordRef: string | null;
    gitHash: string | null;
}

/**
 * Tolerantly parse the contents of version.txt. Returns all-null for empty or
 * unrecognised input so callers can fail safe (treat as oldest / unreadable).
 */
export function parseVersionTxt(raw: string): ParsedVersionTxt {
    const empty: ParsedVersionTxt = { plugin: null, vencordRef: null, gitHash: null };
    if (typeof raw !== "string") return empty;
    const text = raw.trim();
    if (!text) return empty;

    // (a) new: "dockview:<plugin> <vencordRef> <gitHash>"
    const newMatch = text.match(/^dockview:(\S+)\s+(\S+)\s+(\S+)$/);
    if (newMatch) {
        return { plugin: newMatch[1], vencordRef: newMatch[2], gitHash: newMatch[3] };
    }

    // (b) legacy script: "<vencordRef>+dockview-<gitHash>"
    const legacyMatch = text.match(/^(\S+)\+dockview-(\S+)$/);
    if (legacyMatch) {
        return { plugin: null, vencordRef: legacyMatch[1], gitHash: legacyMatch[2] };
    }

    // (c) bare legacy: "<vencordRef>" (a single token, no spaces)
    if (!/\s/.test(text)) {
        return { plugin: null, vencordRef: text, gitHash: null };
    }

    return empty;
}

/**
 * Compare two numeric-dotted version strings (e.g. "0.1.10" vs "0.2.0").
 * Splits on ".", compares each segment numerically; missing segments = 0.
 * Non-numeric segments degrade to 0.
 */
function compareSemver(a: string, b: string): -1 | 0 | 1 {
    const as = a.split(".");
    const bs = b.split(".");
    const len = Math.max(as.length, bs.length);
    for (let i = 0; i < len; i++) {
        const an = parseInt(as[i] ?? "0", 10) || 0;
        const bn = parseInt(bs[i] ?? "0", 10) || 0;
        if (an < bn) return -1;
        if (an > bn) return 1;
    }
    return 0;
}

/**
 * Compare two version.txt strings by their `plugin` field. A null plugin (any
 * legacy/bare format) sorts as the OLDEST: any dockview:* is newer than any
 * legacy. Both null → 0.
 */
export function compareDockviewVersions(a: string, b: string): -1 | 0 | 1 {
    const pa = parseVersionTxt(a).plugin;
    const pb = parseVersionTxt(b).plugin;
    if (pa === null && pb === null) return 0;
    if (pa === null) return -1; // a is legacy → older
    if (pb === null) return 1; // b is legacy → older
    return compareSemver(pa, pb);
}

/** Canonical writer for version.txt (the build is the sole user of this shape). */
export function formatVersionTxt(v: { plugin: string; vencordRef: string; gitHash: string }): string {
    return `dockview:${v.plugin} ${v.vencordRef} ${v.gitHash}\n`;
}

/**
 * Compare two bare shell versions ("0.1.25" vs "0.1.26") numerically. Unlike the
 * version.txt comparators above, a shell version is a plain dotted string (no
 * "dockview:" wrapper), so this is the plain numeric compare the shell-update flow
 * uses to decide "is the release's required shell newer than the one running?".
 * A missing/unparseable side sorts as the OLDEST (returns as if it were "0").
 */
export function compareShellVersions(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 {
    return compareSemver(typeof a === "string" ? a : "", typeof b === "string" ? b : "");
}
