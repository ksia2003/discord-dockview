/*
 * DockView — plugin version + version.txt parsing/comparison.
 * ---------------------------------------------------------------------------
 * This is the CANONICAL HOME of the running plugin version. DOCKVIEW_PLUGIN_VERSION
 * is the compiled/running patch version, bumped per patch release. The build
 * (scripts/prepare-vencord.mjs) reads this literal at build time and is the SOLE
 * writer of static/vencordDist/version.txt.
 *
 * version.txt has three tolerated shapes (see parseVersionTxt):
 *   (a) new     "dockview:0.1.1 v1.14.13 abc1234"
 *   (b) legacy  "v1.14.13+dockview-abc1234"   (old prepare-vencord writer)
 *   (c) bare    "1.14.13"                     (oldest legacy)
 *
 * compareDockviewVersions semver-compares the `plugin` field; any legacy/null
 * plugin sorts as the OLDEST (any dockview:* beats any legacy). This lets the
 * always-copy guard treat a freshly built bundle as newer than any legacy disk
 * copy, and an on-disk OTA patch as newer than a stale bundled one.
 *
 * Pure module: no side effects, no heavy/webpack imports. It is imported by the
 * renderer plugin AND (later) by plugin/native.ts in the main process, so it
 * must stay dependency-free TypeScript.
 */

/** The compiled/running plugin patch version. Bump this per patch release. */
export const DOCKVIEW_PLUGIN_VERSION = "0.1.40";

/**
 * Intentional mirror of the app-domain release repository. The plugin compiles
 * in Vencord's separate source domain, so it cannot import src/shared here.
 */
export const DOCKVIEW_RELEASE_REPOSITORY = "ksia2003/discord-dockview";

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
