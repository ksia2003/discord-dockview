/*
 * DockView — Vencord userplugin (modular rewrite entry).
 * ---------------------------------------------------------------------------
 * The manifest + lifecycle + Flux wiring for the from-scratch modular DockView.
 * It mounts the host (the right-docked, native-style panel), registers the host
 * with the engine bridge, restores the persisted width/open state, binds the
 * F9 toggle, and exposes window.__dockView for console / CDP driving.
 *
 * Phase 3: the text/code viewer is registered (viewers/registry.ts), and chip-click
 * loading is re-wired — embed.ts intercepts a dock-handled attachment chip / inline
 * image and routes it through the engine's load(). Open the dock with F9 (or
 * __dockView.toggle()); clicking a code/text chip renders it, and a handled type
 * whose viewer isn't built yet lands on the unsupported card.
 *
 * target DESKTOP: the eventual artifact/PDF/markdown renderers rely on the CSP
 * nonce trick + main-thread pdf worker that only hold under the desktop client.
 *
 * CRITICAL: this entry does NOT import the old panel.tsx. That flat file stays on
 * disk untouched (port source for the remaining phases), just unreferenced.
 */

import definePlugin from "@utils/types";
import { findGroupChildrenByChildId } from "@api/ContextMenu";
import { Menu, React } from "@webpack/common";

import managedStyle from "./style.css?managed";

import { clearArtifact, load, retryActiveLoad } from "./engine/load";
import { clearContentCache } from "./engine/cache";
import { categoryOf } from "./engine/categoryMap";
import { preloadDecoders } from "./engine/decoderModes";
import { fallbackCopy } from "./engine/fetch";
import { loadLib } from "./engine/lazyLib";
import { detectType } from "./engine/detectType";
import {
    canLoadOlder, clearFileIndex, getChannelFiles, invalidate as invalidateFileIndex, loadOlder as loadOlderFiles
} from "./engine/fileIndex";
import { requestRender } from "./engine/forceRender";
import {
    clearChannelVisibility, dockVisible, getChannelStates, onChannelSelect, setCurrentChannelMemId
} from "./engine/channelMemory";
import { loadPersistedState } from "./engine/persist";
import { closeTab, pinActiveWindow, switchToWindow, unpinActiveWindow } from "./engine/tabs";
import {
    getActiveWindow, getActiveWindowId, getWindows, resetToClosedTransient, transientWindow
} from "./engine/window";
import { getCurrentChannelId } from "./host/channel";
import {
    closeNativeChannelSidebar, getMemberListRestorePending, getProfileSidebarRestorePending,
    getSelfMemberToggle, getSelfProfileToggle, isMemberListShown, isUserProfileSidebarShown,
    onChannelSidebarView, onMemberSectionToggle, onUserProfileSidebarToggle
} from "./host/exclusivity";
import { applyHostWidth, clampWidth } from "./host/layout";
import { applyOpenState, ensureHost } from "./host/mount";
import { closePanel, openBrowserHome, registerHost, startHost, stopHost, toggle } from "./host/open";
import { openExternalLink } from "./external/openExternal";
import { openInVesktopWindow, popoutArtifact, vesktopWindowHtml } from "./external/vesktopWindow";
import { markdownHasToc, mdState } from "./viewers/doc/MarkdownViewer";
import {
    closeAttachBar, confirmAttachBar, isAttachBarOpen, openAttachBar, setAttachBarName,
    attachActiveFile
} from "./edit/attach";
import { editBufferText, toggleEditMode } from "./edit/editMode";
import { onNewFile } from "./edit/newFile";
import { startEmbed, stopEmbed } from "./embed";
import { startLatex, stopLatex } from "./latex";
import { maybeRegisterMcpViewer, startMcp, stopMcp } from "./mcp";
import { clearBrowserStates, requestBrowserRefresh, setBrowserFilter } from "./ui/FileBrowser";
import { settings } from "./settings";
import { STRINGS } from "./strings";
import { scheduleAutoCheck } from "./ui/autoCheck";
import { installDockViewSection, uninstallDockViewSection } from "./ui/settingsSection";

