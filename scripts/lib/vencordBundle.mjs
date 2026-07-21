/*
 * Validate the bundled Vencord tree that is actually present in the checkout.
 * Upstream pin metadata alone is not sufficient: a missing, stale, or
 * incomplete static/vencordDist must keep maintenance active.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

import { VENCORD_BUILD_IDENTITY } from "./vencordBuildIdentity.mjs";
import { VENCORD_OUTPUT_FILES } from "./vencordOutputs.mjs";

const VERSION = /^dockview:(\S+)\s+(v\d+\.\d+\.\d+)\s+([0-9a-f]{40}-[0-9a-f]{64})$/;

function fileSet(directory) {
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        return { actual: [], error: `could not read bundle directory: ${error.message}` };
    }

    const actual = entries.map(entry => entry.name).sort();
    const expected = [...VENCORD_OUTPUT_FILES].sort();
    const extra = actual.filter(name => !expected.includes(name));
    const missing = expected.filter(name => !actual.includes(name));
    const nonFiles = entries.filter(entry => expected.includes(entry.name) && !entry.isFile()).map(entry => entry.name);
    return { actual, expected, extra, missing, nonFiles, error: null };
}

/**
 * Check the fixed runtime output set, version.txt's exact stable build
 * provenance, and a content marker from the renderer. The returned object is
 * deliberately data-only so the detector can include the reason in its durable report.
 */
export function inspectVencordBundle(
    directory,
    { pluginVersion, vencordRef, buildIdentity, requireExactFileSet = true } = {}
) {
    const result = {
        current: false,
        directory,
        expectedFiles: [...VENCORD_OUTPUT_FILES],
        missingFiles: [],
        extraFiles: [],
        nonFileEntries: [],
        version: null,
        reasons: []
    };
    if (!VENCORD_BUILD_IDENTITY.test(buildIdentity ?? "")) {
        result.reasons.push("expected build identity is not a full plugin-tree/content digest");
        return result;
    }

    const set = fileSet(directory);
    if (set.error) {
        result.reasons.push(set.error);
        return result;
    }
    result.missingFiles = set.missing;
    result.extraFiles = set.extra;
    result.nonFileEntries = set.nonFiles;
    if (set.missing.length) result.reasons.push(`missing required output: ${set.missing.join(", ")}`);
    if (set.nonFiles.length) result.reasons.push(`required output is not a regular file: ${set.nonFiles.join(", ")}`);
    if (requireExactFileSet && set.extra.length) result.reasons.push(`unexpected bundle output: ${set.extra.join(", ")}`);
    if (result.reasons.length) return result;

    const versionPath = join(directory, "version.txt");
    const versionText = readFileSync(versionPath, "utf-8").trim();
    const match = versionText.match(VERSION);
    result.version = match
        ? { plugin: match[1], vencordRef: match[2], buildIdentity: match[3].toLowerCase() }
        : null;
    if (!match) {
        result.reasons.push("version.txt is not a canonical full-provenance stamp");
    } else {
        if (match[1] !== pluginVersion) result.reasons.push(`version.txt plugin is ${match[1]}, expected ${pluginVersion}`);
        if (match[2] !== vencordRef) result.reasons.push(`version.txt Vencord ref is ${match[2]}, expected ${vencordRef}`);
        if (match[3].toLowerCase() !== buildIdentity.toLowerCase()) {
            result.reasons.push("version.txt build provenance does not match the stable DockView input identity");
        }
    }

    const renderer = readFileSync(join(directory, "vencordDesktopRenderer.js"), "utf-8");
    if (!/DockView/.test(renderer)) result.reasons.push("renderer does not contain the DockView plugin marker");
    result.current = result.reasons.length === 0;
    return result;
}

export function assertVencordBundle(directory, options) {
    const result = inspectVencordBundle(directory, options);
    if (!result.current) throw new Error(`Vencord bundle is not current: ${result.reasons.join("; ")}`);
    return result;
}
