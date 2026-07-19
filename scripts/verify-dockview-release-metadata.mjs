#!/usr/bin/env node

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

function isRelativeArtifactUrl(value) {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        !/^[a-z][a-z\d+.-]*:/i.test(value) &&
        !value.startsWith("//") &&
        !value.startsWith("/") &&
        !value.split("/").includes("..")
    );
}

function checkArtifactUrl(value, label, releaseBase) {
    if (isRelativeArtifactUrl(value)) return;
    if (typeof value !== "string") fail(`${label} URL must be a string`);
    if (!releaseBase) fail(`${label} URL is absolute; pass --release-base to verify its release root`);
    const base = releaseBase.replace(/\/$/, "");
    if (!value.startsWith(`${base}/`)) fail(`${label} URL must be relative or start with ${base}/, got ${value}`);
}

function checkVersionFile(path, metadata) {
    file(path, "version.txt");
    const value = readFileSync(path, "utf-8").trim();
    const match = value.match(/^dockview:(\S+)\s+\S+\s+\S+$/);
    if (!match) fail(`version.txt must use canonical dockview:<plugin> <vencordRef> <gitHash> form: ${path}`);
    if (match[1] !== metadata.pluginVersion)
        fail(`version.txt plugin version is ${match[1]}, expected ${metadata.pluginVersion}`);
}

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

    for (const [name, entry] of Object.entries(manifest.files)) {
        if (!entry || typeof entry !== "object") fail(`manifest file ${name} must be an object`);
        checkArtifactUrl(entry.url, `manifest file ${name}`, releaseBase);
    }

    const supported = new Map([
        ["win-nsis-all", ["win-nsis", "all"]],
        ["appimage-x64", ["appimage", "x64"]],
        ["appimage-arm64", ["appimage", "arm64"]],
        ["deb-x64", ["deb", "x64"]],
        ["deb-arm64", ["deb", "arm64"]],
        ["rpm-x64", ["rpm", "x64"]],
        ["rpm-arm64", ["rpm", "arm64"]]
    ]);
    const installers = manifest?.shell?.installers;
    if (!installers || typeof installers !== "object" || Array.isArray(installers))
        fail("manifest shell.installers must be an object");
    for (const [key, entry] of Object.entries(installers)) {
        const expected = supported.get(key);
        if (!expected) fail(`unsupported shell installer key ${JSON.stringify(key)}`);
        if (!entry || typeof entry !== "object") fail(`shell installer ${key} must be an object`);
        if (entry.method !== expected[0] || entry.arch !== expected[1]) {
            fail(`shell installer ${key} must use method ${expected[0]} and arch ${expected[1]}`);
        }
        if (typeof entry.assetName !== "string" || !entry.assetName || basename(entry.assetName) !== entry.assetName) {
            fail(`shell installer ${key} must have a bare assetName`);
        }
        checkArtifactUrl(entry.url, `shell installer ${key}`, releaseBase);
        if (installersDir) file(join(installersDir, entry.assetName), `installer ${key}`);
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
