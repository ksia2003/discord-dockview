/*
 * Page-wide channel header bridge (ordinary guild text channels only).
 *
 * Discord creates the real channel header inside the primary chat column. This bridge
 * retains that component as the first row of the page-inner grid, replaces its title slot
 * with the unified tabs, and portals its native toolbar into Channel info. The chat column
 * and Dock become the second row; no overlay or placeholder header remains.
 *
 * Header movement is handshake-gated: captureUnifiedChannelHeader does nothing until
 * renderDockRail has run for the same Channel instance. If only one source anchor
 * survives an upstream change, Discord's original header therefore remains visible.
 */

import { React, ReactDOM } from "@vencord/types/webpack/common";

import { requestRender } from "../engine/forceRender";
import { UnifiedHeaderTabs } from "../ui/DockTabs";

let active = false;
const knownInstances = new Set<any>();
const railSeen = new WeakSet<object>();
const unifiedHeaders = new WeakMap<object, any>();
let channelHeaderTitle: {
    channelId: string;
    channelName: string;
    title: any;
} | null = null;
let titleRenderQueued = false;
let toolbarTarget: { channelId: string; element: HTMLElement; } | null = null;

export function usesUnifiedChannelHeader(channel: any): boolean {
    // First feedback slice: every non-standard channel surface remains untouched.
    return active && !!channel?.guild_id && channel.type === 0;
}

/** True only after the current channel's native header was actually transformed. The
 * eligibility check alone is insufficient: if Discord changes the patch seam, the local
 * Dock strip must remain available instead of disappearing with a header that never moved. */
export function hasUnifiedChannelHeader(channelId: string | null): boolean {
    return active && channelId != null && channelHeaderTitle?.channelId === channelId;
}

function eligible(instance: any): boolean {
    return usesUnifiedChannelHeader(instance?.props?.channel);
}

function refresh(instance: any): void {
    queueMicrotask(() => {
        try { instance.forceUpdate?.(); } catch { /* Discord may have retired it */ }
    });
}

/** Restore Discord's untouched header while the plugin is stopped, and re-arm every
 * channel-view instance already rendered before start() when the plugin comes back. */
export function setUnifiedHeaderActive(value: boolean): void {
    if (active === value) return;
    active = value;
    if (!value) {
        channelHeaderTitle = null;
        toolbarTarget = null;
    }
    for (const instance of knownInstances) {
        if (value && eligible(instance)) railSeen.add(instance);
        else unifiedHeaders.delete(instance);
        refresh(instance);
    }
}

function captureChannelHeaderTitle(channel: any, title: any): void {
    const channelId = typeof channel?.id === "string" ? channel.id : null;
    if (!channelId) return;
    const channelName = typeof channel?.name === "string" ? channel.name : "";
    const visibleIdentityChanged = channelHeaderTitle?.channelId !== channelId
        || channelHeaderTitle.channelName !== channelName;

    // Keep the freshest native element for the next ordinary Dock repaint, but do not
    // repaint the member list merely because Discord recreated an equivalent title node.
    channelHeaderTitle = { channelId, channelName, title };
    if (!visibleIdentityChanged) return;
    if (titleRenderQueued) return;
    titleRenderQueued = true;
    queueMicrotask(() => {
        titleRenderQueued = false;
        requestRender();
    });
}

/** Exact title element produced by Discord for the current unified header. */
export function getUnifiedChannelHeaderTitle(channelId: string): any | null {
    return channelHeaderTitle?.channelId === channelId ? channelHeaderTitle.title : null;
}

/** ChannelOverview lives in DockView's detached root. Its ref registers the DOM target;
 * the original Discord header tree keeps ownership of the toolbar and portals it there. */
