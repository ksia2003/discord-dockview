/*
 * Inspect the stable Vencord release and Vesktop upstream head/release used by
 * DockView. The scheduled workflow consumes the strict single-line outputs and
 * the human-readable Markdown report; tests import the pure selection helpers.
 */

import { execFileSync } from "child_process";
import { appendFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { readDockViewReleaseMetadata } from "./lib/readDockViewReleaseMetadata.mjs";
import { computeVencordBuildIdentity } from "./lib/vencordBuildIdentity.mjs";
import { inspectVencordCheckout, VENCORD_PROVENANCE_RECORD } from "./lib/vencordProvenance.mjs";
import { VENCORD_COMMIT, VENCORD_REF } from "./lib/vencordRef.mjs";
import { VESKTOP_REVIEWED_COMMIT, VESKTOP_REVIEWED_VERSION } from "./lib/vesktopReview.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_ROOT = "https://api.github.com";
const STABLE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parseStableTag(tag) {
    if (typeof tag !== "string") return null;
    const match = tag.match(STABLE_TAG);
    if (!match) return null;
    return {
        tag,
        version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
        parts: match.slice(1).map(Number)
    };
}

function compareParts(a, b) {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

export function selectLatestStableRelease(releases) {
    if (!Array.isArray(releases)) throw new Error("GitHub releases response was not an array");

    const candidates = releases
        .filter(release => release && !release.draft && !release.prerelease)
        .map(release => ({ release, parsed: parseStableTag(release.tag_name) }))
        .filter(candidate => candidate.parsed !== null);

    if (candidates.length === 0) throw new Error("No stable numeric release was found");
    return candidates.reduce((latest, candidate) =>
        compareParts(candidate.parsed.parts, latest.parsed.parts) > 0 ? candidate : latest
    );
}

export function selectLatestStableTag(tags) {
    if (!Array.isArray(tags)) throw new Error("GitHub tags response was not an array");
    const candidates = tags
        .map(tag => ({ tag, parsed: parseStableTag(tag?.name) }))
        .filter(candidate => candidate.parsed !== null);
    if (candidates.length === 0) throw new Error("No stable numeric tag was found");
    return candidates.reduce((latest, candidate) =>
        compareParts(candidate.parsed.parts, latest.parsed.parts) > 0 ? candidate : latest
    );
}

function apiHeaders(token) {
    return {
        Accept: "application/vnd.github+json",
        "User-Agent": "DockView-Upstream-Watch",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
}

async function fetchJson(fetchImpl, path, token) {
    const response = await fetchImpl(`${API_ROOT}${path}`, { headers: apiHeaders(token) });
    if (!response.ok) throw new Error(`GitHub API ${path} returned HTTP ${response.status}`);
    return response.json();
}

export async function fetchAllPages(fetchImpl, path, token, { pageSize = 100, maxPages = 20 } = {}) {
    const combined = [];
    for (let page = 1; page <= maxPages; page++) {
        const separator = path.includes("?") ? "&" : "?";
        const batch = await fetchJson(fetchImpl, `${path}${separator}per_page=${pageSize}&page=${page}`, token);
        if (!Array.isArray(batch)) throw new Error(`GitHub API ${path} response was not an array`);
        combined.push(...batch);
        if (batch.length < pageSize) return combined;
    }
    throw new Error(`GitHub API ${path} exceeded the ${maxPages}-page safety limit`);
}

export async function inspectUpstreams({ fetchImpl = fetch, token = process.env.GITHUB_TOKEN, root = ROOT } = {}) {
    const current = readDockViewReleaseMetadata(root);
    let sourceCommit;
    try {
        sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
    } catch (error) {
        throw new Error(`Could not determine monitored source SHA: ${error.message}`);
    }
    if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) {
        throw new Error(`Monitored source is not a full SHA: ${sourceCommit}`);
    }
    const buildIdentity = computeVencordBuildIdentity(root);
    const reviewedVesktop = parseStableTag(VESKTOP_REVIEWED_VERSION);
    if (!reviewedVesktop) {
        throw new Error(`Reviewed Vesktop version is not numeric: ${VESKTOP_REVIEWED_VERSION}`);
    }
    if (!/^[0-9a-f]{40}$/i.test(VESKTOP_REVIEWED_COMMIT)) {
        throw new Error(`Reviewed Vesktop commit is not a full SHA: ${VESKTOP_REVIEWED_COMMIT}`);
    }
    const [vencordTags, vesktopReleases, vesktopRepository] = await Promise.all([
        fetchAllPages(fetchImpl, "/repos/Vendicated/Vencord/tags", token),
        fetchAllPages(fetchImpl, "/repos/Vencord/Vesktop/releases", token),
        fetchJson(fetchImpl, "/repos/Vencord/Vesktop", token)
    ]);

    const vencordSelection = selectLatestStableTag(vencordTags);
    const vencordLatest = vencordSelection.parsed;
    const vencordLatestCommit = vencordSelection.tag?.commit?.sha;
    if (typeof vencordLatestCommit !== "string" || !/^[0-9a-f]{40}$/i.test(vencordLatestCommit)) {
        throw new Error("Latest stable Vencord tag has no full commit SHA");
    }
    if (!/^[0-9a-f]{40}$/i.test(VENCORD_COMMIT)) {
        throw new Error(`Pinned Vencord commit is not a full SHA: ${VENCORD_COMMIT}`);
    }
    const vesktopLatest = selectLatestStableRelease(vesktopReleases).parsed;
    const currentVencord = parseStableTag(VENCORD_REF);
    if (!currentVencord) throw new Error(`Pinned Vencord ref is not a stable release tag: ${VENCORD_REF}`);
    const bundle = inspectVencordCheckout(
        join(root, "static", "vencordDist"),
        join(root, VENCORD_PROVENANCE_RECORD),
        {
            pluginVersion: current.pluginVersion,
            vencordRef: VENCORD_REF,
            vencordCommit: VENCORD_COMMIT,
            buildIdentity
        }
    );
    const defaultBranch = vesktopRepository?.default_branch;
    if (typeof defaultBranch !== "string" || !defaultBranch) {
        throw new Error("Vesktop repository response has no default_branch");
    }

    const vesktopHead = await fetchJson(
        fetchImpl,
        `/repos/Vencord/Vesktop/commits/${encodeURIComponent(defaultBranch)}`,
        token
    );
    const headCommit = vesktopHead?.sha;
    if (typeof headCommit !== "string" || !/^[0-9a-f]{40}$/i.test(headCommit)) {
        throw new Error("Vesktop head response has no full commit SHA");
    }

    return {
        checkedAt: new Date().toISOString(),
        vencord: {
            currentRef: VENCORD_REF,
            currentCommit: VENCORD_COMMIT.toLowerCase(),
            latestRef: vencordLatest.tag,
            latestCommit: vencordLatestCommit.toLowerCase(),
            latestVersion: vencordLatest.version,
            bundleCurrent: bundle.current,
            bundleReasons: bundle.reasons,
            buildIdentity,
            updateAvailable:
                currentVencord.version !== vencordLatest.version ||
                VENCORD_COMMIT.toLowerCase() !== vencordLatestCommit.toLowerCase() ||
                !bundle.current
        },
        vesktop: {
            currentVersion: current.appVersion,
            currentCommit: current.vesktopCommit,
            reviewedVersion: VESKTOP_REVIEWED_VERSION,
            reviewedCommit: VESKTOP_REVIEWED_COMMIT,
            latestVersion: vesktopLatest.version,
            latestReleaseTag: vesktopLatest.tag,
            defaultBranch,
            headCommit: headCommit.toLowerCase(),
            releaseUpdateAvailable: reviewedVesktop.version !== vesktopLatest.version,
            headUpdateAvailable: VESKTOP_REVIEWED_COMMIT !== headCommit.toLowerCase(),
            get updateAvailable() {
                return this.releaseUpdateAvailable || this.headUpdateAvailable;
            }
        },
        sourceCommit,
        buildIdentity
    };
}

export function formatReport(result) {
    const short = commit => commit.slice(0, 10);
    const bundleCurrent = result.vencord.bundleCurrent ?? true;
    const bundleReasons = result.vencord.bundleReasons ?? [];
    return (
        [
            "## DockView upstream status",
            "",
            `Checked: ${result.checkedAt}`,
            "",
            "| Upstream | Current | Latest | Action |",
            "|---|---|---|---|",
            `| Vencord stable | \`${result.vencord.currentRef}@${short(result.vencord.currentCommit)}\` (${bundleCurrent ? "bundle current" : "bundle stale/missing"}) | \`${result.vencord.latestRef}@${short(result.vencord.latestCommit)}\` | ${result.vencord.updateAvailable ? "candidate PR required" : "up to date"} |`,
            `| Vesktop release | bundled \`${result.vesktop.currentVersion}\`, reviewed \`${result.vesktop.reviewedVersion}\` | \`${result.vesktop.latestVersion}\` | ${result.vesktop.releaseUpdateAvailable ? "rebase review required" : "reviewed"} |`,
            `| Vesktop ${result.vesktop.defaultBranch} | bundled \`${short(result.vesktop.currentCommit)}\`, reviewed \`${short(result.vesktop.reviewedCommit)}\` | \`${short(result.vesktop.headCommit)}\` | ${result.vesktop.headUpdateAvailable ? "source review required" : "reviewed"} |`,
            "",
            `Monitored source: \`${result.sourceCommit ?? "not recorded"}\`; stable bundle inputs: \`${result.buildIdentity ?? result.vencord.buildIdentity ?? "not recorded"}\`. ` +
                (bundleCurrent
                    ? "The persisted Vencord provenance record and tracked core outputs match the DockView inputs. "
                    : `The persisted Vencord provenance or tracked core outputs are not current: ${bundleReasons.join("; ")}. `) +
                "Vencord candidates are rebuilt with DockView and tested before an automated draft PR is opened. " +
                "Vesktop changes are never merged automatically because they can overlap Electron, voice, screen-share, and updater code."
        ].join("\n") + "\n"
    );
}

function writeGithubOutputs(path, result) {
    const outputs = {
        any_update: result.vencord.updateAvailable || result.vesktop.updateAvailable,
        vencord_update: result.vencord.updateAvailable,
        vencord_latest_ref: result.vencord.latestRef,
        vencord_latest_commit: result.vencord.latestCommit,
        vencord_latest_version: result.vencord.latestVersion,
        vencord_bundle_current: result.vencord.bundleCurrent,
        vencord_build_identity: result.vencord.buildIdentity,
        vesktop_update: result.vesktop.updateAvailable,
        vesktop_latest_version: result.vesktop.latestVersion,
        vesktop_head: result.vesktop.headCommit
    };
    for (const [name, value] of Object.entries(outputs)) appendFileSync(path, `${name}=${value}\n`);
}

function argument(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main() {
    const reportPath = argument("--report");
    const outputPath = argument("--github-output");
    const result = await inspectUpstreams();
    const report = formatReport(result);
    if (reportPath) writeFileSync(reportPath, report);
    if (outputPath) writeGithubOutputs(outputPath, result);
    process.stdout.write(report);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch(error => {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exitCode = 1;
    });
}
