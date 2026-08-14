/*
 * The tab strip (a single flat, channel-bound list). Renders one tab per REAL window —
 * a content tab (isRealTab). A content-less transient (the empty-state shell) gets NO
 * tab, so the strip is empty and the empty-state body shows. The tabs ARE the header's
 * icon/name slot.
 *
 * "header = tab" model (browser-tab grammar): the ONLY inline control on a tab is its
 * ✕ (close THAT window via closeTab — closing the LAST tab shows Channel info;
 * the dock itself can no longer be closed). There is NO inline ⋯ on any tab — a tab's
 * lifecycle actions are reached by RIGHT-CLICK in place, without a tab switch. Tabs are
 * FLAT (icon + name);
 * the active tab gets a subtle underline + brighter text (CSS), not a pill.
 *
 * The ✕ follows browser-tab visibility: the ACTIVE tab shows its ✕ at rest; an INACTIVE
 * tab hides its ✕ at rest and reveals it only on HOVER (absolutely positioned at the
 * tab's right edge so it never reflows the strip — pure CSS, see style.css).
 *
 * Every tab keeps the same width regardless of selection or Dock width. Overflow scrolls
 * horizontally; selecting a tab only brings that stable handle into view. Tab drag
 * ordering is deliberately deferred, so the strip does not install drag handlers.
 */

import { ContextMenuApi, Menu, React } from "@vencord/types/webpack/common";

import { requestRender, subscribeRender } from "../engine/forceRender";
import { hostActions } from "../engine/hostBridge";
import { getCurrentChannelMemId } from "../engine/channelMemory";
import { setContextActive, setContextView } from "../engine/contextTab";
import { closeTab, switchToWindow } from "../engine/tabs";
import type { ContentType } from "../engine/types";
import { getActiveWindowId, getWindows, isRealTab } from "../engine/window";
import { openNativeChannelMenu } from "../host/channelView";
import {
    activateNativeSearchResults, closeNativeSearchResults, getDockContextView,
    getNativeSearchQuery, getNativeSearchScopeId, hasNativeSearchResults,
    isSearchSurfaceActive
} from "../host/searchResults";
import { contextKindFor, getChannelObject } from "../host/slotComponents";
import { STRINGS } from "../strings";
import { selectThreadPortal } from "../viewers/thread/threadPortal";
import { DockTabMenu } from "./DockTabMenu";
import { middleLabelParts } from "./tabLabels";
import { iconPaths } from "./toolbar";

const TAB_CLOSE_PATH = "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z";
const TAB_LIST_PATH = "M7 7h10a1 1 0 1 1 0 2H7a1 1 0 0 1 0-2Zm0 4h10a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2Zm0 4h10a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2Z";
const TAB_ACTIVE_PATH = "M9.2 16.6 4.6 12l1.4-1.4 3.2 3.2 8.8-8.8 1.4 1.4-10.2 10.2Z";
function tabLabelElement(label: string) {
    const parts = middleLabelParts(label);
    return React.createElement(
        "span",
        { key: "name", className: "dockview-tab-name", "aria-label": label },
        parts
            ? [
                React.createElement("span", { key: "start", className: "dockview-tab-name-start" }, parts.start),
                React.createElement("span", { key: "end", className: "dockview-tab-name-end" }, parts.end)
            ]
            : React.createElement("span", { className: "dockview-tab-name-full" }, label)
    );
}

// Context-tab glyphs (20px parity with tabIcon). Members = the people/roster icon;
// profile = a single-person head+shoulders. Both drawn to match Discord's own iconography
// weight (the same 24-viewBox filled paths as the file-type glyphs).
const MEMBERS_ICON_PATH = "M14.5 8a3 3 0 1 0-2.99-3.24A5 5 0 0 1 14.5 8Zm2.5 3c-.34 0-.68.02-1 .07 1.2.86 2 2.28 2 3.93v2h4v-2c0-1.66-3.34-4-5-4ZM9 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2 0-6 1.34-6 4v2h12v-2c0-2.66-4-4-6-4Z";
const PROFILE_ICON_PATH = "M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-3.33 0-10 1.67-10 5v2a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-2c0-3.33-6.67-5-10-5Z";
const CHANNEL_ICON_PATH = "M10.3 2h2l-1 5h4.4l1-5h2l-1 5H21v2h-3.7l-1.2 6H20v2h-4.3l-1 5h-2l1-5H9.3l-1 5h-2l1-5H3v-2h4.7l1.2-6H4V7h5.3l1-5Zm.6 7-1.2 6h4.4l1.2-6h-4.4Z";
const CHAT_ICON_PATH = "M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 5v2h12V8H6Zm0 4v2h8v-2H6Z";
const SEARCH_ICON_PATH = "M15.62 17.03a9 9 0 1 1 1.41-1.41l4.68 4.67a1 1 0 0 1-1.42 1.42l-4.67-4.68ZM17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z";

