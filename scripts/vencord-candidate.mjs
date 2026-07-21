/*
 * Create or verify the inert Vencord candidate artifact passed from the
 * read-only build job to the write-capable draft-PR job.
 */

import { lstatSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { computeVencordBuildIdentity } from "./lib/vencordBuildIdentity.mjs";
import { readDockViewReleaseMetadata } from "./lib/readDockViewReleaseMetadata.mjs";
import {
    readVencordManifest,
    sha256File,
    validateVencordManifest,
    verifyVencordManifestFiles,
    verifyVencordManifestMetadata
} from "./lib/vencordProvenance.mjs";
import { VENCORD_COMMIT, VENCORD_REF } from "./lib/vencordRef.mjs";
import { inspectVencordBundle } from "./lib/vencordBundle.mjs";
import { VENCORD_OUTPUT_FILES } from "./lib/vencordOutputs.mjs";

export const CANDIDATE_MANIFEST = "candidate-provenance.json";
const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const STABLE_REF = /^v\d+\.\d+\.\d+$/;
const VERSION = /^dockview:\S+\s+(v\d+\.\d+\.\d+)\s+([0-9a-f]{40}-[0-9a-f]{64})$/i;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_METADATA = readDockViewReleaseMetadata(ROOT);

function assertMetadata(sourceCommit, vencordRef, vencordCommit) {
    if (!FULL_COMMIT.test(sourceCommit)) throw new Error("Candidate source commit must be a full SHA");
    if (!STABLE_REF.test(vencordRef)) throw new Error("Candidate Vencord ref must be a stable numeric tag");
    if (!FULL_COMMIT.test(vencordCommit)) throw new Error("Candidate Vencord commit must be a full SHA");
}

function assertGeneratedMetadata(vencordRef, vencordCommit) {
    if (!STABLE_REF.test(vencordRef)) throw new Error("Generated Vencord ref is not a stable numeric tag");
    if (!FULL_COMMIT.test(vencordCommit)) throw new Error("Generated Vencord commit is not a full SHA");
}

function assertFiles(directory, includeManifest) {
    const expected = [...VENCORD_OUTPUT_FILES, ...(includeManifest ? [CANDIDATE_MANIFEST] : [])].sort();
    const entries = readdirSync(directory, { withFileTypes: true });
    const actual = entries.map(entry => entry.name).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Candidate file set mismatch (expected ${expected.join(", ")}; got ${actual.join(", ")})`);
    }
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (!entry.isFile() || !lstatSync(path).isFile())
            throw new Error(`Candidate entry is not a regular file: ${entry.name}`);
    }
}

function readBuildIdentity(directory, vencordRef) {
    const version = readFileSync(join(directory, "version.txt"), "utf-8").trim();
    const match = version.match(VERSION);
    if (!match || match[1] !== vencordRef) {
        throw new Error("Candidate version.txt does not contain the expected Vencord ref and stable build identity");
    }
    return match[2].toLowerCase();
}

export function createCandidate(directory, sourceCommit, vencordRef, vencordCommit) {
    assertMetadata(sourceCommit, vencordRef, vencordCommit);
    assertFiles(directory, false);
    const buildIdentity = readBuildIdentity(directory, vencordRef);
    const digests = Object.fromEntries(
        VENCORD_OUTPUT_FILES.map(file => [file, sha256File(join(directory, file))])
    );
    const manifest = {
        schemaVersion: 1,
        sourceCommit: sourceCommit.toLowerCase(),
        vencordRef,
        vencordCommit: vencordCommit.toLowerCase(),
        buildIdentity,
        files: digests
    };
    validateVencordManifest(manifest);
    writeFileSync(join(directory, CANDIDATE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}

export function verifyCandidate(directory, sourceCommit, vencordRef, vencordCommit) {
    assertMetadata(sourceCommit, vencordRef, vencordCommit);
    assertFiles(directory, true);
    const manifest = readVencordManifest(join(directory, CANDIDATE_MANIFEST));
    if (manifest?.schemaVersion !== 1) throw new Error("Unsupported candidate manifest schema");
    if (manifest?.sourceCommit !== sourceCommit.toLowerCase()) throw new Error("Candidate source commit mismatch");
    verifyVencordManifestMetadata(manifest, { vencordRef, vencordCommit });
    if (readBuildIdentity(directory, vencordRef) !== manifest.buildIdentity.toLowerCase()) {
        throw new Error("Candidate build identity mismatch");
    }
    verifyVencordManifestFiles(directory, manifest);
    return manifest;
}

/** Verify a complete generated tree without requiring a persisted candidate record. */
export function verifyGeneratedOutput(
    directory,
    {
        root = ROOT,
        pluginVersion = RELEASE_METADATA.pluginVersion,
        vencordRef = VENCORD_REF,
        vencordCommit = VENCORD_COMMIT,
        buildIdentity = computeVencordBuildIdentity(root)
    } = {}
) {
    assertGeneratedMetadata(vencordRef, vencordCommit);
    assertFiles(directory, false);
    const bundle = inspectVencordBundle(directory, {
        pluginVersion,
        vencordRef,
        buildIdentity
    });
    if (!bundle.current) throw new Error(`Generated Vencord output is not current: ${bundle.reasons.join("; ")}`);
    return [...VENCORD_OUTPUT_FILES];
}

function usage() {
    return "Usage: node scripts/vencord-candidate.mjs <create|verify|verify-generated> <directory> [source-commit] [vencord-ref] [vencord-commit]";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const [operation, directory, sourceCommit, vencordRef, vencordCommit] = process.argv.slice(2);
    if (
        !operation ||
        !directory ||
        (operation !== "verify-generated" && (!sourceCommit || !vencordRef || !vencordCommit))
    ) {
        console.error(usage());
        process.exitCode = 2;
    } else {
        try {
            const result =
                operation === "create"
                    ? createCandidate(directory, sourceCommit, vencordRef, vencordCommit)
                    : operation === "verify"
                      ? verifyCandidate(directory, sourceCommit, vencordRef, vencordCommit)
                      : operation === "verify-generated"
                        ? verifyGeneratedOutput(directory)
                        : (() => {
                            throw new Error(usage());
                        })();
            console.log(
                operation === "verify-generated"
                    ? `Verified complete Vencord output tree (${VENCORD_OUTPUT_FILES.length} files)`
                    : `${operation === "create" ? "Created" : "Verified"} Vencord candidate ${result.vencordRef}@${result.vencordCommit}`
            );
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    }
}
