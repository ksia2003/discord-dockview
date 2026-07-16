/*
 * Thread-chat portals — the isolated render surface for a thread tab's chat.
 *
 * WHY THIS EXISTS (load-bearing, proven on the rig): a thread tab renders Discord's full
 * channel-view chat (captured from the main chat). Rendered as a child of DockPanel it
 * wedges the renderer in a React reconciliation loop — the dock's React root is bound to
 * `#dockview-root`, a node NESTED inside Discord's own React tree (the layout patch), and a
 * second channel-view chat inside that nested root loops against the main chat. The IDENTICAL
 * component + props renders + accepts input perfectly in a React root bound to a node under
 * `document.body` (NOT nested in Discord's tree). So each thread chat gets its OWN createRoot
 * on a `document.body`-level node, positioned as a fixed overlay tracking the dock body's
 * rect. This is the same reasoning host/mount.ts uses (the dock gets its own root off
 * Discord's churn) taken one level further for the chat.
 *
 * One portal per thread tab (keyed by thread id), like the web viewer keeps one <webview>
 * per window — so each thread keeps its composer draft + scroll while hidden. Only the ACTIVE
 * thread tab's portal is shown (positioned over the dock body); the rest are display:none.
 *
 * Positioning: while a portal is visible a rAF loop syncs its fixed rect to the live
 * `.dockview-body` bounding box (cheap; only runs while a thread tab is the active view), so
 * a dock resize / window resize / layout shift keeps the chat aligned with no per-event
 * wiring. The loop stops when no portal is visible.
 *
 * NO module-top React.createElement / webpack access — createRoot + React are touched only
 * inside the functions below.
 */

import { createRoot, React } from "@webpack/common";
import type { Root } from "react-dom/client";

import { buildThreadProps, getChatType, loadThreadMessages } from "../../host/slotComponents";

interface Portal {
    node: HTMLElement;
    root: Root;
    threadId: string;
}

// One portal per thread id. Survives DockPanel repaints (it's not in DockPanel's tree).
const portals = new Map<string, Portal>();
// The thread whose portal is currently shown (positioned over the dock body), or null.
let visibleThread: string | null = null;
// The rAF handle for the position-sync loop (runs only while a portal is visible).
let syncRaf = 0;

const OVERLAY_CLASS = "dockview-thread-portal";

/** The dock body element the portal overlays (the viewer body area). */
function dockBodyEl(): HTMLElement | null {
    const dock = document.getElementById("dockview-root");
    return (dock?.querySelector(".dockview-body") as HTMLElement) || null;
}

/** Position `node` as a fixed overlay exactly over the dock body's current rect. Hidden
 *  (display:none) when the dock body isn't present / has no area. */
function positionOver(node: HTMLElement, body: HTMLElement | null): void {
    if (!body) { node.style.display = "none"; return; }
    const r = body.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) { node.style.display = "none"; return; }
    node.style.display = "flex";
    node.style.left = `${Math.round(r.left)}px`;
    node.style.top = `${Math.round(r.top)}px`;
    node.style.width = `${Math.round(r.width)}px`;
    node.style.height = `${Math.round(r.height)}px`;
}

/** The rAF loop: keep the visible portal aligned to the live dock body rect. Self-stops
 *  when no portal is visible. */
function syncLoop(): void {
    syncRaf = 0;
    if (!visibleThread) return;
    const p = portals.get(visibleThread);
    if (p) positionOver(p.node, dockBodyEl());
    syncRaf = (window.requestAnimationFrame || ((cb: any) => setTimeout(cb, 16)))(syncLoop);
}

function startSync(): void {
    if (!syncRaf) syncRaf = (window.requestAnimationFrame || ((cb: any) => setTimeout(cb, 16)))(syncLoop);
}
function stopSync(): void {
    if (syncRaf) { (window.cancelAnimationFrame || clearTimeout)(syncRaf); syncRaf = 0; }
}

/** (Re)render a portal's chat with the current thread props. Shows an empty stub if the
 *  chat type isn't captured yet (the ThreadBody drives the capture poll and calls
 *  refreshThreadPortal once it lands). Guarded — a render throw stays contained to the
 *  isolated portal root and never escapes to the dock. */
function renderPortal(p: Portal): void {
    try {
        const type = getChatType();
        if (!type) { p.root.render(React.createElement("div", { className: "dockview-thread-portal-inner" })); return; }
        const props = buildThreadProps(p.threadId);
        p.root.render(props
            ? React.createElement("div", { className: "dockview-thread-portal-inner" }, React.createElement(type, props))
            : React.createElement("div", { className: "dockview-thread-portal-inner" }));
    } catch { /* the chat failed to render into its isolated root — the dock is unaffected */ }
}

/** Ensure a portal exists for `threadId` (create its body node + isolated root on first
 *  use), render the thread chat into it, and kick the one-time message fetch. Idempotent. */
export function ensureThreadPortal(threadId: string): void {
    if (!threadId) return;
    try { loadThreadMessages(threadId); } catch { /* messages fill when reachable */ }
    let p = portals.get(threadId);
    if (!p) {
        try {
            const node = document.createElement("div");
            node.className = OVERLAY_CLASS;
            node.style.display = "none";
            document.body.appendChild(node);
            p = { node, root: createRoot(node), threadId };
            portals.set(threadId, p);
        } catch { return; /* couldn't create the isolated root — dock stays intact */ }
    }
    renderPortal(p);
}

/** Re-render the ACTIVE portal's chat (e.g. after a late chat-type capture). No-op if the
 *  thread has no portal. */
export function refreshThreadPortal(threadId: string): void {
    const p = portals.get(threadId);
    if (p) renderPortal(p);
}

/** Show `threadId`'s portal over the dock body and hide all others; start the position
 *  sync. Creates the portal first if needed. */
export function showThreadPortal(threadId: string): void {
    ensureThreadPortal(threadId);
    visibleThread = threadId;
    for (const [id, p] of portals) {
        if (id === threadId) positionOver(p.node, dockBodyEl());
        else p.node.style.display = "none";
    }
    startSync();
}

/** Hide every thread portal (a non-thread view is active) + stop the sync. The portals stay
 *  mounted (each keeps its draft/scroll) — they're just display:none. */
export function hideThreadPortals(): void {
    visibleThread = null;
    for (const p of portals.values()) p.node.style.display = "none";
    stopSync();
}

/** Tear down `threadId`'s portal entirely (its tab was closed): unmount the root + remove
 *  the node. */
export function destroyThreadPortal(threadId: string): void {
    const p = portals.get(threadId);
    if (!p) return;
    portals.delete(threadId);
    if (visibleThread === threadId) { visibleThread = null; stopSync(); }
    const { root, node } = p;
    // Unmount async — React forbids a synchronous unmount while a parent tree renders.
    Promise.resolve().then(() => { try { root.unmount(); } catch { /* ignore */ } try { node.remove(); } catch { /* ignore */ } });
}

/** Tear down ALL portals (plugin stop). */
export function destroyAllThreadPortals(): void {
    for (const id of Array.from(portals.keys())) destroyThreadPortal(id);
    visibleThread = null;
    stopSync();
}

/** The thread ids that currently have a live portal — for the debug surface / gates. */
export function livePortalThreads(): string[] {
    return Array.from(portals.keys());
}