// --- window key handlers (lifecycle-scoped, removed on stop) ----------------
let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
let onResize: (() => void) | null = null;
let onMessage: ((e: MessageEvent) => void) | null = null;

/** Apply the persisted width/open state once DataStore resolves. Width is applied
 *  to the active window + the host geometry; `open` is only ever forced TRUE from
 *  storage (a channel switch during the async gap must not be slammed shut). */
async function applyPersisted(): Promise<void> {
    const { widthStr } = await loadPersistedState();
    if (typeof widthStr === "string") {
        const w = clampWidth(parseInt(widthStr, 10) || getActiveWindow().state.width);
        if (w !== getActiveWindow().state.width) getActiveWindow().state.width = w;
    }
    // Dock VISIBILITY is per-channel and in-memory (NOT persisted): on a fresh boot the
    // dock starts hidden. There's nothing to restore open onto anyway — stop() cleared
    // the cache + windows, and attachment CDN links expire, so auto-reopening would
    // only surface an empty/broken shell. Only the width persists (LS_WIDTH).
    // Re-render with the restored width. The DockPanel keeps `width` in local React
    // state (write-only, drives persistence on a user drag); a bump never reseeds it,
    // so this can't clobber the width we just restored onto state.width.
    requestRender();
}

/** The neutral console / CDP handle. Ported from the old exposeDebug surface so the
 *  CDP verification harness keeps working. Getters read the LIVE active window (it's
 *  reassigned on every tab switch — a captured snapshot would go stale). */
function exposeDebug(): void {
    (window as any).__dockView = {
        // active window + the historical per-window getters mapped onto it.
        get activeWindow() { return getActiveWindow(); },
        get state() { return getActiveWindow().state; },
        get content() { return getActiveWindow().content; },
        get activeCacheKey() { return getActiveWindow().activeCacheKey; },

        // open / close / toggle.
        toggle, ensureHost, applyOpenState, closePanel,
        get dockOpen() { return dockVisible(); },

        // content router + channel memory.
        load, retry: retryActiveLoad, clear: clearArtifact, detectType,
        onChannelSelect, getCurrentChannelId,
        get channelStates() { return getChannelStates(); },

        // file browser data spine (batch 1): enumerate/page/invalidate the channel's
        // openable attachments. The UI layer (batch 2) consumes these.
        getChannelFiles, loadOlder: loadOlderFiles, canLoadOlder, invalidateFileIndex,
        // file browser HOME (batch 3): the γ entry point primitives — open the browser
        // home for the current channel + prefilter it to a category. `browseChannelFiles`
        // is exactly what the "message" attachment context-menu item runs.
        openBrowserHome, setBrowserFilter,
        browseChannelFiles: (category: any) => { setBrowserFilter(getCurrentChannelId(), category ?? null); openBrowserHome(); },

        // exclusivity (member list / profile sidebar) — drive + assert.
        closeNativeChannelSidebar,
        onMemberSectionToggle, onUserProfileSidebarToggle, onChannelSidebarView,
        get memberListShown() { return isMemberListShown(); },
        get memberListRestorePending() { return getMemberListRestorePending(); },
        get profileSidebarShown() { return isUserProfileSidebarShown(); },
        get profileSidebarRestorePending() { return getProfileSidebarRestorePending(); },
        get selfMemberToggle() { return getSelfMemberToggle(); },
        get selfProfileToggle() { return getSelfProfileToggle(); },

        // multi-window (pin-driven tabs): the collection + the tab verbs.
        get windows() { return getWindows(); },
        get activeWindowId() { return getActiveWindowId(); },
        switchToWindow, pinActiveWindow, unpinActiveWindow, closeTab, transientWindow,

        // edit-mode (the cross-cutting capability): drive the view↔edit toggle +
        // assert the temporary buffer / re-render loop.
        toggleEditMode,
        get editView() { return getActiveWindow().editView; },
        get editBuffer() { return editBufferText(); },

        // attach + new-file: drive the attach-edited-buffer + new-file paths.
        attachActiveFile, onNewFile,
        openAttachBar, closeAttachBar, confirmAttachBar,
        get attachBarOpen() { return isAttachBarOpen(); },
        set attachBarName(v: string) { setAttachBarName(v); },
        get isNewFile() { return getActiveWindow().isNewFile; },

        // external pop-out (in-app Vesktop window).
        openInVesktopWindow, vesktopWindowHtml, popout: popoutArtifact
    };
}

