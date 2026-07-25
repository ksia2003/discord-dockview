import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { isExternalWebUrl } from "../plugin/engine/detectType.ts";
import {
    attachBrowserWindow,
    configureBrowserWindow,
    DOCKVIEW_WEB_PARTITION
} from "../plugin/nativeWebview.ts";
import { DOCKVIEW_OUTPUT_FILES, VENCORD_OUTPUT_FILES } from "../scripts/lib/vencordOutputs.mjs";
import { DOCKVIEW_RUNTIME_FILES, VENCORD_CORE_FILES } from "../src/shared/dockviewBundleFiles.ts";

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

test("official Vencord and DockView runtime contracts are exact and disjoint", () => {
    assert.deepEqual([...VENCORD_CORE_FILES], [...VENCORD_OUTPUT_FILES]);
    assert.deepEqual([...DOCKVIEW_RUNTIME_FILES], [...DOCKVIEW_OUTPUT_FILES]);
    assert.deepEqual(VENCORD_OUTPUT_FILES.filter(file => DOCKVIEW_OUTPUT_FILES.includes(file)), []);
    assert.ok(DOCKVIEW_OUTPUT_FILES.includes("dockviewRenderer.js"));
    assert.ok(DOCKVIEW_OUTPUT_FILES.includes("dockviewMain.js"));
    assert.equal(DOCKVIEW_OUTPUT_FILES.some(file => file.startsWith("vencordDesktop")), false);
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
    assert.match(plugin, /props\?\.itemHref/);
    assert.match(plugin, /"message": addOpenInDockViewItem/);
    assert.match(plugin, /"image-context": addOpenInDockViewItem/);
    assert.match(plugin, /id: "dockview-open-web-link"/);
    assert.match(plugin, /isExternalWebUrl\(url\.href\)/);
    assert.match(strings, /openInDockView: "Open in DockView"/);
    assert.doesNotMatch(plugin, /installWebOpenListener|WEB_TAB_OPEN|REMOTE_PANEL_OPEN/);
    assert.equal(isExternalWebUrl("https://example.com/page.html"), true);
    assert.equal(isExternalWebUrl("https://cdn.discordapp.com/file/page.html"), false);
});

test("the native member list gains dock-scoped responsive columns", () => {
    const css = source("plugin/style.css");
    const layout = source("plugin/host/layout.ts");

    assert.match(layout, /export const MIN_WIDTH = 560;/);
    assert.match(layout, /export const DEFAULT_WIDTH = MIN_WIDTH;/);
    assert.match(layout, /export const DOCK_MIN_WIDTH = MIN_WIDTH;/);
    assert.match(
        css,
        /\.dockview-context-native\s*\{[^}]*container:\s*dockview-members\s*\/\s*inline-size;/s
    );
    assert.match(
        css,
        /@container dockview-members \(min-width: 520px\)\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/
    );
    assert.match(
        css,
        /@container dockview-members \(min-width: 800px\)\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/
    );
    assert.match(
        css,
        /> \[class\*="content_"\]:has\(> \[class\*="membersGroup"\]\)[\s\S]*?> \[class\*="member_"\]\s*\{[^}]*width:\s*auto !important;[^}]*min-width:\s*0;[^}]*max-width:\s*none !important;/
    );
    assert.match(
        css,
        /> :not\(\[class\*="member_"\]\)\s*\{[^}]*grid-column:\s*1 \/ -1;/s
    );
});

