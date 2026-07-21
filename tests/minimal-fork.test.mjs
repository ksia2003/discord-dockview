import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { isExternalWebUrl } from "../plugin/engine/detectType.ts";
import { VENCORD_OUTPUT_FILES } from "../scripts/lib/vencordOutputs.mjs";
import { DOCKVIEW_VENCORD_BUNDLE_FILES } from "../src/shared/dockviewBundleFiles.ts";

const ROOT = process.cwd();
const UPSTREAM_VESKTOP_COMMIT = "f054ca2f0312e31d8d620bb5f5b1766d9e6ee4f0";

function source(path) {
    return readFileSync(join(ROOT, path), "utf-8");
}

function walk(directory) {
    const result = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) result.push(...walk(path));
        else if (entry.isFile()) result.push(path);
    }
    return result;
}

test("runtime bundle validation exactly matches the plugin build output contract", () => {
    assert.deepEqual([...DOCKVIEW_VENCORD_BUNDLE_FILES], [...VENCORD_OUTPUT_FILES]);
});

test("ordinary link clicks stay upstream while right-click offers Open in DockView", () => {
    const plugin = source("plugin/index.tsx");
    const strings = source("plugin/strings.ts");
    const externalLinks = source("src/main/utils/makeLinksOpenExternally.ts");
    const upstreamExternalLinks = execFileSync(
        "git",
        ["show", `${UPSTREAM_VESKTOP_COMMIT}:src/main/utils/makeLinksOpenExternally.ts`],
        { cwd: ROOT, encoding: "utf-8" }
    );

    assert.equal(externalLinks, upstreamExternalLinks);
    assert.match(plugin, /"image-context": addOpenInDockViewItem/);
    assert.match(plugin, /id: "dockview-open-web-link"/);
    assert.match(plugin, /isExternalWebUrl\(url\.href\)/);
    assert.match(strings, /openInDockView: "Open in DockView"/);
    assert.doesNotMatch(plugin, /installWebOpenListener|WEB_TAB_OPEN|REMOTE_PANEL_OPEN/);
    assert.equal(isExternalWebUrl("https://example.com/page.html"), true);
    assert.equal(isExternalWebUrl("https://cdn.discordapp.com/file/page.html"), false);
});

test("the Vesktop overlay is restricted to the documented DockView seams", () => {
    const allowed = new Set([
        "src/main/dockviewWebview.ts",
        "src/main/ipc.ts",
        "src/main/mainWindow.ts",
        "src/main/shellUpdate.ts",
        "src/main/utils/vencordLoader.ts",
        "src/preload/VesktopNative.ts",
        "src/shared/dockviewBundleFiles.ts",
        "src/shared/IpcEvents.ts",
        "src/shared/dockviewRelease.ts",
        "src/shared/dockviewVersion.ts"
    ]);
    const changed = execFileSync(
        "git",
        ["diff", "--name-only", UPSTREAM_VESKTOP_COMMIT, "--", "src"],
        { cwd: ROOT, encoding: "utf-8" }
    )
        .trim()
        .split("\n")
        .filter(Boolean);

    assert.deepEqual(changed.filter(path => !allowed.has(path)), []);
});

test("removed global behavior modules and settings do not return", () => {
    const forbiddenFiles = [
        "plugin/domOptimizer.ts",
        "plugin/invidiousEmbeds.ts",
        "plugin/latex.ts",
        "plugin/messageEncryption.ts",
        "plugin/native-crypto.ts",
        "plugin/native-profiles.ts",
        "plugin/native-secrets.ts",
        "plugin/networkPrivacy.ts",
        "plugin/noiseSuppression.ts",
        "plugin/engine/chunks/rnnoise.entry.ts",
        "plugin/ui/ProfilesPanel.tsx"
    ];
    for (const path of forbiddenFiles) assert.equal(existsSync(join(ROOT, path)), false, path);

    const text = walk(join(ROOT, "plugin"))
        .filter(path => /\.(?:ts|tsx)$/.test(path))
        .map(path => `\n${relative(ROOT, path)}\n${readFileSync(path, "utf-8")}`)
        .join("\n");
    for (const needle of [
        "firewallEnabled",
        "proxyUrl",
        "encryptionEnabled",
        "installWebOpenListener",
        "@timephy/rnnoise-wasm"
    ]) {
        assert.equal(text.includes(needle), false, needle);
    }
});

test("the temporary app updater is release-bound and leaves upstream updater code intact", () => {
    const shellUpdate = source("src/main/shellUpdate.ts");
    const updater = source("src/main/updater.ts");
    const upstreamUpdater = execFileSync("git", ["show", `${UPSTREAM_VESKTOP_COMMIT}:src/main/updater.ts`], {
        cwd: ROOT,
        encoding: "utf-8"
    });

    assert.equal(updater, upstreamUpdater);
    assert.match(shellUpdate, /DOCKVIEW_RELEASE_REPOSITORY/);
    assert.match(shellUpdate, /Update source is not an official DockView release/);
    assert.match(shellUpdate, /installerUrl\.href\.startsWith\(releaseBase\.href\)/);
});

test("web tabs use one isolated partition and a fail-closed main-process boundary", () => {
    const boundary = source("src/main/dockviewWebview.ts");
    const viewer = source("plugin/viewers/web/WebBody.tsx");

    assert.match(boundary, /persist:dockview-web/);
    assert.match(boundary, /setPermissionCheckHandler\(\(\) => false\)/);
    assert.match(boundary, /setPermissionRequestHandler\([^\n]+callback\(false\)/);
    assert.match(boundary, /params\.partition !== DOCKVIEW_WEB_PARTITION/);
    assert.match(boundary, /webPreferences\.nodeIntegration = false/);
    assert.match(boundary, /webPreferences\.contextIsolation = true/);
    assert.match(boundary, /webPreferences\.sandbox = true/);
    assert.match(viewer, /partition: WEB_PARTITION/);
    assert.doesNotMatch(viewer, /preload\s*:/);
});

test("native DockView file operations do not accept a renderer-controlled directory", () => {
    const native = source("plugin/native.ts");
    assert.match(native, /const INSTALL_DIR = __dirname/);
    assert.doesNotMatch(native, /targetDir/);
    assert.match(native, /isAllowedInstallFile/);
    assert.match(native, /const REQUIRED_UPDATE_FILES = new Set/);
    assert.match(native, /approval\.manifestJson !== JSON\.stringify\(manifest\)/);
    assert.match(native, /owner !== RELEASE_OWNER \|\| repo !== RELEASE_REPO/);
    assert.doesNotMatch(native, /export async function fetchManifest/);
});
