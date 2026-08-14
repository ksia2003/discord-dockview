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

test("F9 cycles an editable ordered preset list plus fixed hidden state", () => {
    const plugin = source("plugin/index.tsx");
    const layout = source("plugin/host/layout.ts");
    const mount = source("plugin/host/mount.ts");
    const hostBridge = source("plugin/engine/hostBridge.ts");
    const load = source("plugin/engine/load.ts");
    const threadTab = source("plugin/engine/threadTab.ts");
    const channelMemory = source("plugin/engine/channelMemory.ts");
    const settings = source("plugin/settings.ts");
    const general = source("plugin/ui/GeneralPanel.tsx");
    const panel = source("plugin/ui/DockPanel.tsx");
    const css = source("plugin/style.css");
    const strings = source("plugin/strings.ts");

    assert.match(layout, /export const COMPACT_WIDTH_FALLBACK = 264;/);
    assert.match(layout, /COMPACT_WIDTH_PROPERTY = "--custom-member-list-width"/);
    assert.match(layout, /export function getCompactDockWidth\(\)/);
    assert.match(layout, /getPropertyValue\(COMPACT_WIDTH_PROPERTY\)/);
    assert.match(layout, /export const DEFAULT_EXPANDED_WIDTH = 560;/);
    assert.match(layout, /export function setDockWidthPresets\(/);
    assert.match(layout, /export function selectDockWidthPreset\(/);
    assert.match(layout, /let dockPresets = \[COMPACT_WIDTH_FALLBACK, DEFAULT_EXPANDED_WIDTH\]/);
    assert.match(layout, /activePresetIndex/);
    assert.match(layout, /classList\.toggle\("dockview-host--compact", isCompactDockWidth\(\)\)/);
    assert.doesNotMatch(panel, /onResizeStart|dockview-resize|clampDockDrag/);
    assert.doesNotMatch(css, /dockview-resize|dockview-drag-overlay/);
    assert.match(plugin, /e\.key !== "F9" && e\.code !== "F9"/);
    assert.match(plugin, /getActiveDockPresetIndex\(\) \+ 1/);
    assert.match(plugin, /selectDockWidthPreset\(0\)/);
    assert.match(plugin, /toggleDockTemporaryVisibility\(\)/);
    assert.match(
        plugin,
        /applyHostWidth\(\);\s*syncVisibleChatPortalsNow\(\);\s*commitF9MemberColumnsBeforePaint\(\)/
    );
    assert.match(plugin, /window\.addEventListener\("keydown", onKeyDown\)/);
    assert.match(plugin, /window\.removeEventListener\("keydown", onKeyDown\)/);
    assert.match(
        plugin,
        /onResize = \(\) => \{\s*applyHostWidth\(\);\s*syncVisibleChatPortalsNow\(\);\s*\}/
    );
    assert.match(strings, /widthTitle: "F9 dock width presets"/);
    assert.match(settings, /dockWidthPresets:\s*\{[^}]*default: "264,560"/s);
    assert.match(general, /WidthPresetEditor/);
    assert.match(general, /addPreset/);
    assert.match(general, /move\(index, -1\)/);
    assert.match(general, /remove\(index\)/);
    assert.match(mount, /let temporarilyHidden = false;/);
    assert.match(mount, /export function toggleDockTemporaryVisibility\(\)/);
    assert.match(mount, /classList\.toggle\("dockview-open", visible\)/);
    assert.match(hostBridge, /revealDock\(\): void;/);
    assert.match(load, /host\.revealDock\(\)/);
    assert.match(threadTab, /if \(takesOverView\) host\.revealDock\(\)/);
    assert.doesNotMatch(channelMemory, /revealDock/);
    assert.match(
        css,
        /\[data-dockview-temporarily-hidden="true"\]\s*\{[^}]*visibility:\s*hidden !important;[^}]*pointer-events:\s*none !important;/s
    );
    assert.doesNotMatch(css, /html:not\(\.dockview-open\) \.dockview-(?:thread|voice-chat)-portal/);
});

test("the native member list stays fluid without breaking its one-column virtualizer", () => {
    const css = source("plugin/style.css");
    const layout = source("plugin/host/layout.ts");
    const nativePanels = source("plugin/host/nativePanels.ts");
    const panel = source("plugin/ui/DockPanel.tsx");

    assert.match(layout, /const dockMinWidth = MIN_DOCK_WIDTH/);
    assert.match(panel, /const nativeRailContextActive = contextView === "channel" \|\| contextView === "search"/);
    assert.match(panel, /nativeRailContextActive \? " dockview-body--context" : ""/);
    assert.match(
        css,
        /\.dockview-body--context\s*\{[^}]*overflow:\s*hidden;[^}]*scrollbar-gutter:\s*auto;/s
    );
    assert.match(css, /\.dockview-context-native\s*\{[^}]*width:\s*100% !important;/s);
    assert.match(css, /\.dockview-context-native\[class\*="membersWrap"\]/);
    assert.match(
        css,
        /\.dockview-card\s*\{[^}]*flex:\s*1 1 0 !important;[^}]*width:\s*auto !important;[^}]*max-width:\s*100% !important;/s
    );
    assert.doesNotMatch(css, /@container dockview-members/);
    assert.doesNotMatch(css, /:has\(>\s*\[class\*="member_"\]\)/);
    assert.match(css, /A future multi-column directory\s*\n?\s*\*?\s*must own a column-aware virtualizer/);
    assert.match(nativePanels, /function exclusiveLayoutRoot\(/);
    assert.match(nativePanels, /parent\.children\.length !== 1/);
    assert.match(nativePanels, /mark\(el, true\)/);
    assert.match(
        nativePanels,
        /inner\.querySelectorAll<HTMLElement>\('div\[class\*="chatLayerWrapper"\]'\)[\s\S]*?\.forEach\(el => mark\(el, true\)\)/
    );
});

