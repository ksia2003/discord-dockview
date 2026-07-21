/*
 * Update the single pinned Vencord release used by prepare-vencord.mjs.
 * This is intentionally tiny and strict because a scheduled workflow calls it
 * with a GitHub API value before committing an automated candidate branch.
 */

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const VENCORD_REF_FILE = join(ROOT, "scripts", "lib", "vencordRef.mjs");
export const STABLE_VENCORD_REF = /^v\d+\.\d+\.\d+$/;
export const FULL_COMMIT = /^[0-9a-f]{40}$/i;

export function replaceVencordRef(source, nextRef, nextCommit) {
    if (!STABLE_VENCORD_REF.test(nextRef)) {
        throw new Error(`Ref must be a stable Vencord release tag, got ${JSON.stringify(nextRef)}`);
    }
    if (!FULL_COMMIT.test(nextCommit)) {
        throw new Error(`Commit must be a full SHA, got ${JSON.stringify(nextCommit)}`);
    }

    const refDeclaration = /^export const VENCORD_REF = "v\d+\.\d+\.\d+";$/gm;
    const commitDeclaration = /^export const VENCORD_COMMIT = "[0-9a-f]{40}";$/gim;
    const refMatches = source.match(refDeclaration) ?? [];
    const commitMatches = source.match(commitDeclaration) ?? [];
    if (refMatches.length !== 1 || commitMatches.length !== 1) {
        throw new Error(
            `Expected exactly one VENCORD_REF and VENCORD_COMMIT declaration, found ${refMatches.length} and ${commitMatches.length}`
        );
    }
    return source
        .replace(refDeclaration, `export const VENCORD_REF = "${nextRef}";`)
        .replace(commitDeclaration, `export const VENCORD_COMMIT = "${nextCommit.toLowerCase()}";`);
}

export function setVencordRef(nextRef, nextCommit, path = VENCORD_REF_FILE) {
    const current = readFileSync(path, "utf-8");
    const updated = replaceVencordRef(current, nextRef, nextCommit);
    if (updated !== current) writeFileSync(path, updated);
}

export function verifyVencordRefChange(baseCommit, nextRef, nextCommit, path = VENCORD_REF_FILE) {
    if (!FULL_COMMIT.test(baseCommit)) throw new Error("Base commit must be a full SHA");
    const base = execFileSync("git", ["show", `${baseCommit}:scripts/lib/vencordRef.mjs`], {
        cwd: ROOT,
        encoding: "utf-8"
    });
    const expected = replaceVencordRef(base, nextRef, nextCommit);
    const actual = readFileSync(path, "utf-8");
    if (actual !== expected) throw new Error("Vencord ref file contains changes beyond the expected pin update");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const verify = process.argv[2] === "--verify-change";
    const baseCommit = verify ? process.argv[3] : null;
    const nextRef = process.argv[verify ? 4 : 2];
    const nextCommit = process.argv[verify ? 5 : 3];
    if (!nextRef || !nextCommit || (verify && !baseCommit)) {
        console.error(
            "Usage: node scripts/set-vencord-ref.mjs [--verify-change <base-commit>] <vX.Y.Z> <40-character-commit>"
        );
        process.exitCode = 2;
    } else {
        try {
            if (verify) {
                verifyVencordRefChange(baseCommit, nextRef, nextCommit);
                console.log(`Verified isolated Vencord pin change to ${nextRef} (${nextCommit.toLowerCase()})`);
            } else {
                setVencordRef(nextRef, nextCommit);
                console.log(`Pinned Vencord to ${nextRef} (${nextCommit.toLowerCase()})`);
            }
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    }
}
