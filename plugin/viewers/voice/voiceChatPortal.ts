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

import { selectDockHost } from "../../host/hostSelection";
import {
    OWNED_PORTAL_HIDDEN_ATTRIBUTE, registerOwnedPortal, unregisterOwnedPortal
} from "../../host/ownedPortalVisibility";
import {
    buildVoiceChatProps, getVoiceChatProviderStack, getVoiceChatType,
    subscribeVoiceChatReadiness
} from "../../host/voiceChatCapture";
import { loadThreadMessages } from "../../host/slotComponents";
import {
    captureChatScrollAnchor, restoreChatScrollAnchorAcrossFrames,
    restoreRetainedChatScrollAnchor, retainChatScrollAnchor
} from "../chatScrollAnchor";
import { createInitialRenderRetry, type InitialRenderRetryController } from "../initialRenderRetry";

interface Portal {
    channelId: string;
    node: HTMLElement;
    root: Root;
    rendered: boolean;
    renderRetry: InitialRenderRetryController | null;
    readinessCancel: (() => void) | null;
}

const portals = new Map<string, Portal>();
let visibleChannel: string | null = null;
let syncRaf = 0;
let showSeq = 0;
let BoundaryClass: any = null;

function targetEl(): HTMLElement | null {
    const dock = selectDockHost();
    return (dock?.querySelector(".dockview-voice-chat-slot") as HTMLElement) || null;
}

function positionOver(node: HTMLElement, target: HTMLElement | null): void {
    const preserveHiddenBox = node.hasAttribute(OWNED_PORTAL_HIDDEN_ATTRIBUTE);
    if (!target) {
        if (!preserveHiddenBox) {
            retainChatScrollAnchor(node);
            node.style.display = "none";
        }
        return;
    }
    const r = target.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
        if (!preserveHiddenBox) {
            retainChatScrollAnchor(node);
            node.style.display = "none";
        }
        return;
    }
    const width = Math.round(r.width);
    const height = Math.round(r.height);
    const priorWidth = parseFloat(node.style.width) || 0;
    const priorHeight = parseFloat(node.style.height) || 0;
    const resizing = node.style.display !== "none"
        && (priorWidth !== width || priorHeight !== height);
    const resizeAnchor = resizing ? captureChatScrollAnchor(node) : null;
    node.style.display = "flex";
    node.style.left = `${Math.round(r.left)}px`;
    node.style.top = `${Math.round(r.top)}px`;
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;
    if (resizeAnchor) restoreChatScrollAnchorAcrossFrames(node, resizeAnchor);
    else restoreRetainedChatScrollAnchor(node);
}

function syncLoop(): void {
    syncRaf = 0;
    if (!visibleChannel) return;
    syncVisibleVoiceChatPortalNow();
    syncRaf = (window.requestAnimationFrame || ((cb: FrameRequestCallback) => window.setTimeout(cb, 16)))(syncLoop);
}

/** Same-turn geometry seam used by F9 and real window resizes. The animation-frame
 * loop remains the backstop for ambient Discord layout shifts. */
export function syncVisibleVoiceChatPortalNow(): void {
    if (!visibleChannel) return;
    const portal = portals.get(visibleChannel);
    if (portal) positionOver(portal.node, targetEl());
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

function renderPortal(portal: Portal): boolean {
    try {
        const type = getVoiceChatType();
        const props = type ? buildVoiceChatProps(portal.channelId) : null;
        if (!type || !props) return false;
        const bare = React.createElement(type, props);
        let tree: any = bare;
        const stack = getVoiceChatProviderStack();
        if (stack) {
            for (const provider of stack) {
                tree = React.createElement(provider.type, { value: provider.value }, tree);
            }
            tree = React.createElement(portalBoundary(), { fallback: bare }, tree);
        }
        portal.root.render(
            React.createElement("div", { className: "dockview-voice-chat-portal-inner" }, tree)
        );
        return true;
    } catch { return false; /* isolated root failure must not affect the dock */ }
}

/** A voice chat can open before Discord's native type/props capture completes. Retry
 * only until the first successful tree lands; later surface switches must keep the
 * mounted composer and virtualizer state intact. */
function scheduleInitialRender(portal: Portal): void {
    if (portal.rendered) return;
    const request = (callback: () => void): number =>
        window.requestAnimationFrame
            ? window.requestAnimationFrame(() => callback())
            : window.setTimeout(callback, 16);
    const cancel = (handle: number): void =>
        (window.cancelAnimationFrame || window.clearTimeout)(handle);
    if (!portal.renderRetry) portal.renderRetry = createInitialRenderRetry({
        isCurrent: () => portals.get(portal.channelId) === portal,
        isRendered: () => portal.rendered,
        render: () => renderPortal(portal),
        setRendered: rendered => { portal.rendered = rendered; },
        request,
        cancel
    });
    else portal.renderRetry.arm();
}

function cancelInitialRender(portal: Portal): void {
    portal.renderRetry?.cancel();
    portal.renderRetry = null;
}

function cancelReadiness(portal: Portal): void {
    portal.readinessCancel?.();
    portal.readinessCancel = null;
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
            portal = {
                channelId,
                node,
                root: createRoot(node),
                rendered: false,
                renderRetry: null,
                readinessCancel: null
            };
            portals.set(channelId, portal);
            portal.readinessCancel = subscribeVoiceChatReadiness(readyChannelId => {
                if (
                    portals.get(channelId) !== portal
                    || portal.rendered
                    || (readyChannelId != null && readyChannelId !== channelId)
                ) return;
                // A readiness event after the bounded window is the only way to arm a
                // fresh bounded window; it cannot create a hot infinite RAF loop.
                portal.renderRetry?.arm();
            });
        } catch {
            if (node) {
                unregisterOwnedPortal(node);
                node.remove();
            }
            return;
        }
    }
    // Show retries are allowed only until the first native tree lands. Afterwards the
    // mounted subtree remains untouched across Dock surface switches.
    if (!portal.rendered) {
        portal.rendered = renderPortal(portal);
        if (!portal.rendered) scheduleInitialRender(portal);
        else {
            cancelInitialRender(portal);
            cancelReadiness(portal);
        }
    }
}

export function refreshVoiceChatPortal(channelId: string): void {
    const portal = portals.get(channelId);
    if (!portal || portal.rendered) return;
    portal.rendered = renderPortal(portal);
    if (!portal.rendered) scheduleInitialRender(portal);
    else {
        cancelInitialRender(portal);
        cancelReadiness(portal);
    }
}

export function showVoiceChatPortal(channelId: string): number {
    ensureVoiceChatPortal(channelId);
    visibleChannel = channelId;
    for (const [id, portal] of portals) {
        if (id === channelId) positionOver(portal.node, targetEl());
        else {
            retainChatScrollAnchor(portal.node);
            portal.node.style.display = "none";
        }
    }
    startSync();
    return ++showSeq;
}

export function releaseVoiceChatPortals(claim: number): void {
    if (claim === showSeq) hideVoiceChatPortals();
}

export function hideVoiceChatPortals(): void {
    visibleChannel = null;
    for (const portal of portals.values()) {
        retainChatScrollAnchor(portal.node);
        portal.node.style.display = "none";
    }
    stopSync();
}

export function destroyAllVoiceChatPortals(): void {
    const all = Array.from(portals.values());
    portals.clear();
    visibleChannel = null;
    stopSync();
    for (const portal of all) {
        const { root, node } = portal;
        cancelInitialRender(portal);
        cancelReadiness(portal);
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
