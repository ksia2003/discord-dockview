/*
 * Shared Vencord manifest/provenance validation.
 *
 * A generated candidate or release tree must contain every runtime output and
 * match every recorded digest. A normal Git checkout intentionally omits the
 * ignored chunks, so its small tracked provenance record validates all chunk
 * keys/digests while requiring bytes only for tracked core outputs.
 */

import { createHash } from "crypto";
import { lstatSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

import { VENCORD_BUILD_IDENTITY } from "./vencordBuildIdentity.mjs";
import { VENCORD_OUTPUT_FILES } from "./vencordOutputs.mjs";

export const VENCORD_PROVENANCE_RECORD = "static/vencordDist.provenance.json";
export const VENCORD_CORE_OUTPUT_FILES = Object.freeze(
    VENCORD_OUTPUT_FILES.filter(file => !file.startsWith("chunk-"))
);
export const VENCORD_CHUNK_OUTPUT_FILES = Object.freeze(
    VENCORD_OUTPUT_FILES.filter(file => file.startsWith("chunk-"))
);

const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const STABLE_REF = /^v\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const MANIFEST_KEYS = ["buildIdentity", "files", "schemaVersion", "sourceCommit", "vencordCommit", "vencordRef"];
export const VERSION_STAMP = /^dockview:(\S+)\s+(v\d+\.\d+\.\d+)\s+([0-9a-f]{40}-[0-9a-f]{64})$/i;

function exactKeys(actual, expected) {
    return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

export function sha256File(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Validate the complete, inert manifest shape before using any values from it. */
export function validateVencordManifest(manifest) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error("Vencord provenance is not a JSON object");
    }
    if (!exactKeys(Object.keys(manifest), MANIFEST_KEYS)) {
        throw new Error("Vencord provenance has unexpected or missing top-level keys");
    }
    if (manifest.schemaVersion !== 1) throw new Error("Unsupported Vencord provenance schema");
    if (!FULL_COMMIT.test(manifest.sourceCommit)) throw new Error("Vencord provenance source commit is not a full SHA");
    if (!STABLE_REF.test(manifest.vencordRef)) throw new Error("Vencord provenance ref is not a stable numeric tag");
    if (!FULL_COMMIT.test(manifest.vencordCommit)) throw new Error("Vencord provenance commit is not a full SHA");
    if (!VENCORD_BUILD_IDENTITY.test(manifest.buildIdentity)) {
        throw new Error("Vencord provenance build identity is malformed");
    }
    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
        throw new Error("Vencord provenance files is not an object");
    }
    if (!exactKeys(Object.keys(manifest.files), VENCORD_OUTPUT_FILES)) {
        throw new Error("Vencord provenance does not contain the exact runtime output key set");
    }
    for (const file of VENCORD_OUTPUT_FILES) {
        if (!SHA256.test(manifest.files[file])) throw new Error(`Vencord provenance digest is malformed: ${file}`);
    }
    return manifest;
}

export function readVencordManifest(path) {
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(path, "utf-8"));
    } catch (error) {
        throw new Error(`Could not read Vencord provenance ${path}: ${error.message}`);
    }
    return validateVencordManifest(manifest);
}

export function verifyVencordManifestMetadata(manifest, { vencordRef, vencordCommit, buildIdentity } = {}) {
    validateVencordManifest(manifest);
    if (vencordRef !== undefined && manifest.vencordRef !== vencordRef) {
        throw new Error("Vencord provenance ref mismatch");
    }
    if (vencordCommit !== undefined && manifest.vencordCommit !== vencordCommit.toLowerCase()) {
        throw new Error("Vencord provenance commit mismatch");
    }
    if (buildIdentity !== undefined && manifest.buildIdentity !== buildIdentity.toLowerCase()) {
        throw new Error("Vencord provenance build identity mismatch");
    }
    return manifest;
}

