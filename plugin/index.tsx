/*
 * DockView — Vencord userplugin (modular rewrite entry).
 * ---------------------------------------------------------------------------
 * The manifest + lifecycle + Flux wiring for the from-scratch modular DockView.
 * It mounts the host (the always-on right rail), registers the host with the engine
 * bridge, restores the persisted width, and exposes window.__dockView for console /
 * CDP driving.
 *
 * The dock is ALWAYS visible (it IS the right rail) — there is no toggle. Chip-click
 * loading is wired via embed.ts, which intercepts a dock-handled attachment chip /
 * inline image and routes it through the engine's load(); a handled type whose viewer
 * isn't built yet lands on the unsupported card, and an empty channel shows the
 * empty-state body.
 *
 * target DESKTOP: the eventual artifact/PDF/markdown renderers rely on the CSP
 * nonce trick + main-thread pdf worker that only hold under the desktop client.
 *
 * CRITICAL: this entry does NOT import the old panel.tsx. That flat file stays on
 * disk untouched (port source for the remaining phases), just unreferenced.
 */

import { findGroupChildrenByChildId } from "@api/ContextMenu";
import definePlugin from "@utils/types";
import { Menu, React } from "@webpack/common";

import managedStyle from "./style.css?managed";

import { clearArtifact, load, retryActiveLoad } from "./engine/load";
import { clearContentCache } from "./engine/cache";
import { preloadDecoders } from "./engine/decoderModes";
import { fallbackCopy } from "./engine/fetch";
import { loadLib } from "./engine/lazyLib";
import { detectType, isExternalWebUrl } from "./engine/detectType";
import { isRendererLive, requestRender } from "./engine/forceRender";
import { onChannelSelect, setCurrentChannelMemId } from "./engine/channelMemory";
import { isContextActive, resetContextTab, setContextActive } from "./engine/contextTab";
import { loadPersistedState } from "./engine/persist";
import { closeTab, switchToWindow } from "./engine/tabs";
import {
    getActiveWindow, getActiveWindowId, getChannelTabs, getWindows, reorderTab, resetCollection
} from "./engine/window";
import { getCurrentChannelId } from "./host/channel";
import {
    getSelfMemberToggle, getSelfProfileToggle, isMemberListShown, isUserProfileSidebarShown
} from "./host/nativePanels";
import { interceptionInstalled, startInterception, stopInterception } from "./host/interception";
import { applyHostWidth, clampWidth } from "./host/layout";
import { applyOpenState, ensureHost, liveHost, mountDebugLog, mountStats, renderDockRail } from "./host/mount";
import { registerHost, startHost, stopHost } from "./host/open";
import {
    captureChat, getChatType, getMemberListType, getProfileType, getProviderStack,
    invalidateSlotComponents, isProfileSectionUnavailable, primeDebugLog, primeMemberList,
    primeProfile, setForceProfileSidebarUnavailable
} from "./host/slotComponents";
import { destroyAllThreadPortals, livePortalThreads, portalDebugLog } from "./viewers/thread/threadPortal";
import { closeThreadTabEverywhere, openThreadTab } from "./engine/threadTab";
import { onChannelDelete, onThreadDelete, onThreadUpdate } from "./engine/threadEvents";
import { openExternalLink } from "./external/openExternal";
import { openInVesktopWindow, popoutArtifact, vesktopWindowHtml } from "./external/vesktopWindow";
import { markdownHasToc, mdState } from "./viewers/doc/MarkdownViewer";
import {
    closeAttachBar, confirmAttachBar, isAttachBarOpen, openAttachBar, setAttachBarName,
    attachActiveFile
} from "./edit/attach";
import { editBufferText, toggleEditMode } from "./edit/editMode";
import { onNewFile } from "./edit/newFile";
import { openWebTab, startEmbed, stopEmbed } from "./embed";
import { settings } from "./settings";
import { STRINGS } from "./strings";
import { scheduleAutoCheck } from "./ui/autoCheck";
import { installDockViewSection, uninstallDockViewSection } from "./ui/settingsSection";