test("guild Channel and voice Chat are permanent dock surfaces", () => {
    const plugin = source("plugin/index.tsx");
    const standalone = source("plugin/standalone.ts");
    const tabs = source("plugin/ui/DockTabs.tsx");
    const contextBody = source("plugin/ui/ContextTabBody.tsx");
    const overview = source("plugin/ui/ChannelOverview.tsx");
    const interception = source("plugin/host/interception.ts");
    const capture = source("plugin/host/voiceChatCapture.ts");
    const portal = source("plugin/viewers/voice/voiceChatPortal.ts");
    const css = source("plugin/style.css");

    // Guild identity/topic moves to CHANNEL while only the native header's topic +
    // member toggle are filtered.
    assert.match(plugin, /filterChannelHeaderToolbar/);
    assert.match(plugin, /filterChannelHeaderSubtitle/);
    assert.match(standalone, /plugin\.filterChannelHeaderToolbar\(toolbar, channel\)/);
    assert.match(standalone, /plugin\.filterChannelHeaderSubtitle\(subtitle, channel\)/);
    assert.match(standalone, /plugin\.renderDockRail\(channelView\)/);
    assert.match(contextBody, /ChannelOverview/);
    assert.match(contextBody, /dockview-context-slot/);
    assert.match(overview, /Parser\.parseTopic/);
    assert.match(overview, /updateChannelOverrideSettings/);
    assert.match(overview, /openNativeChannelMenu/);

    // Regular guild voice owns an additional fixed, non-draggable CHAT tab.
    assert.match(tabs, /channel\.type === 2/);
    assert.match(tabs, /voiceChatTabElement/);
    assert.match(tabs, /setContextView\(channelId, "voice-chat"\)/);
    assert.match(interception, /CHANNEL_RTC_UPDATE_CHAT_OPEN/);
    assert.match(interception, /focusVoiceChatTab/);

    // Capture only the inner message/composer component, not the call view, then keep one
    // isolated portal per voice channel so drafts and scroll survive tab switches.
    assert.match(capture, /keysAre\(Object\.keys\(props\), \["channel", "guild", "chatInputType"\]\)/);
    assert.match(capture, /dockview-prime-voice-chat/);
    assert.match(portal, /const portals = new Map<string, Portal>\(\)/);
    assert.match(portal, /createRoot\(node\)/);
    assert.match(css, /html\.dockview-prime-voice-chat/);
    assert.match(css, /\.dockview-voice-chat-portal\s*\{/);
});

test("tab headers reclaim the outer left inset without crowding tab contents", () => {
    const css = source("plugin/style.css");

    assert.match(
        css,
        /\.dockview-header\s*\{[^}]*padding-left:\s*0;/s
    );
    assert.match(
        css,
        /\.dockview-header\.dockview-header--tworow \.dockview-header-upper\s*\{[^}]*padding:\s*8px 8px 8px 0;/s
    );
    assert.match(
        css,
        /\.dockview-tab\s*\{[^}]*padding:\s*0 6px 0 10px;/s
    );
});

test("the Vesktop overlay is restricted to the documented DockView seams", () => {
    const allowed = new Set([
        "src/main/dockviewWebview.ts",
        "src/main/dockviewFilesDir.ts",
        "src/main/dockviewRuntime.ts",
        "src/main/ipc.ts",
        "src/main/mainWindow.ts",
        "src/main/shellUpdate.ts",
        "src/main/utils/dockviewLoader.ts",
        "src/main/utils/vencordInstallMode.ts",
        "src/main/utils/vencordLoader.ts",
        "src/main/utils/vencordUpdateCheck.ts",
        "src/main/vencordFilesDir.ts",
        "src/main/vencordUpdaterBridge.ts",
        "src/preload/VesktopNative.ts",
        "src/preload/index.ts",
        "src/shared/dockviewBundleFiles.ts",
        "src/shared/dockviewRuntimeAbi.ts",
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
    assert.match(shellUpdate, /spawn\(setupExe, \["--updated", "\/S", "--force-run"\]/);
    assert.match(shellUpdate, /child\.once\("spawn", resolve\)/);
    assert.match(shellUpdate, /child\.once\("error", reject\)/);
});

test("web tabs use one isolated partition and a fail-closed main-process boundary", () => {
    const boundary = source("plugin/nativeWebview.ts");
    const legacyBoundary = source("src/main/dockviewWebview.ts");
    const viewer = source("plugin/viewers/web/WebBody.tsx");
    const runtimeLoader = source("src/main/dockviewRuntime.ts");

    assert.match(boundary, /persist:dockview-web/);
    assert.match(boundary, /setPermissionCheckHandler\(\(\) => false\)/);
    assert.match(boundary, /setPermissionRequestHandler\([^\n]+callback\(false\)/);
    assert.match(boundary, /params\.partition !== DOCKVIEW_WEB_PARTITION/);
    assert.match(boundary, /webPreferences\.nodeIntegration = false/);
    assert.match(boundary, /webPreferences\.contextIsolation = true/);
    assert.match(boundary, /webPreferences\.sandbox = true/);
    assert.match(legacyBoundary, /persist:dockview-web/);
    assert.match(runtimeLoader, /installDockViewWebviewSecurity\(win\)/);
    assert.match(viewer, /partition: WEB_PARTITION/);
    assert.doesNotMatch(viewer, /preload\s*:/);
});

test("runtime webview policy configures and rejects guests without trusting the renderer", () => {
    const options = { webPreferences: {} };
    configureBrowserWindow(options);
    assert.equal(options.webPreferences.webviewTag, true);

    const windowListeners = {};
    const sessionListeners = {};
    let permissionCheck;
    let permissionRequest;
    const external = [];
    attachBrowserWindow(
        {
            webContents: {
                on(event, listener) {
                    windowListeners[event] = listener;
                }
            }
        },
        {
            fromPartition(partition) {
                assert.equal(partition, DOCKVIEW_WEB_PARTITION);
                return {
                    setPermissionCheckHandler(handler) {
                        permissionCheck = handler;
                    },
                    setPermissionRequestHandler(handler) {
                        permissionRequest = handler;
                    },
                    on(event, listener) {
                        sessionListeners[event] = listener;
                    }
                };
            },
            openExternal(url) {
                external.push(url);
            }
        }
    );

    assert.equal(permissionCheck(), false);
    let allowed = true;
    permissionRequest(null, "media", value => {
        allowed = value;
    });
    assert.equal(allowed, false);

    let rejected = false;
    windowListeners["will-attach-webview"](
        { preventDefault: () => { rejected = true; } },
        {},
        { partition: "persist:other", src: "https://example.com" }
    );
    assert.equal(rejected, true);

    const preferences = { preload: "bad", nodeIntegration: true };
    const params = {
        partition: DOCKVIEW_WEB_PARTITION,
        src: "https://example.com",
        preload: "bad",
        nodeintegration: true
    };
    windowListeners["will-attach-webview"]({ preventDefault() {} }, preferences, params);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.sandbox, true);
    assert.equal("preload" in preferences, false);
    assert.equal("preload" in params, false);

    let cancelled = false;
    let downloadPrevented = false;
    sessionListeners["will-download"](
        { preventDefault: () => { downloadPrevented = true; } },
        { getURL: () => "https://example.com/file", cancel: () => { cancelled = true; } }
    );
    assert.equal(cancelled, true);
    assert.equal(downloadPrevented, true);
    assert.deepEqual(external, ["https://example.com/file"]);
});

test("native DockView file operations do not accept a renderer-controlled directory", () => {
    const native = source("plugin/native.ts");
    assert.match(native, /const INSTALL_DIR = __dirname/);
    assert.doesNotMatch(native, /targetDir/);
    assert.match(native, /isAllowedInstallFile/);
    assert.match(native, /const REQUIRED_UPDATE_FILES = new Set/);
    assert.match(native, /"dockviewMain\.js"/);
    assert.match(native, /"dockviewRenderer\.js"/);
    assert.doesNotMatch(native, /"vencordDesktopMain\.js"/);
    assert.doesNotMatch(native, /"vencordDesktopRenderer\.js"/);
    assert.match(native, /approval\.manifestJson !== JSON\.stringify\(manifest\)/);
    assert.match(native, /owner !== RELEASE_OWNER \|\| repo !== RELEASE_REPO/);
    assert.doesNotMatch(native, /export async function fetchManifest/);
});

test("DockView is built and loaded independently of official Vencord", () => {
    const prepare = source("scripts/prepare-vencord.mjs");
    const preload = source("src/preload/index.ts");
    const ipc = source("src/main/ipc.ts");
    const events = source("src/shared/IpcEvents.ts");
    const native = source("plugin/native.ts");
    const nativeBridge = source("plugin/nativeBridge.ts");
    const runtime = source("src/main/dockviewRuntime.ts");
    const preloadNative = source("src/preload/VesktopNative.ts");
    const mainWindow = source("src/main/mainWindow.ts");
    const vencordInstallMode = source("src/main/utils/vencordInstallMode.ts");
    const vencordLoader = source("src/main/utils/vencordLoader.ts");
    const vencordUpdateCheck = source("src/main/utils/vencordUpdateCheck.ts");
    const vencordUpdaterBridge = source("src/main/vencordUpdaterBridge.ts");
    const dockviewLoader = source("src/main/utils/dockviewLoader.ts");
    const vencordMain = source("static/vencordDist/vencordDesktopMain.js");

    assert.doesNotMatch(prepare, /src["', ]+userplugins/);
    assert.doesNotMatch(prepare, /patch-vencord-build/);
    assert.match(prepare, /static", "dockviewDist/);
    assert.match(prepare, /\["buildStandalone"\]/);
    assert.ok(preload.indexOf("GET_VENCORD_RENDERER_SCRIPT") < preload.indexOf("GET_DOCKVIEW_RENDERER_SCRIPT"));
    assert.match(ipc, /handle\(IpcEvents\.DOCKVIEW_INVOKE/);
    assert.doesNotMatch(ipc, /DOCKVIEW_READ_CHUNK|DOCKVIEW_CONVERT_ATTACHMENT|DOCKVIEW_APPLY_UPDATE/);
    assert.match(events, /DOCKVIEW_INVOKE = "DV_INVOKE"/);
    assert.doesNotMatch(events, /DOCKVIEW_READ_CHUNK|DOCKVIEW_CONVERT_ATTACHMENT|DOCKVIEW_APPLY_UPDATE/);
    assert.match(preloadNative, /invoke: invokeDockview/);
    assert.match(nativeBridge, /typeof bridge\.invoke === "function"/);
    assert.match(native, /export function invoke\(/);
    assert.match(native, /const NATIVE_METHODS/);
    assert.match(native, /DOCKVIEW_RUNTIME_ABI_VERSION/);
    assert.match(runtime, /const LEGACY_METHODS/);
    assert.match(runtime, /Unsupported DockView runtime ABI/);
    assert.match(runtime, /readDockviewRendererScript/);
    assert.match(vencordLoader, /Bundled official Vencord/);
    assert.match(vencordLoader, /any non-empty stamp identifies the combined runtime/);
    assert.match(vencordLoader, /repos\/Vendicated\/Vencord\/releases\/latest/);
    assert.doesNotMatch(vencordLoader, /dockviewDist/);
    assert.match(vencordInstallMode, /return !state\.customDir \|\| !state\.customGitCheckout/);
    assert.match(vencordLoader, /Bundled Vencord is not a standalone build/);
    assert.match(vencordLoader, /VENCORD_FILES_DIR_IS_CUSTOM/);
    assert.match(vencordLoader, /shouldInstallBundledVencord/);
    assert.match(mainWindow, /runVencordMain\(\);\s*await installVencordUpdaterBridge\(\);/);
    assert.match(vencordUpdaterBridge, /VencordGetUpdates/);
    assert.doesNotMatch(vencordUpdaterBridge, /"VencordUpdate"|"VencordBuild"/);
    assert.match(vencordUpdaterBridge, /if \(!\(await isStandaloneVencordInstall\(VENCORD_FILES_DIR\)\)\) return;/);
    assert.match(vencordUpdateCheck, /readInstalledVencordHash\(installDir\)/);
    assert.match(vencordUpdateCheck, /VENCORD_CORE_FILES\.filter/);
    assert.doesNotMatch(vencordUpdateCheck, /DOCKVIEW_FILES_DIR|DOCKVIEW_RUNTIME_FILES/);
    assert.match(dockviewLoader, /dockviewDist/);
    assert.doesNotMatch(dockviewLoader, /VENCORD_FILES_DIR/);
    assert.match(vencordMain, /Standalone: true/);
    assert.match(vencordMain, /Updater Disabled: false/);
});