function focusPrimaryChannel(): void {
    const page = document.querySelector<HTMLElement>(".dockview-page-inner");
    const chat = page?.querySelector<HTMLElement>(":scope > [class*='chat_']") ?? null;
    const composer = chat?.querySelector<HTMLElement>("[contenteditable='true'][role='textbox']") ?? null;
    try {
        (composer ?? chat)?.focus({ preventScroll: true });
    } catch {
        (composer ?? chat)?.focus();
    }
}

/** The native main channel surface is always present below the unified header. It uses
 * normal tab geometry but is a permanent, non-closeable anchor rather than a Dock view. */
function primaryChannelTabElement(channel: any, nativeTitle: any) {
    const name = typeof channel?.name === "string" && channel.name ? channel.name : "Channel";
    const label = name;
    return React.createElement(
        "div",
        {
            key: "__primary_channel__",
            "data-tab-id": "__primary_channel__",
            className: "dockview-tab dockview-tab-primary",
            role: "tab",
            "aria-current": "page",
            title: label,
            draggable: false,
            onClick: focusPrimaryChannel,
            onContextMenu: (event: any) => {
                if (!openNativeChannelMenu(event, channel?.id)) return;
                event.preventDefault();
                event.stopPropagation();
            }
        },
        nativeTitle != null
            ? React.createElement("div", { key: "native-title", className: "dockview-tab-native-title" }, nativeTitle)
            : [
                React.createElement(
                    "svg",
                    { key: "glyph", className: "dockview-tab-icon", width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                    React.createElement("path", { fill: "currentColor", d: CHANNEL_ICON_PATH })
                ),
                tabLabelElement(label)
            ]
    );
}

/** A file-type glyph for a tab. SIZE PARITY with the single-window header's leading
 *  glyph (20px) — a tab must never shrink any element vs the pre-tab header. */
function tabIcon(type: ContentType) {
    return React.createElement(
        "svg",
        { key: "glyph", className: "dockview-tab-icon", width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
        ...iconPaths(type)
    );
}

/** A per-tab ghost icon control (the ✕) — flat, borderless, at a tab's right edge.
 *  Distinct from the tab body so its click never bubbles into a tab switch. SIZE
 *  PARITY with the single-window header's controls (20px). */
function tabCtrlBtn(opts: { key: string; cls: string; label: string; path: string; onClick: (e: any) => void; }) {
    return React.createElement(
        "button",
        {
            key: opts.key,
            type: "button",
            className: "dockview-tab-ctrl " + opts.cls,
            "aria-label": opts.label,
            title: opts.label,
            onClick: opts.onClick
        },
        React.createElement(
            "svg",
            { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: opts.path })
        )
    );
}

/** The permanent leftmost CONTEXT tab: a singleton that follows the current channel
 *  (member list in a guild, profile sidebar in a DM). It looks like a normal tab (icon +
 *  name, uniform-tab rule) but is NOT closable (no ✕), NOT draggable, and is rendered
 *  as a fixed sibling before the file-tab map. Clicking it
 *  makes the context tab the active view for this channel. */
function contextTabElement(channelId: string | null, active: boolean, unified: boolean) {
    // Group DM + guild channels show a member list ("Members"); a 1:1 DM shows the
    // profile sidebar ("Profile"). The kind resolver matches native per channel type.
    const channel = getChannelObject(channelId);
    const kind = contextKindFor(channelId);
    const isProfile = kind === "profile";
    const isGuild = !!channel?.guild_id;
    const label = isProfile
        ? STRINGS.tabs.profile
        : isGuild
            ? unified ? STRINGS.tabs.channelInfo : STRINGS.tabs.channel
            : STRINGS.tabs.members;
    const iconPath = isProfile
        ? PROFILE_ICON_PATH
        : isGuild
            ? CHANNEL_ICON_PATH
            : MEMBERS_ICON_PATH;
    return React.createElement(
        "div",
        {
            key: "__context__",
            "data-tab-id": "__context__",
            className: "dockview-tab dockview-tab-context" + (active ? " dockview-tab-active" : ""),
            role: "tab",
            "aria-selected": active,
            title: label,
            // NOT draggable: a drag must never displace the context tab.
            draggable: false,
            onClick: () => {
                hostActions().revealDock();
                hostActions().deactivateSearchView();
                setContextView(channelId, "channel");
                selectThreadPortal(null);
                requestRender();
            }
        },
        React.createElement(
            "svg",
            { key: "glyph", className: "dockview-tab-icon", width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: iconPath })
        ),
        tabLabelElement(label)
    );
}

