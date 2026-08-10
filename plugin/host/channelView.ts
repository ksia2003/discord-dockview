/*
 * Narrow bridges into Discord's current Channel class.
 *
 * The layout patch already executes inside Channel.render(), so passing `this` to
 * captureChannelView is more stable than rediscovering the class through hashed DOM
 * classes/fibers. The live instance gives DockView one important native escape hatch:
 * `handleContextMenu`, which builds Discord's exact permission-aware channel/thread menu.
 *
 * The two header filters operate on already-created React elements/children. They remove
 * only the guild-channel topic subtitle and the toolbar child whose explicit React key is
 * "members"; DM/group-DM chrome and every other toolbar control pass through unchanged.
 */

import { React } from "@vencord/types/webpack/common";

import { requestRender } from "../engine/forceRender";

let channelView: any = null;
let channelHeaderSubtitle: { channelId: string; element: any; } | null = null;
let subtitleRenderQueued = false;

export function captureChannelView(instance: any): void {
    if (instance && typeof instance === "object") channelView = instance;
}

export function clearChannelView(): void {
    channelView = null;
    channelHeaderSubtitle = null;
}

export function filterChannelHeaderSubtitle(subtitle: any, channel: any): any {
    if (!channel?.guild_id) return subtitle;

    const channelId = typeof channel.id === "string" ? channel.id : null;
    if (channelId) {
        const changedChannel = channelHeaderSubtitle?.channelId !== channelId;
        channelHeaderSubtitle = { channelId, element: subtitle };

        // The Dock is a separate React root. On the first header render for a newly
        // selected channel, its native topic element is captured here after the Dock
        // may already have painted its parsed fallback. Repaint once in a microtask
        // (never synchronously during Discord's render) so the Dock adopts the exact
        // native element and its click/popout behaviour.
        if (changedChannel && !subtitleRenderQueued) {
            subtitleRenderQueued = true;
            queueMicrotask(() => {
                subtitleRenderQueued = false;
                requestRender();
            });
        }
    }

    return null;
}

/** The exact topic/subtitle element Discord created for its channel header. DockView
 * removes it from the main header, then renders this same element in Channel instead
 * of recreating Discord's click/popout interaction. */
export function getNativeChannelHeaderSubtitle(channelId: string): any {
    return channelHeaderSubtitle?.channelId === channelId
        ? channelHeaderSubtitle.element
        : null;
}

function withoutMemberToggle(node: any): any {
    if (Array.isArray(node)) {
        let changed = false;
        const children: any[] = [];
        for (const child of node) {
            const filtered = withoutMemberToggle(child);
            if (filtered !== child) changed = true;
            if (filtered != null) children.push(filtered);
        }
        return changed ? children : node;
    }
    if (!React.isValidElement(node)) return node;
    if ((node as any).key === "members") return null;

    const raw = (node as any).props?.children;
    if (raw == null) return node;
    const filtered = withoutMemberToggle(raw);
    return filtered === raw ? node : React.cloneElement(node, { children: filtered } as any);
}

export function filterChannelHeaderToolbar(toolbar: any, channel: any): any {
    if (!channel?.guild_id) return toolbar;
    // Current Discord builds return the toolbar as a flat array; older builds wrapped
    // it in a React element. Walk either shape and remove only the explicit native key.
    return withoutMemberToggle(toolbar);
}

/** Open Discord's own current-channel context menu at the supplied React mouse event.
 * Returns false if Discord remounted and the captured instance no longer matches. */
export function openNativeChannelMenu(event: any, channelId: string): boolean {
    const live = channelView;
    if (!live || live.props?.channel?.id !== channelId || typeof live.handleContextMenu !== "function") {
        return false;
    }
    try {
        live.handleContextMenu(event);
        return true;
    } catch {
        return false;
    }
}
