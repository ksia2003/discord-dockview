#!/usr/bin/env node

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { readDockViewReleaseMetadata } from "./lib/readDockViewReleaseMetadata.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const usage = `Usage: node scripts/verify-dockview-release-metadata.mjs [options]

Source-only mode has no options. Optional artifact checks:
  --version-file <path>    check canonical dockview:<plugin> version.txt
  --manifest <path>        check generated schema-2 update manifest
  --installers-dir <path>  check installer files named by manifest.shell.installers
  --release-base <url>     require absolute artifact URLs under this release base
  --latest-yml <path>      check one latest*.yml file or a directory containing them`;

function fail(message) {
    throw new Error(`DockView release verification: ${message}`);
}

function readJson(path, label) {
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    } catch (error) {
        fail(`could not read ${label} ${path}: ${error.message}`);
    }
}

function file(path, label) {
    if (!existsSync(path)) fail(`${label} does not exist: ${path}`);
    if (!statSync(path).isFile()) fail(`${label} is not a file: ${path}`);
}

function sha256Hex(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function relativeArtifactPath(value) {
    if (
        typeof value !== "string" ||
        !value ||
        /^[a-z][a-z\d+.-]*:/i.test(value) ||
        value.startsWith("/") ||
        value.includes("?") ||
        value.includes("#")
    ) {
        return false;
    }
    return value.split("/").every(segment => {
        if (!segment || segment === "." || segment === "..") return false;
        try {
            const decoded = decodeURIComponent(segment);
            return decoded && decoded !== "." && decoded !== ".." && !decoded.includes("/") && !decoded.includes("\\");
        } catch {
            return false;
        }
    });
}

function safeUrlPathname(pathname) {
    return pathname.split("/").every(segment => {
        if (!segment) return true;
        try {
            const decoded = decodeURIComponent(segment);
            return decoded !== "." && decoded !== ".." && !decoded.includes("/") && !decoded.includes("\\");
        } catch {
            return false;
        }
    });
}

function normalizedReleaseBase(value) {
    if (typeof value !== "string" || !value) fail("--release-base must be a non-empty absolute URL");
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        fail(`--release-base is not a valid absolute URL: ${value}`);
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        fail("--release-base must be an http(s) URL without credentials, query, or fragment");
    }
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "/") fail("--release-base must include a release pathname");
    if (!safeUrlPathname(pathname)) fail("--release-base must not contain encoded traversal or separators");
    return { origin: parsed.origin, pathname };
}

function checkArtifactUrl(value, label, releaseBase) {
    if (relativeArtifactPath(value)) return;
    if (typeof value !== "string") fail(`${label} URL must be a string`);
    if (value.startsWith("//")) fail(`${label} URL must not be protocol-relative`);
    if (!releaseBase) fail(`${label} URL is not a bare relative path; pass --release-base to verify it`);

    let artifact;
    try {
        artifact = new URL(value);
    } catch {
        fail(`${label} URL is malformed: ${value}`);
    }
    if (
        !/^https?:$/.test(artifact.protocol) ||
        artifact.username ||
        artifact.password ||
        artifact.search ||
        artifact.hash
    ) {
        fail(`${label} URL must be an http(s) URL without credentials, query, or fragment`);
    }
    if (!safeUrlPathname(artifact.pathname)) fail(`${label} URL must not contain encoded traversal or separators`);
    if (artifact.origin !== releaseBase.origin || !artifact.pathname.startsWith(`${releaseBase.pathname}/`)) {
        fail(`${label} URL must remain strictly beneath ${releaseBase.origin}${releaseBase.pathname}/, got ${value}`);
    }
}

function checkVersionFile(path, metadata) {
    file(path, "version.txt");
    const value = readFileSync(path, "utf-8").trim();
    const match = value.match(/^dockview:(\S+)\s+\S+\s+\S+$/);
    if (!match) fail(`version.txt must use canonical dockview:<plugin> <vencordRef> <gitHash> form: ${path}`);
    if (match[1] !== metadata.pluginVersion)
        fail(`version.txt plugin version is ${match[1]}, expected ${metadata.pluginVersion}`);
}

const SUPPORTED_INSTALLERS = new Map([
    ["win-nsis-all", ["win-nsis", "all"]],
    ["appimage-x64", ["appimage", "x64"]],
    ["appimage-arm64", ["appimage", "arm64"]],
    ["deb-x64", ["deb", "x64"]],
    ["deb-arm64", ["deb", "arm64"]],
    ["rpm-x64", ["rpm", "x64"]],
    ["rpm-arm64", ["rpm", "arm64"]]
]);

function checkManifest(path, metadata, releaseBase, installersDir) {
    file(path, "manifest");
    const manifest = readJson(path, "manifest");
    if (manifest?.schema !== 2) fail(`manifest schema must remain 2, got ${JSON.stringify(manifest?.schema)}`);
    if (manifest?.pluginVersion !== metadata.pluginVersion)
        fail(
            `manifest pluginVersion is ${JSON.stringify(manifest?.pluginVersion)}, expected ${metadata.pluginVersion}`
        );
    if (manifest?.shellVersion !== metadata.shellVersion)
        fail(`manifest shellVersion is ${JSON.stringify(manifest?.shellVersion)}, expected ${metadata.shellVersion}`);
    if (manifest?.shell?.version !== metadata.shellVersion)
        fail(
            `manifest shell.version is ${JSON.stringify(manifest?.shell?.version)}, expected ${metadata.shellVersion}`
        );
    if (manifest?.vesktop?.version !== metadata.appVersion)
        fail(
            `manifest vesktop.version is ${JSON.stringify(manifest?.vesktop?.version)}, expected ${metadata.appVersion}`
        );
    if (manifest?.vesktop?.commit !== metadata.vesktopCommit)
        fail(
            `manifest vesktop.commit is ${JSON.stringify(manifest?.vesktop?.commit)}, expected ${metadata.vesktopCommit}`
        );
    if (!manifest.files || typeof manifest.files !== "object") fail("manifest files must be an object");

    const normalizedBase = releaseBase ? normalizedReleaseBase(releaseBase) : null;
    for (const [name, entry] of Object.entries(manifest.files)) {
        if (!entry || typeof entry !== "object") fail(`manifest file ${name} must be an object`);
        checkArtifactUrl(entry.url, `manifest file ${name}`, normalizedBase);
    }

    const installers = manifest?.shell?.installers;
    if (!installers || typeof installers !== "object" || Array.isArray(installers))
        fail("manifest shell.installers must be an object");
    const installerKeys = Object.keys(installers);
    if (
        installersDir &&
        (installerKeys.length !== SUPPORTED_INSTALLERS.size ||
            installerKeys.some(key => !SUPPORTED_INSTALLERS.has(key)))
    ) {
        fail(`installer directory validation requires exactly: ${[...SUPPORTED_INSTALLERS.keys()].join(", ")}`);
    }
    for (const [key, entry] of Object.entries(installers)) {
        const expected = SUPPORTED_INSTALLERS.get(key);
        if (!expected) fail(`unsupported shell installer key ${JSON.stringify(key)}`);
        if (!entry || typeof entry !== "object") fail(`shell installer ${key} must be an object`);
        if (entry.method !== expected[0] || entry.arch !== expected[1]) {
            fail(`shell installer ${key} must use method ${expected[0]} and arch ${expected[1]}`);
        }
        if (
            typeof entry.assetName !== "string" ||
            !entry.assetName ||
            [".", ".."].includes(entry.assetName) ||
            basename(entry.assetName) !== entry.assetName
        ) {
            fail(`shell installer ${key} must have a bare assetName`);
        }
        if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
            fail(`shell installer ${key} must have a 64-hex sha256`);
        }
        if (!Number.isInteger(entry.size) || entry.size <= 0)
            fail(`shell installer ${key} must have a positive integer size`);
        checkArtifactUrl(entry.url, `shell installer ${key}`, normalizedBase);
        if (installersDir) {
            const installerPath = join(installersDir, entry.assetName);
            file(installerPath, `installer ${key}`);
            if (statSync(installerPath).size !== entry.size) fail(`installer ${key} size does not match manifest`);
            if (sha256Hex(installerPath).toLowerCase() !== entry.sha256.toLowerCase()) {
                fail(`installer ${key} sha256 does not match manifest`);
            }
        }
    }
}

function latestYmlPaths(path) {
    if (!existsSync(path)) fail(`latest yml path does not exist: ${path}`);
    if (statSync(path).isFile()) return [path];
    return readdirSync(path)
        .filter(name => /^latest.*\.ya?ml$/i.test(name))
        .map(name => join(path, name));
}

function checkLatestYml(path, metadata) {
    const paths = latestYmlPaths(path);
    if (!paths.length) fail(`no latest*.yml metadata found in ${path}`);
    for (const yml of paths) {
        const text = readFileSync(yml, "utf-8");
        const match = text.match(/^version:\s*["']?([^\s"']+)["']?\s*$/m);
        if (!match) fail(`could not find version in electron-builder metadata ${yml}`);
        if (match[1] !== metadata.appVersion) {
            fail(
                `electron-builder metadata ${yml} has version ${match[1]}, expected Vesktop app version ${metadata.appVersion}`
            );
        }
    }
}

const options = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
        !option ||
        !value ||
        !["--version-file", "--manifest", "--installers-dir", "--release-base", "--latest-yml"].includes(option)
    ) {
        console.error(usage);
        process.exit(1);
    }
    if (options[option]) fail(`option ${option} was supplied more than once`);
    options[option] = option === "--release-base" ? value : resolve(value);
}

try {
    const metadata = readDockViewReleaseMetadata(ROOT);
    if (options["--version-file"]) checkVersionFile(options["--version-file"], metadata);
    if (options["--manifest"])
        checkManifest(options["--manifest"], metadata, options["--release-base"], options["--installers-dir"]);
    if (options["--latest-yml"]) checkLatestYml(options["--latest-yml"], metadata);
    console.log(
        `✔ DockView release metadata verified (${metadata.tag}; Vesktop ${metadata.appVersion} @ ${metadata.vesktopCommit})`
    );
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
