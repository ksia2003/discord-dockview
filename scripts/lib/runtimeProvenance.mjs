/* Provenance for the disjoint official Vencord and DockView output trees. */

import { createHash } from "crypto";
import { lstatSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

import { VENCORD_BUILD_IDENTITY } from "./vencordBuildIdentity.mjs";
import { DOCKVIEW_OUTPUT_FILES, VENCORD_OUTPUT_FILES } from "./vencordOutputs.mjs";

export const RUNTIME_PROVENANCE_RECORD = "static/runtimeDist.provenance.json";
export const RUNTIME_OUTPUT_PATHS = Object.freeze([
    ...VENCORD_OUTPUT_FILES.map(file => `vencordDist/${file}`),
    ...DOCKVIEW_OUTPUT_FILES.map(file => `dockviewDist/${file}`)
]);
export const TRACKED_RUNTIME_OUTPUT_PATHS = Object.freeze(
    RUNTIME_OUTPUT_PATHS.filter(path => !path.includes("/chunk-"))
);
export const CHUNK_RUNTIME_OUTPUT_PATHS = Object.freeze(
    RUNTIME_OUTPUT_PATHS.filter(path => path.includes("/chunk-"))
);

const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const STABLE_REF = /^v\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const MANIFEST_KEYS = ["buildIdentity", "files", "schemaVersion", "sourceCommit", "vencordCommit", "vencordRef"];
export const VERSION_STAMP = /^dockview:(\S+)\s+(v\d+\.\d+\.\d+)\s+([0-9a-f]{40}-[0-9a-f]{64})$/i;

const exactKeys = (actual, expected) =>
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());

export function sha256File(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateRuntimeManifest(manifest) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error("Runtime provenance is not a JSON object");
    }
    if (!exactKeys(Object.keys(manifest), MANIFEST_KEYS)) {
        throw new Error("Runtime provenance has unexpected or missing top-level keys");
    }
    if (manifest.schemaVersion !== 1) throw new Error("Unsupported runtime provenance schema");
    if (!FULL_COMMIT.test(manifest.sourceCommit)) throw new Error("Runtime provenance source commit is not a full SHA");
    if (!STABLE_REF.test(manifest.vencordRef)) throw new Error("Runtime provenance ref is not a stable numeric tag");
    if (!FULL_COMMIT.test(manifest.vencordCommit)) throw new Error("Runtime provenance commit is not a full SHA");
    if (!VENCORD_BUILD_IDENTITY.test(manifest.buildIdentity)) throw new Error("Runtime provenance build identity is malformed");
    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
        throw new Error("Runtime provenance files is not an object");
    }
    if (!exactKeys(Object.keys(manifest.files), RUNTIME_OUTPUT_PATHS)) {
        throw new Error("Runtime provenance does not contain the exact output path set");
    }
    for (const path of RUNTIME_OUTPUT_PATHS) {
        if (!SHA256.test(manifest.files[path])) throw new Error(`Runtime provenance digest is malformed: ${path}`);
    }
    return manifest;
}

export function readRuntimeManifest(path) {
    try {
        return validateRuntimeManifest(JSON.parse(readFileSync(path, "utf-8")));
    } catch (error) {
        throw new Error(`Could not read runtime provenance ${path}: ${error.message}`);
    }
}

export function verifyRuntimeManifestMetadata(manifest, { vencordRef, vencordCommit, buildIdentity } = {}) {
    validateRuntimeManifest(manifest);
    if (vencordRef !== undefined && manifest.vencordRef !== vencordRef) throw new Error("Runtime provenance ref mismatch");
    if (vencordCommit !== undefined && manifest.vencordCommit !== vencordCommit.toLowerCase()) {
        throw new Error("Runtime provenance commit mismatch");
    }
    if (buildIdentity !== undefined && manifest.buildIdentity !== buildIdentity.toLowerCase()) {
        throw new Error("Runtime provenance build identity mismatch");
    }
    return manifest;
}

