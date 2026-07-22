/* Create or verify an inert two-runtime candidate for upstream Vencord updates. */

import { lstatSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { computeVencordBuildIdentity } from "./lib/vencordBuildIdentity.mjs";
import { readDockViewReleaseMetadata } from "./lib/readDockViewReleaseMetadata.mjs";
import {
    RUNTIME_OUTPUT_PATHS,
    readRuntimeManifest,
    sha256File,
    validateRuntimeManifest,
    verifyRuntimeManifestFiles,
    verifyRuntimeManifestMetadata,
    VERSION_STAMP
} from "./lib/runtimeProvenance.mjs";
import { inspectRuntimeBundles } from "./lib/runtimeBundles.mjs";
import { VENCORD_COMMIT, VENCORD_REF } from "./lib/vencordRef.mjs";
import { DOCKVIEW_OUTPUT_FILES, VENCORD_OUTPUT_FILES } from "./lib/vencordOutputs.mjs";

export const CANDIDATE_MANIFEST = "candidate-provenance.json";
const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const STABLE_REF = /^v\d+\.\d+\.\d+$/;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_METADATA = readDockViewReleaseMetadata(ROOT);

function assertMetadata(sourceCommit, vencordRef, vencordCommit) {
    if (!FULL_COMMIT.test(sourceCommit)) throw new Error("Candidate source commit must be a full SHA");
    if (!STABLE_REF.test(vencordRef)) throw new Error("Candidate Vencord ref must be a stable numeric tag");
    if (!FULL_COMMIT.test(vencordCommit)) throw new Error("Candidate Vencord commit must be a full SHA");
}

function readBuildIdentity(staticDirectory, vencordRef) {
    const value = readFileSync(join(staticDirectory, "dockviewDist", "version.txt"), "utf-8").trim();
    const match = value.match(VERSION_STAMP);
    if (!match || match[2] !== vencordRef) throw new Error("Candidate DockView version stamp does not match Vencord ref");
    return match[3].toLowerCase();
}

function assertCandidateFileSet(staticDirectory, includeManifest) {
    const rootExpected = ["dockviewDist", "vencordDist", ...(includeManifest ? [CANDIDATE_MANIFEST] : [])].sort();
    const rootActual = readdirSync(staticDirectory).sort();
    if (JSON.stringify(rootActual) !== JSON.stringify(rootExpected)) {
        throw new Error(`Candidate root file set mismatch: ${rootActual.join(", ")}`);
    }
    for (const [directory, expected] of [
        ["vencordDist", VENCORD_OUTPUT_FILES],
        ["dockviewDist", DOCKVIEW_OUTPUT_FILES]
    ]) {
        const full = join(staticDirectory, directory);
        if (!lstatSync(full).isDirectory()) throw new Error(`Candidate entry is not a directory: ${directory}`);
        const actual = readdirSync(full).sort();
        const wanted = [...expected].sort();
        if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
            throw new Error(`Candidate ${directory} file set mismatch: ${actual.join(", ")}`);
        }
        for (const file of actual) {
            if (!lstatSync(join(full, file)).isFile()) throw new Error(`Candidate output is not a regular file: ${directory}/${file}`);
        }
    }
}

function candidateManifest(staticDirectory, sourceCommit, vencordRef, vencordCommit) {
    const manifest = {
        schemaVersion: 1,
        sourceCommit: sourceCommit.toLowerCase(),
        vencordRef,
        vencordCommit: vencordCommit.toLowerCase(),
        buildIdentity: readBuildIdentity(staticDirectory, vencordRef),
        files: Object.fromEntries(RUNTIME_OUTPUT_PATHS.map(path => [path, sha256File(join(staticDirectory, path))]))
    };
    return validateRuntimeManifest(manifest);
}

export function createCandidate(staticDirectory, sourceCommit, vencordRef, vencordCommit) {
    assertMetadata(sourceCommit, vencordRef, vencordCommit);
    assertCandidateFileSet(staticDirectory, false);
    const manifest = candidateManifest(staticDirectory, sourceCommit, vencordRef, vencordCommit);
    verifyRuntimeManifestFiles(staticDirectory, manifest);
    writeFileSync(join(staticDirectory, CANDIDATE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}

export function verifyCandidate(staticDirectory, sourceCommit, vencordRef, vencordCommit) {
    assertMetadata(sourceCommit, vencordRef, vencordCommit);
    assertCandidateFileSet(staticDirectory, true);
    const manifest = readRuntimeManifest(join(staticDirectory, CANDIDATE_MANIFEST));
    if (manifest.sourceCommit !== sourceCommit.toLowerCase()) throw new Error("Candidate source commit mismatch");
    verifyRuntimeManifestMetadata(manifest, { vencordRef, vencordCommit });
    if (readBuildIdentity(staticDirectory, vencordRef) !== manifest.buildIdentity) throw new Error("Candidate build identity mismatch");
    verifyRuntimeManifestFiles(staticDirectory, manifest);
    return manifest;
}

export function verifyGeneratedOutput(
    root = ROOT,
    {
        pluginVersion = RELEASE_METADATA.pluginVersion,
        vencordRef = VENCORD_REF,
        vencordCommit = VENCORD_COMMIT,
        buildIdentity = computeVencordBuildIdentity(root)
    } = {}
) {
    if (!STABLE_REF.test(vencordRef) || !FULL_COMMIT.test(vencordCommit)) throw new Error("Generated Vencord metadata is invalid");
    const result = inspectRuntimeBundles(root, { pluginVersion, vencordRef, buildIdentity });
    if (!result.current) throw new Error(`Generated runtime output is not current: ${result.reasons.join("; ")}`);
    return [...RUNTIME_OUTPUT_PATHS];
}

function usage() {
    return "Usage: node scripts/runtime-candidate.mjs <create|verify> <static-directory> <source-commit> <vencord-ref> <vencord-commit>, or verify-generated [repository-root]";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const [operation, directory, sourceCommit, vencordRef, vencordCommit] = process.argv.slice(2);
    try {
        if (operation === "verify-generated") {
            verifyGeneratedOutput(directory || ROOT);
            console.log(`Verified complete disjoint runtime output (${RUNTIME_OUTPUT_PATHS.length} files)`);
        } else if (operation === "create") {
            createCandidate(directory, sourceCommit, vencordRef, vencordCommit);
            console.log(`Created runtime candidate ${vencordRef}@${vencordCommit}`);
        } else if (operation === "verify") {
            verifyCandidate(directory, sourceCommit, vencordRef, vencordCommit);
            console.log(`Verified runtime candidate ${vencordRef}@${vencordCommit}`);
        } else {
            throw new Error(usage());
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