export function bindUnifiedChannelToolbarTarget(
    channelId: string,
    element: HTMLElement | null,
    previousElement: HTMLElement | null
): void {
    if (element) {
        if (toolbarTarget?.channelId === channelId && toolbarTarget.element === element) return;
        toolbarTarget = { channelId, element };
    } else {
        // Discord can retire a cached ChannelOverview after a newer instance for the same
        // channel has already mounted. Its stale null-ref must not clear the live target.
        if (toolbarTarget?.channelId !== channelId || toolbarTarget.element !== previousElement) return;
        toolbarTarget = null;
    }
    // The target belongs to DockView's detached root. Once its ref commits, repaint the
    // native header tree so the portal is created (or removed) from its original owner.
    for (const instance of knownInstances) {
        if (eligible(instance)) refresh(instance);
    }
}

function UnifiedChannelToolbarPortal({ channelId, toolbar }: { channelId: string; toolbar: any; }) {
    const target = toolbarTarget?.channelId === channelId && toolbarTarget.element.isConnected
        ? toolbarTarget.element
        : null;
    return target && toolbar != null ? ReactDOM.createPortal(toolbar, target) : null;
}

/** A non-null toolbar seed tells Discord's native HeaderBar to construct its own Search
 * component. The real channel actions are still portaled to Channel info; CSS hides this
 * inert seed, leaving only native Search at the fixed right edge of the unified header. */
function NativeSearchToolbarSeed() {
    return React.createElement("span", {
        className: "dockview-native-search-seed",
        "aria-hidden": true
    });
}

function transformNativeHeader(header: any, channel: any): any | null {
    if (!React.isValidElement(header)) return null;
    const outerChildren = React.Children.toArray((header as any).props?.children);
    const themed = outerChildren[0] as any;
    const renderThemed = themed?.props?.children;
    if (!React.isValidElement(themed) || typeof renderThemed !== "function") return null;

    const transformedThemed = React.cloneElement(themed, {
        children: (...args: any[]) => {
            const nativeHeader = renderThemed(...args);
            if (!React.isValidElement(nativeHeader)) return nativeHeader;
            // Preserve the native Header component, toolbar ownership, popouts, theme,
            // aria label, and store subscriptions. The exact native title element becomes
            // the permanent first tab; the surrounding flexible slot becomes the strip.
            const nativeTitle = (nativeHeader as any).props?.children;
            const nativeToolbar = (nativeHeader as any).props?.toolbar;
            const channelId = String(channel.id);
            captureChannelHeaderTitle(channel, nativeTitle);
            return React.cloneElement(nativeHeader, {
                children: React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(UnifiedHeaderTabs, { channel, nativeTitle }),
                    React.createElement(UnifiedChannelToolbarPortal, { channelId, toolbar: nativeToolbar })
                ),
                // Channel info owns the exact native action toolbar. A non-null inert seed
                // preserves HeaderBar's separately-created native Search component without
                // duplicating the channel actions in the page-wide strip.
                toolbar: React.createElement(NativeSearchToolbarSeed)
            } as any);
        }
    } as any);

    return React.cloneElement(header, {
        children: [transformedThemed, ...outerChildren.slice(1)]
    } as any);
}

export function captureUnifiedChannelHeader(header: any, instance: any): any {
    if (!eligible(instance) || !railSeen.has(instance) || header == null) {
        if (instance && typeof instance === "object") unifiedHeaders.delete(instance);
        return header;
    }

    const transformed = transformNativeHeader(header, instance.props.channel);
    if (!transformed) {
        unifiedHeaders.delete(instance);
        return header;
    }

    unifiedHeaders.set(instance, transformed);
    return null;
}

export function markUnifiedRailSeen(instance: any): void {
    if (!instance || typeof instance !== "object") return;
    knownInstances.add(instance);
    if (!eligible(instance) || railSeen.has(instance)) return;
    railSeen.add(instance);
    refresh(instance);
}

export function getUnifiedChannelHeader(instance: any): any | null {
    return eligible(instance) ? unifiedHeaders.get(instance) ?? null : null;
}