export function verifyRuntimeManifestFiles(staticDirectory, manifest, { allowMissingChunks = false } = {}) {
    validateRuntimeManifest(manifest);
    for (const path of RUNTIME_OUTPUT_PATHS) {
        let stat;
        try {
            stat = lstatSync(join(staticDirectory, path));
        } catch (error) {
            if (allowMissingChunks && CHUNK_RUNTIME_OUTPUT_PATHS.includes(path) && error.code === "ENOENT") continue;
            throw new Error(`Missing required runtime output: ${path}`);
        }
        if (!stat.isFile()) throw new Error(`Runtime output is not a regular file: ${path}`);
        if (sha256File(join(staticDirectory, path)) !== manifest.files[path].toLowerCase()) {
            throw new Error(`Runtime output digest mismatch: ${path}`);
        }
    }
    return manifest;
}

function inspectOwnedDirectory(staticDirectory, name, expected, result) {
    const directory = join(staticDirectory, name);
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        result.reasons.push(`could not read ${name}: ${error.message}`);
        return;
    }
    const allowed = new Set(expected);
    const extra = entries.filter(entry => !allowed.has(entry.name)).map(entry => `${name}/${entry.name}`);
    if (extra.length) result.reasons.push(`unexpected runtime output: ${extra.sort().join(", ")}`);
}

export function inspectRuntimeCheckout(
    staticDirectory,
    recordPath,
    { pluginVersion, vencordRef, vencordCommit, buildIdentity } = {}
) {
    const result = { current: false, staticDirectory, recordPath, presentChunks: [], reasons: [], manifest: null };
    try {
        result.manifest = readRuntimeManifest(recordPath);
        verifyRuntimeManifestMetadata(result.manifest, { vencordRef, vencordCommit, buildIdentity });
    } catch (error) {
        result.reasons.push(error.message);
        return result;
    }

    inspectOwnedDirectory(staticDirectory, "vencordDist", VENCORD_OUTPUT_FILES, result);
    inspectOwnedDirectory(staticDirectory, "dockviewDist", DOCKVIEW_OUTPUT_FILES, result);

    for (const path of TRACKED_RUNTIME_OUTPUT_PATHS) {
        try {
            const full = join(staticDirectory, path);
            if (!lstatSync(full).isFile()) result.reasons.push(`tracked output is not a regular file: ${path}`);
            else if (sha256File(full) !== result.manifest.files[path].toLowerCase()) {
                result.reasons.push(`tracked output digest mismatch: ${path}`);
            }
        } catch {
            result.reasons.push(`missing tracked output: ${path}`);
        }
    }
    for (const path of CHUNK_RUNTIME_OUTPUT_PATHS) {
        try {
            if (!lstatSync(join(staticDirectory, path)).isFile()) result.reasons.push(`chunk is not a regular file: ${path}`);
            else {
                result.presentChunks.push(path);
                if (sha256File(join(staticDirectory, path)) !== result.manifest.files[path].toLowerCase()) {
                    result.reasons.push(`present chunk digest mismatch: ${path}`);
                }
            }
        } catch {
            // Generated chunks are intentionally absent from a clean checkout.
        }
    }

    try {
        const match = readFileSync(join(staticDirectory, "dockviewDist", "version.txt"), "utf-8").trim().match(VERSION_STAMP);
        if (!match) result.reasons.push("DockView version.txt is not a canonical provenance stamp");
        else {
            if (match[1] !== pluginVersion) result.reasons.push(`DockView version is ${match[1]}, expected ${pluginVersion}`);
            if (match[2] !== vencordRef) result.reasons.push(`DockView Vencord ref is ${match[2]}, expected ${vencordRef}`);
            if (match[3].toLowerCase() !== buildIdentity?.toLowerCase()) result.reasons.push("DockView build identity mismatch");
        }
    } catch (error) {
        result.reasons.push(`could not read DockView version.txt: ${error.message}`);
    }

    result.current = result.reasons.length === 0;
    return result;
}