test("compact viewer controls wrap instead of escaping past the required More menu", () => {
    const css = source("plugin/style.css");

    assert.match(css, /\.dockview-viewer-toolbar\s*\{[^}]*flex-wrap:\s*wrap;/s);
    assert.match(css, /\.dockview-viewer-toolbar \.dockview-file-more\s*\{[^}]*margin-left:\s*auto;/s);
    assert.match(css, /\.dockview-tool-group\s*\{[^}]*flex:\s*0 0 auto;/s);
});

test("a newly focused screen-share viewer hides once and never auto-restores", () => {
    const screenShare = source("plugin/host/screenShareAutoHide.ts");
    const mount = source("plugin/host/mount.ts");
    const plugin = source("plugin/index.tsx");

    assert.match(screenShare, /ChannelRTCStore\?\.getSelectedParticipant\?\.\(channelId\)/);
    assert.match(screenShare, /if \(!participant\?\.stream\) return null/);
    assert.match(screenShare, /if \(next && next !== lastStreamSelection\) hideDockTemporarily\(\)/);
    assert.match(screenShare, /lastStreamSelection = next/);
    assert.doesNotMatch(screenShare, /revealDock|toggleDockTemporaryVisibility/);
    assert.match(mount, /export function hideDockTemporarily\(\)/);
    assert.match(plugin, /startScreenShareAutoHide\(\)/);
    assert.match(plugin, /stopScreenShareAutoHide\(\)/);
    assert.match(plugin, /CHANNEL_SELECT[\s\S]*reconcileScreenShareSelection\(\)/);
});

test("queued root retirement cannot unmount a re-adopted DockPanel", () => {
    const mount = source("plugin/host/mount.ts");

    assert.match(mount, /const rootRetirements = new WeakMap<Root, object>\(\)/);
    assert.match(mount, /rootRetirements\.delete\(resident\)/);
    assert.match(mount, /const retirement = \{\};\s*rootRetirements\.set\(stale, retirement\)/);
    assert.match(mount, /if \(rootRetirements\.get\(stale\) !== retirement\) return/);
    assert.match(mount, /resident\.render\(React\.createElement\(DockPanel\)\)/);
    assert.match(mount, /resident root was dead/);
    assert.match(mount, /rootRetirements\.delete\(r\)/);
});