/** Hash every required runtime file, optionally allowing ignored chunks to be absent. */
export function verifyVencordManifestFiles(directory, manifest, { allowMissingChunks = false } = {}) {
    validateVencordManifest(manifest);
    for (const file of VENCORD_OUTPUT_FILES) {
        const path = join(directory, file);
        let stat;
        try {
            stat = lstatSync(path);
        } catch (error) {
            if (allowMissingChunks && file.startsWith("chunk-") && error.code === "ENOENT") continue;
            throw new Error(`Missing required Vencord output: ${file}`);
        }
        if (!stat.isFile()) throw new Error(`Vencord output is not a regular file: ${file}`);
        const actual = sha256File(path);
        if (actual !== manifest.files[file].toLowerCase()) {
            throw new Error(`Vencord output digest mismatch: ${file}`);
        }
    }
    return manifest;
}

function directoryEntries(directory) {
    try {
        return readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        return { error: `could not read bundle directory: ${error.message}` };
    }
}

/**
 * Validate a post-merge clean checkout. The record itself must be complete,
 * but ignored chunk bytes are optional; any chunks that happen to be present
 * are still checked against their recorded hashes.
 */
export function inspectVencordCheckout(
    directory,
    recordPath,
    { pluginVersion, vencordRef, vencordCommit, buildIdentity } = {}
) {
    const result = {
        current: false,
        directory,
        recordPath,
        missingCoreFiles: [],
        presentChunks: [],
        reasons: [],
        manifest: null
    };

    try {
        result.manifest = readVencordManifest(recordPath);
    } catch (error) {
        result.reasons.push(error.message);
        return result;
    }

    try {
        verifyVencordManifestMetadata(result.manifest, { vencordRef, vencordCommit, buildIdentity });
    } catch (error) {
        result.reasons.push(error.message);
    }

    const entries = directoryEntries(directory);
    if (entries.error) {
        result.reasons.push(entries.error);
        return result;
    }
    const expected = new Set(VENCORD_OUTPUT_FILES);
    const extra = entries.filter(entry => !expected.has(entry.name)).map(entry => entry.name);
    if (extra.length) result.reasons.push(`unexpected bundle output: ${extra.sort().join(", ")}`);

    for (const file of VENCORD_CORE_OUTPUT_FILES) {
        const entry = entries.find(candidate => candidate.name === file);
        if (!entry) {
            result.missingCoreFiles.push(file);
            continue;
        }
        if (!entry.isFile()) {
            result.reasons.push(`tracked output is not a regular file: ${file}`);
            continue;
        }
        const actual = sha256File(join(directory, file));
        if (actual !== result.manifest.files[file].toLowerCase()) {
            result.reasons.push(`tracked output digest mismatch: ${file}`);
        }
    }
    if (result.missingCoreFiles.length) {
        result.reasons.push(`missing tracked output: ${result.missingCoreFiles.join(", ")}`);
    }

    for (const file of VENCORD_CHUNK_OUTPUT_FILES) {
        const entry = entries.find(candidate => candidate.name === file);
        if (!entry) continue;
        result.presentChunks.push(file);
        if (!entry.isFile()) {
            result.reasons.push(`present chunk is not a regular file: ${file}`);
            continue;
        }
        const actual = sha256File(join(directory, file));
        if (actual !== result.manifest.files[file].toLowerCase()) {
            result.reasons.push(`present chunk digest mismatch: ${file}`);
        }
    }

    const versionPath = join(directory, "version.txt");
    try {
        const match = readFileSync(versionPath, "utf-8").trim().match(VERSION_STAMP);
        if (!match) {
            result.reasons.push("version.txt is not a canonical full-provenance stamp");
        } else {
            if (match[1] !== pluginVersion) result.reasons.push(`version.txt plugin is ${match[1]}, expected ${pluginVersion}`);
            if (match[2] !== vencordRef) result.reasons.push(`version.txt Vencord ref is ${match[2]}, expected ${vencordRef}`);
            if (!VENCORD_BUILD_IDENTITY.test(buildIdentity ?? "")) {
                result.reasons.push("expected build identity is not a full plugin-tree/content digest");
            } else if (match[3].toLowerCase() !== buildIdentity.toLowerCase()) {
                result.reasons.push("version.txt build provenance does not match the stable DockView input identity");
            }
        }
    } catch (error) {
        result.reasons.push(`could not read version.txt: ${error.message}`);
    }

    result.current = result.reasons.length === 0;
    return result;
}
