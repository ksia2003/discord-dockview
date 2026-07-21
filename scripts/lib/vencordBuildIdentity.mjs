/*
 * Stable identity for the DockView inputs that produce static/vencordDist.
 *
 * Do not use HEAD here: documentation/workflow commits do not alter the
 * generated bundle. The plugin Git tree and the helper sources are hashed
 * independently of the surrounding commit so a bundle remains current across
 * source-only automation commits while real build-input changes invalidate it.
 */

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const FULL_SHA = /^[0-9a-f]{40}$/i;

// Every file outside plugin/ that can alter the generated renderer/chunks or
// the fixed output contract must be part of this identity. Dependency versions
// are covered by vencordDependencies.mjs; the pinned Vencord commit is stamped
// separately in version.txt and candidate-provenance.json. The repository
// package manifest/lockfile are included because package-manager scripts and
// resolved workspace inputs can affect how this builder runs.
export const VENCORD_BUILD_INPUT_FILES = Object.freeze([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/build-chunks.mjs",
    "scripts/build-sample-chunk.mjs",
    "scripts/chunkList.mjs",
    "scripts/lib/vencordBuildIdentity.mjs",
    "scripts/lib/commandInvocation.mjs",
    "scripts/lib/vencordDependencies.mjs",
    "scripts/lib/vencordOutputs.mjs",
    "scripts/lib/readDockViewReleaseMetadata.mjs",
    "scripts/patch-vencord-build.mjs",
    "scripts/utils/node-empty-stub.mjs",
    "scripts/utils/util-browser-stub.mjs",
    "scripts/vencord-patch/dockview-chunk-external.mjs",
    "scripts/prepare-vencord.mjs"
]);

function pluginFiles(root) {
    const directory = join(root, "plugin");
    const files = [];
    function visit(current) {
        for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(current, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.isFile()) files.push(path);
            else throw new Error(`Unsupported plugin build input entry: ${path}`);
        }
    }
    visit(directory);
    return files;
}

function hashFiles(root, paths) {
    const hash = createHash("sha256");
    for (const path of paths) {
        const bytes = readFileSync(path);
        const name = relative(root, path).split(sep).join("/");
        hash.update(name);
        hash.update("\0");
        hash.update(bytes);
        hash.update("\0");
    }
    return hash.digest("hex");
}

function pluginTreeSha(root) {
    let value;
    try {
        value = execFileSync("git", ["rev-parse", "HEAD:plugin"], { cwd: root, encoding: "utf-8" }).trim();
    } catch (error) {
        throw new Error(`Could not determine plugin Git tree SHA: ${error.message}`);
    }
    if (!FULL_SHA.test(value)) throw new Error(`Plugin Git tree is not a full SHA: ${value}`);
    return value.toLowerCase();
}

/** Return the stable identity embedded in version.txt for a generated bundle. */
export function computeVencordBuildIdentity(root) {
    if (typeof root !== "string" || !root) throw new Error("Build identity root must be a non-empty path");
    const plugin = pluginFiles(root);
    const helper = VENCORD_BUILD_INPUT_FILES.map(file => join(root, file));
    for (const path of helper) {
        if (!statSync(path).isFile()) throw new Error(`Build identity input is not a regular file: ${path}`);
    }
    const contentDigest = hashFiles(root, [...plugin, ...helper]);
    return `${pluginTreeSha(root)}-${contentDigest}`;
}

export const VENCORD_BUILD_IDENTITY = /^[0-9a-f]{40}-[0-9a-f]{64}$/i;
