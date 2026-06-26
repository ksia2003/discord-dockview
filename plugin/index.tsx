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

import managedStyle from "./style.css?managed";

import { clearArtifact, load, retryActiveLoad } from "./engine/load";
import { clearContentCache } from "./engine/cache";
import { detectType } from "./engine/detectType";
import { requestRender } from "./engine/forceRender";
import {
    dockHasWindows, getChannelStates, onChannelSelect, setCurrentChannelMemId
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
    onChannelSidebarView, onMemberSectionToggle, onUserProfileSidebarToggle,
    syncNativeMemberList, syncNativeProfileSidebar
} from "./host/exclusivity";
import { applyHostWidth, clampWidth } from "./host/layout";
import { applyOpenState, ensureHost } from "./host/mount";
import { closePanel, registerHost, startHost, stopHost, toggle } from "./host/open";
import { openExternalLink } from "./external/openExternal";
import { startEmbed, stopEmbed } from "./embed";
import { startLatex, stopLatex } from "./latex";
import { settings } from "./settings";

// --- window key handlers (lifecycle-scoped, removed on stop) ----------------
let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
let onResize: (() => void) | null = null;
let onMessage: ((e: MessageEvent) => void) | null = null;

/** Apply the persisted width/open state once DataStore resolves. Width is applied
 *  to the active window + the host geometry; `open` is only ever forced TRUE from
 *  storage (a channel switch during the async gap must not be slammed shut). */
async function applyPersisted(): Promise<void> {
    const { openStr, widthStr } = await loadPersistedState();
    if (typeof widthStr === "string") {
        const w = clampWidth(parseInt(widthStr, 10) || getActiveWindow().state.width);
        if (w !== getActiveWindow().state.width) {
            getActiveWindow().state.width = w;
            if (getActiveWindow().state.open) applyHostWidth();
        }
    }
    if (openStr === "1" && !getActiveWindow().state.open) {
        closeNativeChannelSidebar();
        getActiveWindow().state.open = true;
        ensureHost();
        applyOpenState();
        syncNativeMemberList(true); // restored open across a restart → collapse like a thread
        syncNativeProfileSidebar(true);
    }
    // Re-render with the restored state. The DockPanel keeps `width` in local React
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
        get dockOpen() { return dockHasWindows(); },

        // content router + channel memory.
        load, retry: retryActiveLoad, clear: clearArtifact, detectType,
        onChannelSelect, getCurrentChannelId,
        get channelStates() { return getChannelStates(); },

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
        switchToWindow, pinActiveWindow, unpinActiveWindow, closeTab, transientWindow
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
        }
    },

    // The "+" composer-menu "New file" entry is a cross-cutting edit/ concern (an
    // empty editable markdown surface) that lands in P8 — omitted here (no-op TODO).

    start() {
        // 1. mount the host + register it with the engine bridge (so the engine's
        //    open/close/channel/tab paths drive real DOM) + seed the channel mem.
        startHost();
        registerHost();
        // 2. restore persisted width/open from DataStore (async; applies on resolve).
        applyPersisted();

        // 3. F9 toggles the dock. A single function key — text inputs don't capture
        //    it, so no focus guard is needed; we still preventDefault to stop any
        //    default. The viewer single-key shortcuts (image zoom, PDF page-nav/find)
        //    ride the viewers and arrive in P3+; P2 owns only the dock toggle.
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
            if (!dockHasWindows()) return;
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
            if (d && typeof d === "object" && typeof d.__dockViewOpenLink === "string") {
                openExternalLink(d.__dockViewOpenLink);
            }
        };
        window.addEventListener("message", onMessage);

        // 6. chip-click delegation: intercept clicks on dock-handled attachment
        //    chips / inline images and route them through the engine's load().
        startEmbed();

        // 7. chat-side KaTeX (separate concern, kept) + the debug surface.
        startLatex();
        exposeDebug();
    },

    stop() {
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
        getChannelStates().clear();
        setCurrentChannelMemId(null);
        // 4. chat-side KaTeX teardown + remove the debug handle.
        stopLatex();
        unexposeDebug();
    }
});
