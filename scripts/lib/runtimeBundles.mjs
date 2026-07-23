/* Validate the two disjoint runtime output trees. */

import { lstatSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

import { VENCORD_BUILD_IDENTITY } from "./vencordBuildIdentity.mjs";
import { DOCKVIEW_OUTPUT_FILES, VENCORD_OUTPUT_FILES } from "./vencordOutputs.mjs";

const VERSION = /^dockview:(\S+)\s+(v\d+\.\d+\.\d+)\s+([0-9a-f]{40}-[0-9a-f]{64})$/i;

function inspectFiles(directory, expected) {
    const result = { missing: [], extra: [], nonFiles: [] };
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        return { ...result, error: `could not read ${directory}: ${error.message}` };
    }
    const actual = entries.map(entry => entry.name);
    result.missing = expected.filter(name => !actual.includes(name));
    result.extra = actual.filter(name => !expected.includes(name));
    result.nonFiles = entries.filter(entry => expected.includes(entry.name) && !entry.isFile()).map(entry => entry.name);
    return result;
}

export function inspectRuntimeBundles(
    root,
    { pluginVersion, vencordRef, buildIdentity, requireExactFileSet = true } = {}
) {
    const vencordDirectory = join(root, "static", "vencordDist");
    const dockviewDirectory = join(root, "static", "dockviewDist");
    const result = { current: false, vencordDirectory, dockviewDirectory, reasons: [] };

    for (const [label, directory, expected] of [
        ["Vencord", vencordDirectory, VENCORD_OUTPUT_FILES],
        ["DockView", dockviewDirectory, DOCKVIEW_OUTPUT_FILES]
    ]) {
        const files = inspectFiles(directory, expected);
        if (files.error) result.reasons.push(files.error);
        if (files.missing.length) result.reasons.push(`${label} missing output: ${files.missing.join(", ")}`);
        if (files.nonFiles.length) result.reasons.push(`${label} output is not a regular file: ${files.nonFiles.join(", ")}`);
        if (requireExactFileSet && files.extra.length) result.reasons.push(`${label} unexpected output: ${files.extra.join(", ")}`);
    }
    if (result.reasons.length) return result;

    for (const file of VENCORD_OUTPUT_FILES) {
        if (DOCKVIEW_OUTPUT_FILES.includes(file)) result.reasons.push(`runtime file ownership overlaps: ${file}`);
        if (!lstatSync(join(vencordDirectory, file)).isFile()) result.reasons.push(`Vencord output is not a file: ${file}`);
    }
    const vencordMain = readFileSync(join(vencordDirectory, "vencordDesktopMain.js"), "utf-8");
    if (!/^\/\/ Standalone: true$/im.test(vencordMain.slice(0, 512))) {
        result.reasons.push("official Vencord runtime is not a standalone build");
    }
    if (!/^\/\/ Updater Disabled: false$/im.test(vencordMain.slice(0, 512))) {
        result.reasons.push("official Vencord standalone updater is disabled");
    }

    const vencordRenderer = readFileSync(join(vencordDirectory, "vencordDesktopRenderer.js"), "utf-8");
    if (/DockView/.test(vencordRenderer)) result.reasons.push("official Vencord renderer contains DockView code");

    const dockviewRenderer = readFileSync(join(dockviewDirectory, "dockviewRenderer.js"), "utf-8");
    if (!/DockView/.test(dockviewRenderer)) result.reasons.push("DockView renderer has no DockView marker");
    if (/vencordDesktop(?:Main|Preload|Renderer)/.test(dockviewRenderer)) {
        result.reasons.push("DockView renderer contains a Vencord desktop bundle marker");
    }
    const dockviewMain = readFileSync(join(dockviewDirectory, "dockviewMain.js"), "utf-8");
    if (!/^\/\/ DockView Runtime ABI: 1$/m.test(dockviewMain.slice(0, 512))) {
        result.reasons.push("DockView main bundle has no supported Runtime ABI banner");
    }

    const versionText = readFileSync(join(dockviewDirectory, "version.txt"), "utf-8").trim();
    const version = versionText.match(VERSION);
    if (!version) {
        result.reasons.push("DockView version.txt is not a canonical provenance stamp");
    } else {
        if (pluginVersion !== undefined && version[1] !== pluginVersion) {
            result.reasons.push(`DockView version is ${version[1]}, expected ${pluginVersion}`);
        }
        if (vencordRef !== undefined && version[2] !== vencordRef) {
            result.reasons.push(`DockView Vencord ref is ${version[2]}, expected ${vencordRef}`);
        }
        if (buildIdentity !== undefined) {
            if (!VENCORD_BUILD_IDENTITY.test(buildIdentity)) result.reasons.push("expected build identity is malformed");
            else if (version[3].toLowerCase() !== buildIdentity.toLowerCase()) {
                result.reasons.push("DockView build identity mismatch");
            }
        }
    }

    result.current = result.reasons.length === 0;
    return result;
}

export function assertRuntimeBundles(root, options) {
    const result = inspectRuntimeBundles(root, options);
    if (!result.current) throw new Error(`Runtime bundle verification failed: ${result.reasons.join("; ")}`);
    return result;
}