function unexposeDebug(): void {
    try { delete (window as any).__dockView; } catch { /* ignore */ }
}

export default definePlugin({
    name: "DockView",
    description: "Click an attachment chip or inline image to render it in a right-docked, native-style panel: HTML artifacts, PDF, code, markdown, and images (F9 to toggle; mutually exclusive with the member list; remembers per channel; PDF refits on resize).",
    authors: [{ name: "seonin", id: 0n }],
    target: "DESKTOP",

    // This build (a Vesktop fork) exists to ship DockView, so the panel is ON out
    // of the box. Without this a fresh install leaves the app's whole reason for
    // existing disabled until the user digs into the plugin list to enable it.
    enabledByDefault: true,

    // DockView is a plugin, but it presents as a STANDALONE settings section (the
    // "DockView" left-sidebar tab registered in start()), not a card in the Plugins
    // list. `hidden` only filters the plugin out of the Plugins-list render loop
    // (Vencord PluginsTab: `if (p.hidden) continue`); it does NOT affect loading.
    // The plugin loader (PluginManager.startAllPlugins) gates purely on
    // isPluginEnabled() — which `enabledByDefault: true` satisfies — and never reads
    // `hidden`, so start()/stop() and the native.ts updater IPC still run. Verified
    // against bundled Vencord 1.14.x.
    hidden: true,

    // MCP bridge connect info persists through Vencord's settings store, NOT
    // localStorage (Discord deletes window.localStorage in the renderer). The MCP
    // surface itself is parked (P9); the settings keys stay grouped here.
    settings,

    // Managed style: Vencord auto-enables this CSS when the plugin starts and
    // disables it on stop.
    managedStyle,

    // Per-channel panel memory + reverse sidebar exclusivity, routed to the new
    // engine/host modules. CHANNEL_SELECT saves the leaving channel's transient and
    // restores the entered channel's; the three toggle actions vacate the dock when
    // a native sidebar takes the exclusive right slot (our own toggles are filtered
    // inside the handlers via the self-dispatch flags).
    flux: {
        CHANNEL_SELECT({ channelId }: { channelId: string | null; }) {
            onChannelSelect(channelId ?? null);
        },
        CHANNEL_TOGGLE_MEMBERS_SECTION() {
            onMemberSectionToggle();
        },
        SIDEBAR_VIEW_CHANNEL() {
            onChannelSidebarView();
        },
        USER_PROFILE_SIDEBAR_TOGGLE_SECTION() {
            onUserProfileSidebarToggle();
        },
        // A message landing in / leaving the CURRENT channel changes the file browser's
        // list. Invalidate that channel's cached index + repaint the browser home, but
        // ONLY when the dock is showing it (visible, no file open) — otherwise it's a
        // no-op we don't want to pay on every message in a busy channel. requestBrowser-
        // Refresh drops the index unconditionally (cheap) and nudges a mounted browser.
        MESSAGE_CREATE({ channelId }: { channelId?: string | null; }) {
            if (channelId && channelId === getCurrentChannelId() && dockVisible()
                && getActiveWindow().content.name == null) {
                requestBrowserRefresh(channelId);
            }
        },
        MESSAGE_DELETE({ channelId }: { channelId?: string | null; }) {
            if (channelId && channelId === getCurrentChannelId() && dockVisible()
                && getActiveWindow().content.name == null) {
                requestBrowserRefresh(channelId);
            }
        }
    },

    // "New file" entry point in Discord's `+` composer menu (navId "channel-attach"):
    // opens the dock with an EMPTY editable surface (the same CodeMirror editor every
    // viewer uses, in EDIT mode, default markdown). The user writes a brand-new file
    // in the dock and attaches it via the second-row Attach toolbar — no original
    // baseline, so it edits as a plain editor with no merge diff. Registering this
    // auto-adds the ContextMenu API as a dependency.
    contextMenus: {
        "channel-attach": (children: any, props: any) => {
            children.push(
                React.createElement(Menu.MenuItem, {
                    id: "dockview-new-file",
                    label: STRINGS.menu.newFile,
                    action: () => onNewFile(props?.channel ?? null)
                })
            );
        },
        // γ ENTRY POINT (design §2.2): right-click an attachment in a message → open the
        // channel's file BROWSER prefiltered to that file's type. The "message" menu
        // fires for EVERY message right-click, so we act only when a clicked media item
        // url is present (props.itemHref / itemSrc, the native fields), and only when
        // that url is a file the dock can open. We prefilter to the file's viewer
        // category, then open the browser home for the current channel.
        "message": (children: any, props: any) => {
            const src: string | undefined = props?.itemHref ?? props?.itemSrc;
            if (!src) return;
            const type = detectType({ url: src });
            if (type === "unknown") return; // not a dock-openable file
            const category = categoryOf(type);
            const item = React.createElement(Menu.MenuItem, {
                id: "dockview-browse-channel-files",
                label: STRINGS.menu.browseChannelFiles,
                action: () => {
                    // Set the prefilter first (records it into the CURRENT channel's
                    // browser memory), then open the home. If a browser is already up it
                    // repaints via the filter notify; otherwise openBrowserHome shows it
                    // and it reads the prefiltered state on mount.
                    setBrowserFilter(getCurrentChannelId(), category);
                    openBrowserHome();
                }
            });
            // Sit next to Discord's own "Copy Link" entry; fall back to appending.
            const group = findGroupChildrenByChildId("copy-link", children);
            (group ?? children).push(item);
        }
    },

    start() {
        // 0. MCP is PARKED: register its mcpapp viewer ONLY when the bridge toggle is
        //    on (a no-op otherwise), BEFORE the first window is built so its view-state
        //    slice is included. With the toggle off nothing here runs — the mcpapp
        //    viewer never enters the registry and the feature stays fully dormant.
        maybeRegisterMcpViewer();
        // 1. mount the host + register it with the engine bridge (so the engine's
        //    open/close/channel/tab paths drive real DOM) + seed the channel mem.
        startHost();
        registerHost();
        // 2. restore persisted width/open from DataStore (async; applies on resolve).
        applyPersisted();

        // 3. F9 toggles the dock. A single function key — text inputs don't capture
        //    it, so no focus guard is needed; we still preventDefault to stop any
        //    default. The viewer single-key/Ctrl+F shortcuts (image zoom, PDF page-nav/
        //    zoom/find, code find, pptx slide-nav) are bound by each viewer's body
        //    behind the shared dock-focus gate (engine/dockKeyboard); this entry owns
        //    only the global dock toggle.
        onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "F9" || e.code === "F9") {
                e.preventDefault();
                toggle();
            }
        };
        window.addEventListener("keydown", onKeyDown);

        // 4. On window resize: re-clamp the persisted width to the window bound and
        //    re-evaluate the docked/floating geometry (a narrowing window must flip a
        //    wide dock to floating even if the intended width doesn't change).
        onResize = () => {
            if (!dockVisible()) return;
            const w = clampWidth(getActiveWindow().state.width);
            if (w !== getActiveWindow().state.width) getActiveWindow().state.width = w;
            applyHostWidth();
        };
        window.addEventListener("resize", onResize);

        // 5. Sandbox iframes postMessage link clicks up to us; open them externally
        //    instead of navigating inside the (null-origin) sandbox. (The viewers that
        //    emit these land in P5; the listener is harmless until then.)
        onMessage = (e: MessageEvent) => {
            const d = e?.data;
            if (!d || typeof d !== "object") return;
            if (typeof d.__dockViewOpenLink === "string") {
                openExternalLink(d.__dockViewOpenLink);
                return;
            }
            // A markdown iframe just (re)loaded and asks for the current TOC state, so a
            // cache return / edit-back reopens the outline if it was left open.
            if (d.__dockViewMdTocReady) {
                const win = getActiveWindow();
                if (win.content.type === "markdown" && markdownHasToc(win)) {
                    try { (e.source as WindowProxy | null)?.postMessage({ __dockViewMdToc: mdState(win).tocOpen }, "*"); } catch { /* ignore */ }
                }
                return;
            }
            // A code-fence copy button in the markdown sandbox: the null-origin frame
            // can't reach the clipboard itself, so it hands us the text and we copy it
            // (a real Discord origin), then ack back so the button shows "copied".
            if (d.__dockViewMdCopy && typeof d.__dockViewMdCopy.text === "string") {
                const { id, text } = d.__dockViewMdCopy;
                const ack = () => { try { (e.source as WindowProxy | null)?.postMessage({ __dockViewMdCopied: id }, "*"); } catch { /* ignore */ } };
                try {
                    if (navigator.clipboard?.writeText) {
                        navigator.clipboard.writeText(text).then(ack, () => fallbackCopy(text, ack));
                    } else { fallbackCopy(text, ack); }
                } catch { fallbackCopy(text, ack); }
            }
        };
        window.addEventListener("message", onMessage);

        // 6. chip-click delegation: intercept clicks on dock-handled attachment
        //    chips / inline images and route them through the engine's load().
        startEmbed();

        // 7. chat-side KaTeX (separate concern, kept) + the debug surface.
        startLatex();
        exposeDebug();

        // 8. MCP bridge (PARKED): start the WS client + frame→host JSON-RPC router.
        //    A NO-OP unless mcpBridgeEnabled — no socket, no listener when off.
        startMcp();

        // 9. Add DockView's own top-level SECTION to the settings sidebar (a
        //    dedicated "DockView" header, same rank as "Vencord Settings", with
        //    the Updates / Examples / About rows). Wraps the Settings plugin's
        //    buildLayout from this same Vencord bundle (the Vesktop src/renderer
        //    bundle can't import plugin/). Idempotent + fully guarded.
        installDockViewSection();

        // 10. Warm any heavy decoder the user set to "Preload" (Performance page), once,
        //     OFF the startup critical path — requestIdleCallback when available, else a
        //     short timeout. Each warm is a plain loadLib(chunkKey); a failure falls back
        //     to the on-demand load. Decoders left on "On demand"/"Disabled" are skipped.
        const warm = () => preloadDecoders(key => loadLib(key, () => Promise.reject(new Error("preload"))));
        const ric = (window as any).requestIdleCallback;
        if (typeof ric === "function") ric(warm, { timeout: 4000 });
        else setTimeout(warm, 2000);

        // 11. Once-a-day background update check (opt-out via the Updates page switch),
        //     OFF the boot critical path + throttled to 24h. On finding a newer build it
        //     raises a one-time notice + flags the Updates row; it NEVER auto-applies.
        scheduleAutoCheck();
    },

    stop() {
        // 0. MCP bridge (PARKED): tear down the WS client + its frame→host listener +
        //    registries. Safe no-op if it was never started (toggle off).
        stopMcp();
        // 1. window listeners + chip-click delegation.
        if (onKeyDown) { window.removeEventListener("keydown", onKeyDown); onKeyDown = null; }
        if (onResize) { window.removeEventListener("resize", onResize); onResize = null; }
        if (onMessage) { window.removeEventListener("message", onMessage); onMessage = null; }
        stopEmbed();
        // 2. tear down the host (heartbeat/observer/React unmount + triple sweep +
        //    native-sidebar restore). Marks inactive first so no callback re-injects.
        stopHost();
        // 3. collapse the window collection back to a single closed transient (so a
        //    re-start begins from the clean single-window state) + drop the content
        //    cache + per-channel memory (in-memory only). We do NOT persist a closed
        //    flag — the user's last open/closed choice + width stay in DataStore so a
        //    re-start restores them.
        resetToClosedTransient(null);
        clearContentCache();
        clearFileIndex();
        clearBrowserStates();
        getChannelStates().clear();
        clearChannelVisibility();
        setCurrentChannelMemId(null);
        // 4. chat-side KaTeX teardown + remove the debug handle.
        stopLatex();
        unexposeDebug();
        // 5. restore the Settings plugin's buildLayout so a disable/enable cycle
        //    leaves the sidebar exactly as we found it (no stale/duplicate section).
        uninstallDockViewSection();
    }
});