test("an active thread portal is bound before its tab can paint blank", () => {
    const threadBody = source("plugin/viewers/thread/ThreadBody.tsx");
    const portal = source("plugin/viewers/thread/threadPortal.ts");
    const voicePortal = source("plugin/viewers/voice/voiceChatPortal.ts");
    const scrollAnchor = source("plugin/viewers/chatScrollAnchor.ts");
    const plugin = source("plugin/index.tsx");
    const tabs = source("plugin/engine/tabs.ts");
    const load = source("plugin/engine/load.ts");
    const search = source("plugin/host/searchResults.ts");

    assert.match(threadBody, /const \{ useLayoutEffect \} = React/);
    assert.match(threadBody, /useLayoutEffect\(\(\) => \{/);
    assert.match(threadBody, /claim = showThreadPortal\(threadId\)/);
    assert.match(threadBody, /releaseThreadPortals\(claim\)/);
    assert.doesNotMatch(threadBody, /const \{ useEffect \} = React/);
    assert.match(tabs, /selectPortalForWindow\(getActiveWindow\(\)\)/);
    assert.match(load, /selectThreadPortal\(null\);\s*showContent/);
    assert.match(search, /searchRegistry\.activate\(scopeId\);\s*selectThreadPortal\(null\)/);
    assert.match(portal, /export function syncVisibleThreadPortalNow\(\): void/);
    assert.match(portal, /new ResizeObserver\(scheduleObservedSync\)/);
    assert.doesNotMatch(portal, /function syncLoop\(/);
    assert.match(portal, /if \(!p\.rendered\) \{\s*p\.rendered = renderPortal\(p\)/);
    assert.match(portal, /function scheduleInitialRender\(p: Portal\): void/);
    assert.match(voicePortal, /export function syncVisibleVoiceChatPortalNow\(\): void/);
    assert.match(voicePortal, /new ResizeObserver\(scheduleObservedSync\)/);
    assert.doesNotMatch(voicePortal, /function syncLoop\(/);
    assert.match(voicePortal, /if \(!portal\.rendered\) \{\s*portal\.rendered = renderPortal\(portal\)/);
    assert.match(voicePortal, /createInitialRenderRetry/);
    assert.match(voicePortal, /renderRetry: InitialRenderRetryController \| null/);
    assert.match(voicePortal, /subscribeVoiceChatReadiness/);
    assert.match(voicePortal, /if \(!portal \|\| portal\.rendered\) return/);
    assert.match(voicePortal, /cancelInitialRender\(portal\)/);
    assert.match(scrollAnchor, /startsWith\("chat-messages___chat-messages-"\)/);
    assert.match(scrollAnchor, /restoreChatScrollAnchorAcrossFrames/);
    assert.match(
        plugin,
        /function syncVisibleChatPortalsNow\(\): void \{\s*syncVisibleThreadPortalNow\(\);\s*syncVisibleVoiceChatPortalNow\(\);\s*\}/
    );
});

test("Dock images reuse a live Discord source menu and fall back honestly", () => {
    const embed = source("plugin/embed.ts");
    const load = source("plugin/engine/load.ts");
    const image = source("plugin/viewers/image/ImageBody.tsx");
    const fallback = source("plugin/viewers/image/ImageContextMenu.tsx");

    assert.match(embed, /sourceImageContextFromTarget/);
    assert.match(embed, /new WeakRef\(source\)/);
    assert.match(embed, /new MouseEvent\("contextmenu"/);
    assert.match(embed, /if \(!live\?\.isConnected\) return false/);
    assert.match(load, /win\.sourceImageContext = opts\.sourceImageContext/);
    assert.match(image, /win\.sourceImageContext\?\.\(\{/);
    assert.match(fallback, /STRINGS\.menu\.copyImage/);
    assert.match(fallback, /STRINGS\.menu\.saveImage/);
    assert.doesNotMatch(fallback, /openInBrowser|copyLink/);
});

test("sandboxed document links keep browser click behavior and one explicit context menu", () => {
    const bridge = source("plugin/engine/iframeLinkBridge.ts");
    const nonce = source("plugin/engine/nonce.ts");
    const plugin = source("plugin/index.tsx");

    assert.match(bridge, /__dockViewOpenLink/);
    assert.match(bridge, /__dockViewLinkContext/);
    assert.match(bridge, /document\.addEventListener\("contextmenu"/);
    assert.match(nonce, /ensureIframeLinkBridge\(html\)/);
    assert.match(plugin, /id: "dockview-link-open-browser"/);
    assert.match(plugin, /id: "dockview-link-open-dock"/);
    assert.match(plugin, /id: "dockview-link-copy"/);
    assert.match(plugin, /normalizeIframeLink\(d\.__dockViewOpenLink(?:,\s*frame)?\)/);
});

test("a failed provisional file is removed even after the user leaves its tab", () => {
    const rollback = source("plugin/engine/openRollback.ts");
    const panel = source("plugin/ui/DockPanel.tsx");

    assert.match(rollback, /for \(const win of \[\.\.\.allLiveWindows\(\)\]\)/);
    assert.match(rollback, /if \(!isCurrentActive\) \{[\s\S]*removeWindowEverywhere\(win\)/);
    assert.match(rollback, /win\.ownerChannelId === getWindowChannelId\(\)/);
    assert.match(panel, /useLayoutEffect\(\(\) => \{[\s\S]*settlePendingOpens\(\);[\s\S]*\}\)/);
});

test("guild Channel and voice Chat are permanent dock surfaces", () => {
    const plugin = source("plugin/index.tsx");
    const standalone = source("plugin/standalone.ts");
    const tabs = source("plugin/ui/DockTabs.tsx");
    const contextBody = source("plugin/ui/ContextTabBody.tsx");
    const overview = source("plugin/ui/ChannelOverview.tsx");
    const searchResults = source("plugin/host/searchResults.ts");
    const searchBody = source("plugin/ui/SearchResultsBody.tsx");
    const interception = source("plugin/host/interception.ts");
    const capture = source("plugin/host/voiceChatCapture.ts");
    const portal = source("plugin/viewers/voice/voiceChatPortal.ts");
    const hostMount = source("plugin/host/mount.ts");
    const css = source("plugin/style.css");

    // Guild identity/topic moves to CHANNEL while only the native header's topic +
    // member toggle are filtered.
    assert.match(plugin, /filterChannelHeaderToolbar/);
    assert.match(plugin, /filterChannelHeaderSubtitle/);
    assert.match(standalone, /plugin\.filterChannelHeaderToolbar\(toolbar, channel\)/);
    assert.match(standalone, /plugin\.filterChannelHeaderSubtitle\(subtitle, channel\)/);
    assert.match(standalone, /plugin\.openThreadFromBrowser\(channel\)/);
    assert.match(standalone, /plugin\.renderDockRail\(channelView\)/);
    assert.match(standalone, /plugin\.captureUnifiedChannelHeader\(header, channelView\)/);
    assert.match(plugin, /captureUnifiedChannelHeader\(header, channelView\)/);
    assert.match(plugin, /find: "Thread Browser Empty State"/);
    assert.match(plugin, /\$self\.openThreadFromBrowser\(\$1\)/);
    assert.match(plugin, /openThreadTab\(threadId, parentId\)/);
    assert.match(source("plugin/host/unifiedHeader.tsx"), /channel\.type === 0/);
    assert.match(source("plugin/host/unifiedHeader.tsx"), /export function usesUnifiedChannelHeader/);
    assert.match(source("plugin/host/unifiedHeader.tsx"), /export function hasUnifiedChannelHeader/);
    assert.match(source("plugin/ui/DockPanel.tsx"), /unifiedHeader\s*\? null\s*:\s*React\.createElement/s);
    assert.match(source("plugin/ui/DockTabs.tsx"), /useLayoutEffect\(revealActive, \[revealActive, fileActiveId, tabIds\]\)/);
    assert.match(source("plugin/host/unifiedHeader.tsx"), /railSeen\.has\(instance\)/);
    assert.match(source("plugin/host/unifiedHeader.tsx"), /setUnifiedHeaderActive/);
    assert.match(source("plugin/host/unifiedHeader.tsx"), /nativeTitle/);
    assert.match(source("plugin/host/unifiedHeader.tsx"), /nativeToolbar/);
    assert.match(source("plugin/host/unifiedHeader.tsx"), /NativeSearchToolbarSeed/);
    assert.match(source("plugin/host/unifiedHeader.tsx"), /ReactDOM\.createPortal\(toolbar, target\)/);
    assert.match(source("plugin/host/unifiedHeader.tsx"), /bindUnifiedChannelToolbarTarget/);
    assert.match(hostMount, /setUnifiedHeaderActive\(true\)/);
    assert.match(hostMount, /setUnifiedHeaderActive\(false\)/);
    assert.match(contextBody, /ChannelOverview/);
    assert.match(contextBody, /dockview-context-slot/);
    assert.match(overview, /Parser\.parseTopic/);
    assert.match(overview, /findCssClasses/);
    assert.match(overview, /Clickable/);
    assert.match(overview, /openNativeChannelMenu/);
    assert.match(overview, /if \(!openNativeChannelMenu\(event, channelId\)\) return;\s*event\?\.preventDefault/);
    assert.match(overview, /getNativeChannelHeaderSubtitle/);
    assert.match(overview, /getUnifiedChannelHeaderTitle/);
    assert.match(overview, /bindUnifiedChannelToolbarTarget/);
    assert.match(overview, /dockview-channel-native-toolbar/);
    assert.match(overview, /nativeTopicBoundary/);
    assert.match(overview, /dockview-channel-heading/);
    assert.match(overview, /dockview-channel-topic/);
    assert.match(plugin, /\$self\.captureNativeSearchResults\(\$1,this\)/);
    assert.match(standalone, /plugin\.captureNativeSearchResults\(sidebar, channelView\)/);
    assert.match(searchResults, /channelView\?\.props\?\.section === "SEARCH"/);
    assert.match(searchResults, /new SearchSurfaceRegistry\(\)/);
    assert.match(searchResults, /if \(nativeSearchQueryText\(\) == null\) queueNativeClose\(scopeId, channelId\)/);
    assert.match(searchResults, /`guild:\$\{String\(guildId\)\}`/);
    assert.match(searchResults, /searchRegistry\.activate\(scopeId\)/);
    assert.match(searchResults, /const closeButton = nativeSearchControlButton\(\)/);
    assert.match(searchResults, /if \(!closeButton\) return/);
    assert.match(searchResults, /closeButton\.click\(\)/);
    assert.doesNotMatch(searchResults, /toggleDockWidthMode|applyHostWidth/);
    assert.match(searchBody, /getNativeSearchEntries/);
    assert.match(tabs, /searchTabElement/);
    assert.match(searchResults, /channel\.type !== 0/);
    assert.match(searchResults, /\[role='combobox'\]\[data-slate-editor='true'\]/);
    assert.doesNotMatch(tabs, /!unified && hasNativeSearchResults\(channelId\)/);
    assert.match(css, /dockview-search-results-body/);
    assert.match(css, /\.dockview-search-results-body--inactive\s*\{[^}]*content-visibility:\s*hidden;/s);
    assert.match(css, /\.dockview-search-results-body--active\s*\{[^}]*content-visibility:\s*visible;/s);
    assert.match(
        source("plugin/host/channelView.ts"),
        /channelHeaderSubtitle = \{ channelId, element: subtitle \}/
    );
    assert.match(source("plugin/host/channelView.ts"), /function withoutMemberToggle/);
    assert.match(source("plugin/host/channelView.ts"), /Array\.isArray\(node\)/);
    assert.match(source("plugin/host/channelView.ts"), /key === "members"/);
    assert.match(
        css,
        /\.dockview-channel-topic--native > \[class\*="topic_"\]\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s
    );
    assert.match(css, /\.dockview-channel-topic--native > \[class\*="dot_"\]\s*\{[^}]*display:\s*none;/s);
    assert.doesNotMatch(overview, /memberMod|dockview-channel-native-row|dockview-channel-native-icon/);
    assert.doesNotMatch(overview, /updateChannelOverrideSettings|MenuRadioItem|copyText/);
    assert.doesNotMatch(css, /dockview-channel-actions|dockview-channel-action/);
    assert.match(css, /\.dockview-channel-overview\s*\{[^}]*border-bottom:/s);
    assert.doesNotMatch(css, /dockview-channel-native-row|dockview-channel-native-icon/);

    // Detached member/profile roots must restore the exact native provider ancestry so
    // Discord's own user and bot rows can open their native profile layer.
    assert.match(contextBody, /getMemberProviderStack/);
    assert.match(contextBody, /getProfileProviderStack/);
    assert.match(contextBody, /for \(const provider of stack\)/);
    assert.match(contextBody, /providerBoundary/);
    assert.match(source("plugin/host/slotComponents.ts"), /memberProviderStack/);
    assert.match(source("plugin/host/slotComponents.ts"), /profileProviderStack/);

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

test("Search tab and resident body share one active-state source and repaint signal", () => {
    const searchResults = source("plugin/host/searchResults.ts");
    const searchRegistry = source("plugin/host/searchResultsRegistry.ts");
    const searchBody = source("plugin/ui/SearchResultsBody.tsx");
    const tabs = source("plugin/ui/DockTabs.tsx");

    // One predicate is THE active-state source for both the fixed Search tab and its
    // resident body; the tab passes the current scope, the body each resident entry.
    assert.match(searchRegistry, /export function isSearchSurfaceActive/);
    assert.match(searchResults, /isSearchSurfaceActive\(channelId: string \| null, scopeId: string \| null\)/);
    assert.match(searchBody, /isSearchSurfaceActive\(channelId, entry\.scopeId\)/);
    assert.match(tabs, /searchTabElement\(channelId, isSearchSurfaceActive\(channelId, getNativeSearchScopeId\(channelId\)\)\)/);
    // The body must repaint on the same engine signal as the tab (UnifiedHeaderTabs
    // subscribes), not only through the panel's single renderer slot. The subscription
    // attaches in the commit-synchronous layout phase — a passive effect would miss the
    // queueMicrotask activation that follows the first-open capture render.
    assert.match(searchBody, /useLayoutEffect\(\(\) => subscribeRender\(rerender\), \[rerender\]\)/);
    assert.doesNotMatch(searchBody, /\buseEffect\b/);
    assert.match(searchBody, /getNativeSearchRenderRevision/);
    assert.match(searchBody, /next\.channelId === rendered\.current\.channelId && next\.revision === rendered\.current\.revision/);
    assert.match(searchBody, /useMemo\([\s\S]*\[channelId, revision\]\)/);
});

test("Search close keeps the native tree resident and Enter reactivates it", () => {
    const searchResults = source("plugin/host/searchResults.ts");
    const searchRegistry = source("plugin/host/searchResultsRegistry.ts");

    assert.doesNotMatch(searchResults, /suppressedScopes|suppressionTokens|SearchCloseLifecycle/);
    assert.match(searchRegistry, /private readonly visibleScopes/);
    assert.match(searchRegistry, /hide\(scopeId: string \| null\)/);
    assert.match(searchResults, /searchRegistry\.hideIfSource\(scopeId, sourceChannelId\)/);
    assert.match(searchResults, /!searchRegistry\.isVisible\(scopeId\) && searchQuery != null/);
    assert.match(searchResults, /armSearchReopenOnEnter\(scopeId, entryAtClose\)/);
    assert.match(searchResults, /document\.addEventListener\("keydown", onSearchEditorKeyDown, true\)/);
    assert.match(searchResults, /document\.removeEventListener\("keydown", onSearchEditorKeyDown, true\)/);
    assert.match(searchResults, /const editor = nativeSearchEditor\(\)/);
    assert.match(searchResults, /findPageInnerForHost\(selectDockHost\(\)\)/);
    assert.match(searchResults, /editor\.contains\(event\.target\)/);
    assert.doesNotMatch(searchResults, /searchReopenListeners/);
    assert.match(searchResults, /event\.key !== "Enter"/);
    assert.match(searchResults, /searchRegistry\.activate\(scopeId\)/);
    // The editor query is judged by Slate semantic content only: a placeholder
    // (data-slate-placeholder) is never a query, and the translated textContent vs
    // aria-label equality fallback (which misread the localized placeholder) is gone.
    assert.match(searchResults, /data-slate-placeholder/);
    assert.match(searchResults, /slateSearchEditorQuery\(/);
    assert.doesNotMatch(searchResults, /editor\.textContent|aria-label/);
});

test("fallback host promotion stops polling and never adopts Discord's patched node", () => {
    const mount = source("plugin/host/mount.ts");

    assert.match(mount, /const FALLBACK_HEARTBEAT_MS = 2500/);
    assert.match(mount, /const FALLBACK_HOST_ATTR = "data-dockview-fallback-host"/);
    assert.match(mount, /const staleInjectedHost = injectedHost;[\s\S]*stopFallbackInfrastructure\(\);[\s\S]*mode = "patched";[\s\S]*bindRoot\(el\)/);
    assert.match(mount, /let host = injectedHost\?\.isConnected \? injectedHost : null/);
    assert.doesNotMatch(mount, /let host = document\.getElementById\(HOST_ID\)/);
    assert.match(mount, /if \(!topologyChanged\) return;/);
    assert.match(mount, /observer\?\.disconnect\(\);[\s\S]*clearTimeout\(debounce\)/);
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
        /\.dockview-tab\s*\{[^}]*padding:\s*0 38px 0 10px;/s
    );
    assert.match(css, /\.dockview-tab\s*\{[^}]*flex:\s*0 0 10rem;[^}]*min-width:\s*10rem;/s);
    assert.match(css, /\.dockview-tabs\s*\{[^}]*overflow-x:\s*auto;/s);
    assert.match(css, /\.dockview-tab-primary\s*\{/);
    assert.match(
        css,
        /\.dockview-unified-tabs > \.dockview-tab-primary,[\s\S]*?\.dockview-unified-tabs > \.dockview-tab-search\s*\{[^}]*flex:\s*1 1 10rem;[^}]*min-width:\s*5rem;/s
    );
    assert.match(css, /\.dockview-unified-tabs > \.dockview-tabs\s*\{[^}]*flex:\s*1 1 10rem;[^}]*min-width:\s*0;/s);
    assert.match(css, /\.dockview-tab-native-title\s*\{/);
    assert.match(css, /\.dockview-tab-list-button\s*\{/);
    assert.match(css, /\.dockview-tab-name-start/);
    assert.match(css, /\.dockview-unified-tabs \.dockview-tab::before\s*\{/);
    assert.match(css, /\.dockview-page-inner\.dockview-unified-layout\s*\{[^}]*display:\s*grid\s*!important;/s);
    assert.match(css, /\.dockview-unified-header\s*\{[^}]*grid-row:\s*1;/s);
    assert.doesNotMatch(css, /\.dockview-channel-header-spacer/);
    assert.doesNotMatch(css, /\.dockview-unified-header-layer/);

    const tabs = source("plugin/ui/DockTabs.tsx");
    assert.match(tabs, /onAuxClick/);
    assert.match(tabs, /middleLabelParts/);
    assert.match(tabs, /ResizeObserver/);
    assert.match(tabs, /dockview-all-tabs/);
    assert.match(tabs, /openNativeChannelMenu/);
    assert.match(source("plugin/ui/DockTabMenu.tsx"), /closeOtherTabs/);
    assert.match(source("plugin/ui/DockTabMenu.tsx"), /closeTabsToRight/);
    assert.match(source("plugin/ui/DockTabMenu.tsx"), /activateTarget/);
    assert.doesNotMatch(source("plugin/ui/DockMoreMenu.tsx"), /dockview-tab-close/);
    assert.doesNotMatch(tabs, /reorderTab|onDragStart|onDragOver|onDragEnd/);
    assert.doesNotMatch(source("plugin/index.tsx"), /reorderTab/);
});

test("reopening an existing file always repaints the focused tab", () => {
    const load = source("plugin/engine/load.ts");
    const afterOpen = load.slice(load.indexOf("export function load"), load.indexOf("export function loadInPlace"));

    assert.match(afterOpen, /openTab\(opts\.url \?\? null, type\)/);
    assert.match(afterOpen, /setContextActive\(getWindowChannelId\(\), false\)/);
    assert.match(afterOpen, /openPanelChrome\(\)[\s\S]*requestRender\(\)/);
    assert.doesNotMatch(afterOpen, /result !== "noop"/);
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
    assert.match(prepare, /SOURCE_DATE_EPOCH: sourceDateEpoch/);
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
