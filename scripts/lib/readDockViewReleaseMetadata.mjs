/*
 * Compose DockView's intentionally separate release identities for build tools.
 * This reads the authoritative literals; it does not make them one version.
 */

import { readFileSync } from "fs";
import { join } from "path";

const NUMERIC_DOTTED_VERSION = /^\d+(?:\.\d+)+$/;
const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/i;
const GITHUB_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+$/;

function fail(message) {
    throw new Error(`DockView release metadata: ${message}`);
}

function readText(path) {
    try {
        return readFileSync(path, "utf-8");
    } catch (error) {
        fail(`could not read ${path}: ${error.message}`);
    }
}

function readLiteral(path, name) {
    const source = readText(path);
    const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*["']([^"']+)["']`));
    if (!match) fail(`could not find ${name} literal in ${path}`);
    return match[1];
}

function githubSlug(value, label) {
    if (typeof value !== "string" || !value) fail(`${label} must be a non-empty GitHub repository value`);
    let slug = value.trim();
    try {
        if (/^(?:https?:|git@)/i.test(slug)) {
            slug = slug
                .replace(/^git@github\.com:/i, "")
                .replace(/^https?:\/\/github\.com\//i, "")
                .replace(/\.git\/?$/i, "")
                .replace(/\/$/, "");
        }
    } catch {
        fail(`${label} is not a valid GitHub repository value`);
    }
    if (!GITHUB_SLUG.test(slug)) fail(`${label} must identify a GitHub owner/repo, got ${JSON.stringify(value)}`);
    return slug;
}

function validateVersion(value, label) {
    if (!NUMERIC_DOTTED_VERSION.test(value))
        fail(`${label} must be a numeric dotted version, got ${JSON.stringify(value)}`);
    return value;
}

/**
 * Read and validate the release metadata used by build and release tooling.
 * package.json owns appVersion; plugin/version.ts and dockviewVersion.ts own
 * their respective update-domain versions.
 */
export function readDockViewReleaseMetadata(root) {
    if (typeof root !== "string" || !root) fail("root must be a non-empty path");

    const packagePath = join(root, "package.json");
    let pkg;
    try {
        pkg = JSON.parse(readText(packagePath));
    } catch (error) {
        fail(`could not parse ${packagePath}: ${error.message}`);
    }

    const appVersion = validateVersion(pkg.version, "package.json version");
    const packageRepository = githubSlug(
        typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url,
        "package.json repository"
    );
    const homepageRepository = githubSlug(pkg.homepage, "package.json homepage");
    const pluginVersion = validateVersion(
        readLiteral(join(root, "plugin", "version.ts"), "DOCKVIEW_PLUGIN_VERSION"),
        "plugin version"
    );
    const pluginRepository = githubSlug(
        readLiteral(join(root, "plugin", "version.ts"), "DOCKVIEW_RELEASE_REPOSITORY"),
        "plugin release repository"
    );
    const shellVersion = validateVersion(
        readLiteral(join(root, "src", "shared", "dockviewVersion.ts"), "DOCKVIEW_SHELL_VERSION"),
        "shell version"
    );
    const appRepository = githubSlug(
        readLiteral(join(root, "src", "shared", "dockviewRelease.ts"), "DOCKVIEW_RELEASE_REPOSITORY"),
        "app-domain release repository"
    );
    const vesktopCommit = readLiteral(join(root, "src", "shared", "dockviewRelease.ts"), "DOCKVIEW_VESKTOP_COMMIT");
    if (!FULL_GIT_COMMIT.test(vesktopCommit))
        fail(`Vesktop commit must be a full 40-hex commit, got ${JSON.stringify(vesktopCommit)}`);

    const repositories = [packageRepository, homepageRepository, appRepository, pluginRepository];
    if (!repositories.every(value => value === repositories[0])) {
        fail(`package, homepage, app-domain, and plugin-domain repositories must match (${repositories.join(", ")})`);
    }

    const [owner, repo] = packageRepository.split("/");
    return {
        appVersion,
        pluginVersion,
        shellVersion,
        vesktopCommit: vesktopCommit.toLowerCase(),
        repository: {
            owner,
            repo,
            slug: packageRepository,
            url: `https://github.com/${packageRepository}`
        },
        tag: `v${pluginVersion}`
    };
}