/** The second permanent tab in a regular guild voice channel. It is deliberately the
 * same fixed-tab grammar as CHANNEL: non-closable, non-draggable, and before file tabs. */
function voiceChatTabElement(channelId: string, active: boolean) {
    const label = STRINGS.tabs.chat;
    return React.createElement(
        "div",
        {
            key: "__voice-chat__",
            "data-tab-id": "__voice-chat__",
            className: "dockview-tab dockview-tab-context" + (active ? " dockview-tab-active" : ""),
            role: "tab",
            "aria-selected": active,
            title: label,
            draggable: false,
            onClick: () => {
                hostActions().revealDock();
                hostActions().deactivateSearchView();
                setContextView(channelId, "voice-chat");
                selectThreadPortal(null);
                requestRender();
            }
        },
        React.createElement(
            "svg",
            { key: "glyph", className: "dockview-tab-icon", width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: CHAT_ICON_PATH })
        ),
        tabLabelElement(label)
    );
}

/** Search is a server-scoped singleton fixed to the header's right side, outside the
 * horizontally scrolling content strip. Its close button invokes Discord's original
 * search close control so native query/filter state remains the sole source of truth. */
function searchTabElement(channelId: string, active: boolean) {
    const label = STRINGS.tabs.search;
    const query = getNativeSearchQuery(channelId);
    return React.createElement(
        "div",
        {
            key: "__search__",
            "data-tab-id": "__search__",
            className: "dockview-tab dockview-tab-context dockview-tab-search" + (active ? " dockview-tab-active" : ""),
            role: "tab",
            "aria-selected": active,
            title: query || label,
            draggable: false,
            onClick: () => {
                activateNativeSearchResults(channelId);
            }
        },
        React.createElement(
            "svg",
            { key: "glyph", className: "dockview-tab-icon", width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: SEARCH_ICON_PATH })
        ),
        tabLabelElement(label),
        tabCtrlBtn({
            key: "close",
            cls: "dockview-tab-close",
            label: STRINGS.tabs.close,
            path: TAB_CLOSE_PATH,
            onClick: (event: any) => {
                event.stopPropagation();
                closeNativeSearchResults(channelId);
            }
        })
    );
}

/** Tabs row (browser-tab grammar). The leftmost tab is always the singleton CONTEXT tab
 *  (member list / profile — non-closable, non-draggable); after it come the channel's
 *  file tabs. A file tab carries a ✕ acting on THAT window (closeTab — active or not;
 *  closing the last file tab falls back to the context tab as the default view). The
 *  active file tab shows its ✕ at rest; inactive tabs reveal it on hover (CSS). A file
 *  tab's right-click menu contains lifecycle actions only. */