// --- window handlers (lifecycle-scoped, removed on stop) --------------------
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
    // Only the width persists (LS_WIDTH) — the dock is always open, there is no
    // visibility state to restore. Re-render with the restored width. The DockPanel
    // keeps `width` in local React state (write-only, drives persistence on a user
    // drag); a bump never reseeds it, so this can't clobber the restored width.
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

        // host mount. The dock is always open — no toggle/close (dockOpen is always true).
        ensureHost, applyOpenState,
        get dockOpen() { return true; },
        // E3 repaint canary: the mount lifecycle counters + whether a live renderer is
        // published + whether the bound host node is still in the document.
        // rendererLive=false or rootBound=false while a dock is on screen == the "frozen
        // stale strip" fingerprint (requestRender is a dead write into a torn-down root).
        get mountStats() { return mountStats(); },
        get mountDebug() { return mountDebugLog(); },
        get rendererLive() { return isRendererLive(); },
        get rootBound() { const h = liveHost(); return !!(h && h.isConnected); },

        // content router + channel switch.
        load, retry: retryActiveLoad, clear: clearArtifact, detectType,
        onChannelSelect, getCurrentChannelId,

        // action interception (Batch D): the member list / profile sidebar / thread sidebar
        // never open natively — the store stays put + user toggles become dock actions.
        get memberListShown() { return isMemberListShown(); },
        get profileSidebarShown() { return isUserProfileSidebarShown(); },
        get selfMemberToggle() { return getSelfMemberToggle(); },
        get selfProfileToggle() { return getSelfProfileToggle(); },
        get interceptionInstalled() { return interceptionInstalled(); },

        // browser-like tabs: the current-channel flat strip + the raw per-channel store +
        // the tab verbs. `windows` is the CURRENT channel's strip; `channelTabs(id)`
        // exposes the raw store for the rig.
        get windows() { return getWindows(); },
        get activeWindowId() { return getActiveWindowId(); },
        channelTabs: (id: string) => getChannelTabs(id),
        switchToWindow, closeTab, reorderTab,

        // context tab (member list / profile in the dock): drive the active-view flag +
        // assert acquisition state (the captured types + priming) for the rig gates.
        setContextActive,
        get contextActive() { return isContextActive(getCurrentChannelId()); },
        get memberListCaptured() { return !!getMemberListType(); },
        get profileCaptured() { return !!getProfileType(); },
        get chatCaptured() { return !!getChatType(); },
        get providerStackCaptured() { return !!getProviderStack(); },
        get profileSectionUnavailable() { return isProfileSectionUnavailable(); },
        get primeLog() { return primeDebugLog(); },
        captureChat, primeMemberList, primeProfile, invalidateSlotComponents,
        // TEST SEAM (rig only): force the DM sidebar route off to prove the cached generic
        // profile type still renders a real profile through a simulated off-window.
        setForceProfileSidebarUnavailable,

        // thread tabs (a thread opened as a dock tab): drive the opener + the external-close
        // path (E1) + assert the live isolated chat portals (one document.body root per open
        // thread).
        openThreadTab, closeThreadTabEverywhere,
        get livePortalThreads() { return livePortalThreads(); },
        get portalDebug() { return portalDebugLog(); },

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
        openInVesktopWindow, vesktopWindowHtml, popout: popoutArtifact,

        openWebTab
    };
}

function unexposeDebug(): void {
    try { delete (window as any).__dockView; } catch { /* ignore */ }
}

/** Extract a plain website URL from Discord's link context-menu arguments. Discord
 * reuses the `image-context` menu for anchors and supplies their destination as
 * `href`. Restrict the action to HTTP(S) pages that DockView classifies as web
 * content, so file attachments keep their existing viewer/download menu. */
function contextMenuWebUrl(props: any): string | null {
    const raw = typeof props?.href === "string"
        ? props.href
        : props?.target?.closest?.("a[href]")?.href;
    if (typeof raw !== "string" || !raw) return null;

    try {
        const url = new URL(raw, location.href);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return isExternalWebUrl(url.href) ? url.href : null;
    } catch {
        return null;
    }
}

