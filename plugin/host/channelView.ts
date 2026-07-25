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

let channelView: any = null;

export function captureChannelView(instance: any): void {
    if (instance && typeof instance === "object") channelView = instance;
}

export function clearChannelView(): void {
    channelView = null;
}

export function filterChannelHeaderSubtitle(subtitle: any, channel: any): any {
    return channel?.guild_id ? null : subtitle;
}

export function filterChannelHeaderToolbar(toolbar: any, channel: any): any {
    if (!channel?.guild_id || !React.isValidElement(toolbar)) return toolbar;
    const raw = (toolbar as any).props?.children;
    const children = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    const filtered = children.filter(child => child?.key !== "members");
    if (filtered.length === children.length) return toolbar;
    return React.cloneElement(toolbar, { children: filtered });
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