export function DockTabs({ unified = false, onOverflowChange }: {
    unified?: boolean;
    onOverflowChange?: (overflowing: boolean) => void;
} = {}) {
    const { useCallback, useEffect, useRef, useLayoutEffect } = React;
    const stripRef = useRef(null as HTMLElement | null);
    const tabWindows = getWindows().filter(isRealTab);
    const tabIds = tabWindows.map(tab => tab.id).join("\u0000");
    const channelId = getCurrentChannelMemId();
    const channel = getChannelObject(channelId);
    const contextView = getDockContextView(channelId);
    const ctxActive = contextView != null;
    const activeId = getActiveWindowId();
    // A file tab is "active" only when the context tab is NOT the active view.
    const fileActiveId = ctxActive ? null : activeId;
    const revealActive = useCallback(() => {
        const strip = stripRef.current;
        if (!strip) return;
        const active = strip.querySelector<HTMLElement>(".dockview-tab-active");
        if (!active) return;
        const left = active.offsetLeft;
        const right = left + active.offsetWidth;
        if (left < strip.scrollLeft) strip.scrollLeft = left;
        else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
    }, []);
    // offsetLeft/offsetWidth can force layout. Read them only when selection/list identity
    // changes; the ResizeObserver below covers actual geometry changes.
    useLayoutEffect(revealActive, [revealActive, fileActiveId, tabIds]);
    useEffect(() => {
        const strip = stripRef.current;
        if (!strip || !onOverflowChange) return;
        const report = () => {
            onOverflowChange(strip.scrollWidth > strip.clientWidth + 1);
            revealActive();
        };
        report();
        const observer = typeof ResizeObserver === "function" ? new ResizeObserver(report) : null;
        observer?.observe(strip);
        for (const tab of strip.querySelectorAll<HTMLElement>("[data-tab-id]")) observer?.observe(tab);
        return () => observer?.disconnect();
    }, [onOverflowChange, revealActive, tabIds]);
    const fixedTabs = channelId != null && !unified
        ? [
            contextTabElement(channelId, contextView === "channel", unified),
            ...(channel?.guild_id && channel.type === 2
                ? [voiceChatTabElement(channelId, contextView === "voice-chat")]
                : [])
        ]
        : [];
    return React.createElement(
        "div",
        {
            className: "dockview-tabs",
            role: "tablist",
            ref: stripRef,
            onWheel: (event: any) => {
                const strip = stripRef.current;
                if (!strip || strip.scrollWidth <= strip.clientWidth) return;
                const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
                if (!delta) return;
                strip.scrollLeft += delta;
                event.preventDefault();
            }
        },
        ...fixedTabs,
        ...tabWindows.map(w => {
            const isActive = w.id === fileActiveId;
            // An empty window (no file yet) shows the short product name, not the long
            // empty-card sentence.
            const label = (w.content.name as string | null) || STRINGS.tabs.untitled;
            // Right-click any tab → lifecycle actions for THAT tab in place. Opening
            // the menu never activates an inactive target.
            const onContextMenu = (e: any) => {
                e.preventDefault();
                e.stopPropagation();
                ContextMenuApi.openContextMenu(e, () => React.createElement(DockTabMenu, { win: w }));
            };
            return React.createElement(
                "div",
                {
                    key: w.id,
                    "data-tab-id": w.id,
                    className: "dockview-tab"
                        + (isActive ? " dockview-tab-active" : ""),
                    role: "tab",
                    "aria-selected": isActive,
                    title: label,
                    draggable: false,
                    onClick: () => {
                        // The unified strip remains visible when F9 collapses the
                        // secondary pane. Picking any secondary tab restores that pane,
                        // including when the chosen file was already the active binding.
                        hostActions().revealDock();
                        hostActions().deactivateSearchView();
                        // Selecting a file tab makes it the active view (clears the
                        // context-tab default for this channel).
                        setContextActive(channelId, false);
                        switchToWindow(w.id);
                        // switchToWindow no-ops if this window is already the active
                        // binding (e.g. we were on the context tab over the same window);
                        // force the repaint so the view swaps off the context tab.
                        requestRender();
                    },
                    onAuxClick: (e: any) => {
                        if (e.button !== 1) return;
                        e.preventDefault();
                        e.stopPropagation();
                        closeTab(w.id);
                    },
                    onContextMenu
                },
                tabIcon(w.content.type),
                tabLabelElement(label),
                tabCtrlBtn({
                    key: "close",
                    cls: "dockview-tab-close",
                    label: STRINGS.tabs.close,
                    path: TAB_CLOSE_PATH,
                    onClick: (e: any) => {
                        e.stopPropagation();
                        closeTab(w.id);
                    }
                })
            );
        })
    );
}

function menuTabGlyph(type: ContentType | "search" | null) {
    return React.createElement(
        "svg",
        { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true, className: "dockview-menu-icon" },
        ...(type === "search"
            ? [React.createElement("path", { key: "search", fill: "currentColor", d: SEARCH_ICON_PATH })]
            : type == null
            ? [React.createElement("path", { key: "channel", fill: "currentColor", d: CHANNEL_ICON_PATH })]
            : iconPaths(type))
    );
}