function addOpenInDockViewItem(children: any[], props: any): void {
    const url = contextMenuWebUrl(props);
    if (!url) return;

    const target = findGroupChildrenByChildId(["open-link", "copy-link", "copy-native-link"], children) ?? children;
    if (target.some(item => item?.props?.id === "dockview-open-web-link")) return;
    target.push(
        React.createElement(Menu.MenuItem, {
            id: "dockview-open-web-link",
            label: STRINGS.menu.openInDockView,
            action: () => openWebTab(url)
        })
    );
}

export default definePlugin({
    name: "DockView",
    description: "Click an attachment chip or inline image to render it in a right-docked, native-style panel: HTML artifacts, PDF, code, markdown, and images. The dock is always the right rail (channel-bound tabs; the member list / profile / threads become dock tabs; PDF refits on resize).",
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

    settings,

    patches: [
        // Mount the dock as a real child of Discord's React tree, at the FULL-HEIGHT
        // COLUMN position — a sibling of the whole chat column, exactly where the native
        // thread sidebar mounts. The channel-view render() is a Fragment whose children
        // are `[<location tracker>, <div chat-column (header + messages + member slot)>,
        // this.renderThreadSidebar()]`; the thread sidebar (rV.A resizable wrapper) is the
        // LAST Fragment child, a flex sibling of the chat column in the page-inner row, so
        // its top edge is level with the channel header and the header spans only the chat
        // column. We append our host right AFTER renderThreadSidebar() so it takes that
        // same sibling-of-chat slot (renderThreadSidebar returns null while sealed, so the
        // slot is ours). This replaced the old anchor that put the host INSIDE the chat
        // column's inner row (beside the member list, BELOW the header) — 선인's one
        // remaining verdict. `maybePreloadChannelCall` is a method name unique to this
        // component (locates the module); `this.renderThreadSidebar()` is the structural
        // anchor — a `this.`-called method rendered once at the Fragment tail, stable
        // across recent builds. If the anchor drifts, the patch is a no-op and the host
        // falls back to DOM injection (host/mount.ts startHost, which injects at the same
        // page-inner sibling-of-chat position) — so the dock keeps working, hence noWarn.
        {
            find: "maybePreloadChannelCall",
            noWarn: true,
            replacement: {
                match: /(this\.renderThreadSidebar\(\))/,
                replace: "$1,$self.renderDockRail()"
            }
        }
    ],

    // Managed style: Vencord auto-enables this CSS when the plugin starts and
    // disables it on stop.
    managedStyle,

    // Flux subscriptions. CHANNEL_SELECT re-points the active tab for the entered channel +
    // clears the one-shot seal bypass. THREAD_DELETE / THREAD_UPDATE / CHANNEL_DELETE keep
    // the thread tabs honest (E1): a thread deleted or its parent removed externally must
    // not leave a ghost tab; a rename follows the strip label. These are OBSERVED (not
    // swallowed) — the store still processes the real event; we only reconcile our tabs.
    // (The native member-list / profile / thread-sidebar OPEN actions are handled by the
    // dispatch WRAP in host/interception.ts — installed in start() — which SWALLOWS them so
    // Discord never opens a native slot; those are deliberately NOT here.)
    flux: {
        CHANNEL_SELECT({ channelId }: { channelId: string | null; }) {
            onChannelSelect(channelId ?? null);
        },
        THREAD_DELETE(payload: any) {
            onThreadDelete(payload);
        },
        THREAD_UPDATE(payload: any) {
            onThreadUpdate(payload);
        },
        CHANNEL_DELETE(payload: any) {
            onChannelDelete(payload);
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
        // Ordinary clicks remain Vesktop's upstream behavior (OS browser). This
        // explicit context-menu action is the only path that turns a web link into
        // a DockView tab; Discord's untrusted-domain confirmation is untouched.
        "image-context": addOpenInDockViewItem
    },

    // The dock host, appended after the channel-view's renderThreadSidebar() by the layout
    // patch above so it takes the native thread-sidebar's full-height column slot (a flex
    // sibling of the whole chat column). Returns a stable placeholder <div> whose ref binds
    // our own React root (host/mount.ts); all dock logic lives there, this is just the
    // reachable-from-$self seam.
    renderDockRail() {
        return renderDockRail();
    },

    start() {
        // 1. mount the host + register it with the engine bridge (so the engine's
        //    open/close/channel/tab paths drive real DOM) + seed the channel mem.
        startHost();
        registerHost();
        // 1b. arm the action interception (the dispatch wrap) BEFORE anything can open a
        //     native right slot: it swallows the member-list / profile / thread-sidebar
        //     open actions and converts them to dock actions, so Discord never enters
        //     "sidebar open" state. Our own priming toggles pass through (self-flagged).
        startInterception();
        // 2. restore persisted width/open from DataStore (async; applies on resolve).
        applyPersisted();

        // 3. On window resize: re-clamp the persisted width to the window bound and
        //    re-evaluate the docked/floating geometry (a narrowing window must flip a
        //    wide dock to floating even if the intended width doesn't change). The dock
        //    is always open, so this always runs. (The old F9 toggle is gone — the dock
        //    can no longer be hidden; the empty channel shows the empty-state body.)
        onResize = () => {
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
        // 7. Debug surface for the local verification rig.
        exposeDebug();

        // 9. Add DockView's own top-level SECTION to the settings sidebar (a
        //    dedicated "DockView" header, same rank as "Vencord Settings", with
        //    the Updates / Examples / About rows). Wraps the Settings plugin's
        //    buildLayout from this same Vencord bundle (the Vesktop src/renderer
        //    bundle can't import plugin/). Idempotent + fully guarded.
        installDockViewSection();

        // 9b. PRIME the context-tab slot components. Fiber capture needs the native panel
        //     to have rendered once, but the interim seal collapses them → the prime opens
        //     the store section, lets it render while our CSS hide-mark keeps it invisible,
        //     captures the component TYPE, then re-collapses. Off the critical path (the
        //     first context-tab render also lazily primes, so this is a warm-up). The
        //     member list is usually open by default (a straight capture, no toggle); the
        //     profile sidebar needs a brief hidden toggle. A failure here is non-fatal —
        //     the context body falls back to lazy prime / the honest error card.
        const primeSlots = () => { primeMemberList(); primeProfile(); };
        setTimeout(primeSlots, 1200);

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
        // 1. window listeners + chip-click delegation.
        if (onResize) { window.removeEventListener("resize", onResize); onResize = null; }
        if (onMessage) { window.removeEventListener("message", onMessage); onMessage = null; }
        stopEmbed();
        // 1b. restore FluxDispatcher.dispatch to the exact original (the interception wrap),
        //     so a disable/enable cycle leaves Discord's dispatch untouched.
        stopInterception();
        // 2. tear down the host (heartbeat/observer/React unmount + triple sweep +
        //    hide-mark cleanup). Marks inactive first so no callback re-injects.
        stopHost();
        // 3. clear the whole tab collection (both channel stores) so a re-start begins
        //    from a clean empty state + drop the content cache (in-memory only). We do
        //    NOT persist tabs — the collection is session-only by design; only the dock
        //    width stays in DataStore so a re-start restores it.
        resetCollection();
        clearContentCache();
        // Tear down every thread-chat portal (their document.body roots + overlay nodes) so
        // no captured chat / ghost overlay survives the stop.
        destroyAllThreadPortals();
        // Clear the context-tab per-channel flags + drop the captured slot component types
        // (a re-start re-primes/re-acquires them lazily).
        resetContextTab();
        invalidateSlotComponents();
        setCurrentChannelMemId(null);
        // 4. Remove the debug handle.
        unexposeDebug();
        // 5. restore the Settings plugin's buildLayout so a disable/enable cycle
        //    leaves the sidebar exactly as we found it (no stale/duplicate section).
        uninstallDockViewSection();
    }
});
