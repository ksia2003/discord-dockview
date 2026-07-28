/*
 * Isolated body-level portals for regular voice-channel text chat.
 *
 * Like thread chat, Discord's chat surface cannot safely be nested in DockView's React
 * root (that root itself lives inside Discord's tree). Each voice channel therefore keeps
 * one body-level root aligned over the dock body. Keeping roots mounted while hidden
 * preserves message scroll and composer drafts across CHANNEL/file/CHAT tab switches.
 */

import { createRoot, React } from "@vencord/types/webpack/common";
import type { Root } from "react-dom/client";

import { liveHost } from "../../host/mount";
import { registerOwnedPortal, unregisterOwnedPortal } from "../../host/ownedPortalVisibility";
import {
    buildVoiceChatProps, getVoiceChatProviderStack, getVoiceChatType
} from "../../host/voiceChatCapture";
import { loadThreadMessages } from "../../host/slotComponents";

interface Portal {
    channelId: string;
    node: HTMLElement;
    root: Root;
}

const portals = new Map<string, Portal>();
let visibleChannel: string | null = null;
let syncRaf = 0;
let showSeq = 0;
let BoundaryClass: any = null;

function targetEl(): HTMLElement | null {
    const bound = liveHost();
    const dock = bound?.isConnected ? bound : document.getElementById("dockview-root");
    return (dock?.querySelector(".dockview-voice-chat-slot") as HTMLElement) || null;
}

function positionOver(node: HTMLElement, target: HTMLElement | null): void {
    if (!target) { node.style.display = "none"; return; }
    const r = target.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) { node.style.display = "none"; return; }
    node.style.display = "flex";
    node.style.left = `${Math.round(r.left)}px`;
    node.style.top = `${Math.round(r.top)}px`;
    node.style.width = `${Math.round(r.width)}px`;
    node.style.height = `${Math.round(r.height)}px`;
}

function syncLoop(): void {
    syncRaf = 0;
    if (!visibleChannel) return;
    const portal = portals.get(visibleChannel);
    if (portal) positionOver(portal.node, targetEl());
    syncRaf = (window.requestAnimationFrame || ((cb: FrameRequestCallback) => window.setTimeout(cb, 16)))(syncLoop);
}

function startSync(): void {
    if (!syncRaf) syncRaf = (window.requestAnimationFrame || ((cb: FrameRequestCallback) => window.setTimeout(cb, 16)))(syncLoop);
}

function stopSync(): void {
    if (!syncRaf) return;
    (window.cancelAnimationFrame || window.clearTimeout)(syncRaf);
    syncRaf = 0;
}

function portalBoundary(): any {
    if (BoundaryClass) return BoundaryClass;
    class VoiceChatBoundary extends (React.Component as any) {
        declare props: any;
        state = { failed: false };
        static getDerivedStateFromError() { return { failed: true }; }
        componentDidCatch() { /* bare fallback below */ }
        render() {
            return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
        }
    }
    BoundaryClass = VoiceChatBoundary;
    return BoundaryClass;
}

function renderPortal(portal: Portal): void {
    try {
        const type = getVoiceChatType();
        const props = type ? buildVoiceChatProps(portal.channelId) : null;
        let tree: any = null;
        if (type && props) {
            const bare = React.createElement(type, props);
            tree = bare;
            const stack = getVoiceChatProviderStack();
            if (stack) {
                for (const provider of stack) {
                    tree = React.createElement(provider.type, { value: provider.value }, tree);
                }
                tree = React.createElement(portalBoundary(), { fallback: bare }, tree);
            }
        }
        portal.root.render(
            React.createElement("div", { className: "dockview-voice-chat-portal-inner" }, tree)
        );
    } catch { /* isolated root failure must not affect the dock */ }
}

export function ensureVoiceChatPortal(channelId: string): void {
    if (!channelId) return;
    try { loadThreadMessages(channelId); } catch { /* messages can load later */ }
    let portal = portals.get(channelId);
    if (!portal) {
        let node: HTMLElement | null = null;
        try {
            node = document.createElement("div");
            node.className = "dockview-voice-chat-portal";
            node.style.display = "none";
            document.body.appendChild(node);
            registerOwnedPortal(node);
            portal = { channelId, node, root: createRoot(node) };
            portals.set(channelId, portal);
        } catch {
            if (node) {
                unregisterOwnedPortal(node);
                node.remove();
            }
            return;
        }
    }
    renderPortal(portal);
}

export function refreshVoiceChatPortal(channelId: string): void {
    const portal = portals.get(channelId);
    if (portal) renderPortal(portal);
}

export function showVoiceChatPortal(channelId: string): number {
    ensureVoiceChatPortal(channelId);
    visibleChannel = channelId;
    for (const [id, portal] of portals) {
        if (id === channelId) positionOver(portal.node, targetEl());
        else portal.node.style.display = "none";
    }
    startSync();
    return ++showSeq;
}

export function releaseVoiceChatPortals(claim: number): void {
    if (claim === showSeq) hideVoiceChatPortals();
}

export function hideVoiceChatPortals(): void {
    visibleChannel = null;
    for (const portal of portals.values()) portal.node.style.display = "none";
    stopSync();
}

export function destroyAllVoiceChatPortals(): void {
    const all = Array.from(portals.values());
    portals.clear();
    visibleChannel = null;
    stopSync();
    for (const { root, node } of all) {
        unregisterOwnedPortal(node);
        Promise.resolve().then(() => {
            try { root.unmount(); } catch { /* ignore */ }
            try { node.remove(); } catch { /* ignore */ }
        });
    }
}

export function liveVoiceChatPortals(): string[] {
    return Array.from(portals.keys());
}