function tabListLabel(label: string, type: ContentType | "search" | null, id: string | null, active: boolean) {
    return React.createElement(
        "div",
        { className: "dockview-tab-list-label", title: label },
        menuTabGlyph(type),
        React.createElement("span", { className: "dockview-tab-list-label-text" }, label),
        React.createElement(
            "div",
            { className: "dockview-tab-list-trailing" },
            active
                ? React.createElement(
                    "svg",
                    { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", "aria-label": STRINGS.tabs.active },
                    React.createElement("path", { fill: "currentColor", d: TAB_ACTIVE_PATH })
                )
                : null,
            id
                ? React.createElement(
                    "button",
                    {
                        type: "button",
                        className: "dockview-tab-list-close",
                        "aria-label": STRINGS.tabs.close,
                        title: STRINGS.tabs.close,
                        onClick: (event: any) => {
                            event.preventDefault();
                            event.stopPropagation();
                            closeTab(id);
                            ContextMenuApi.closeContextMenu();
                        }
                    },
                    React.createElement(
                        "svg",
                        { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                        React.createElement("path", { fill: "currentColor", d: TAB_CLOSE_PATH })
                    )
                )
                : null
        )
    );
}

function AllTabsMenu({ channel }: { channel: any; }) {
    const channelId = getCurrentChannelMemId();
    const contextView = getDockContextView(channelId);
    const activeId = contextView == null ? getActiveWindowId() : null;
    const channelName = typeof channel?.name === "string" && channel.name ? channel.name : "Channel";

    const entries: any[] = [
        React.createElement(Menu.MenuItem, {
            key: "primary",
            id: "dockview-all-tabs-primary",
            label: tabListLabel(channelName, null, null, false),
            action: focusPrimaryChannel
        }),
        React.createElement(Menu.MenuItem, {
            key: "context",
            id: "dockview-all-tabs-context",
            label: tabListLabel(STRINGS.tabs.channelInfo, null, null, contextView === "channel"),
            action: () => {
                hostActions().revealDock();
                hostActions().deactivateSearchView();
                setContextView(channelId, "channel");
                selectThreadPortal(null);
                requestRender();
            }
        }),
        ...(channelId != null && hasNativeSearchResults(channelId)
            ? [React.createElement(Menu.MenuItem, {
                key: "search",
                id: "dockview-all-tabs-search",
                label: tabListLabel(STRINGS.tabs.search, "search", null, contextView === "search"),
                action: () => {
                    activateNativeSearchResults(channelId);
                }
            })]
            : []),
        ...getWindows().filter(isRealTab).map(w => React.createElement(Menu.MenuItem, {
            key: w.id,
            id: `dockview-all-tabs-${w.id}`,
            label: tabListLabel(
                (w.content.name as string | null) || STRINGS.tabs.untitled,
                w.content.type,
                w.id,
                w.id === activeId
            ),
            action: () => {
                hostActions().revealDock();
                hostActions().deactivateSearchView();
                setContextActive(channelId, false);
                switchToWindow(w.id);
                requestRender();
            }
        }))
    ];

    return React.createElement(
        Menu.Menu,
        { navId: "dockview-all-tabs", className: "dockview-all-tabs-menu", onClose: ContextMenuApi.closeContextMenu },
        React.createElement(Menu.MenuGroup, null, ...entries)
    );
}

/** Engine-backed tab strip rendered inside Discord's original page-wide header. */
export function UnifiedHeaderTabs({ channel, nativeTitle }: { channel: any; nativeTitle: any; }) {
    const { useCallback, useEffect, useState } = React;
    const [, bump] = useState(0);
    const [overflowing, setOverflowing] = useState(false);
    const rerender = useCallback(() => bump((n: number) => n + 1), []);
    const reportOverflow = useCallback((next: boolean) => setOverflowing(next), []);
    useEffect(() => subscribeRender(rerender), [rerender]);
    const channelId = getCurrentChannelMemId();
    const contextView = getDockContextView(channelId);

    return React.createElement(
        "div",
        { className: "dockview-unified-tabs" },
        primaryChannelTabElement(channel, nativeTitle),
        channelId != null
            ? contextTabElement(channelId, contextView === "channel", true)
            : null,
        React.createElement(DockTabs, { unified: true, onOverflowChange: reportOverflow }),
        overflowing
            ? React.createElement(
                "button",
                {
                    type: "button",
                    className: "dockview-tab-list-button",
                    "aria-label": STRINGS.tabs.allTabs,
                    title: STRINGS.tabs.allTabs,
                    onClick: (event: any) => {
                        event.preventDefault();
                        event.stopPropagation();
                        ContextMenuApi.openContextMenu(event, () => React.createElement(AllTabsMenu, { channel }));
                    }
                },
                React.createElement(
                    "svg",
                    { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                    React.createElement("path", { fill: "currentColor", d: TAB_LIST_PATH })
                )
            )
            : null,
        channelId != null && hasNativeSearchResults(channelId)
            ? searchTabElement(channelId, isSearchSurfaceActive(channelId, getNativeSearchScopeId(channelId)))
            : null
    );
}
