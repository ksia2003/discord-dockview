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
 * Positioning is event-driven. Explicit F9/window geometry changes synchronise in the
 * same turn, and a ResizeObserver coalesces ambient Dock body size changes into one frame.
 * A steady thread therefore performs no per-frame layout reads or style writes.
 *
 * NO module-top React.createElement / webpack access — createRoot + React are touched only
 * inside the functions below.
 */

import { createRoot, React } from "@vencord/types/webpack/common";
import type { Root } from "react-dom/client";

import { selectDockHost } from "../../host/hostSelection";
import {
    OWNED_PORTAL_HIDDEN_ATTRIBUTE, registerOwnedPortal, unregisterOwnedPortal
} from "../../host/ownedPortalVisibility";
import { buildThreadProps, getChatType, getProviderStack, loadThreadMessages } from "../../host/slotComponents";
import {
    captureChatScrollAnchor, restoreChatScrollAnchorAcrossFrames,
    restoreRetainedChatScrollAnchor, retainChatScrollAnchor
} from "../chatScrollAnchor";
import { createBoundedSettle } from "./portalSync";

interface Portal {
    node: HTMLElement;
    root: Root;
    threadId: string;
    rendered: boolean;
    renderRetryRaf: number;
}

// One portal per thread id. Survives DockPanel repaints (it's not in DockPanel's tree).
const portals = new Map<string, Portal>();
// The thread whose portal is currently shown (positioned over the dock body), or null.
let visibleThread: string | null = null;
// Resize work is frame-coalesced; unlike the old loop this handle is normally zero while
// the portal is steady.
let syncRaf = 0;
let syncObserver: ResizeObserver | null = null;
let observedBody: HTMLElement | null = null;
// After a show or a live-body identity change, re-sync a bounded number of frames so an
// E3 root retire/rebind (or a reveal that re-creates the dock tree) settles and the NEW
// .dockview-body is reacquired. Bounded — steady state stays zero-per-frame.
const settleSync = createBoundedSettle(
    (cb) => (window.requestAnimationFrame || ((c: FrameRequestCallback) => window.setTimeout(c, 16)))(cb),
    (h) => (window.cancelAnimationFrame || clearTimeout)(h)
);

const OVERLAY_CLASS = "dockview-thread-portal";

/** The dock body element the portal overlays (the viewer body area). Prefer the node the
 *  LIVE React root is bound to — during a channel-view two-instance overlap the document
 *  briefly holds two #dockview-root placeholders and getElementById returns whichever is
 *  first in document order (possibly the stale one); the live host is the dock the user
 *  actually sees. Fall back to the id lookup while unbound. */
function dockBodyEl(): HTMLElement | null {
    const dock = selectDockHost();
    return (dock?.querySelector(".dockview-body") as HTMLElement) || null;
}

/** Position `node` as a fixed overlay exactly over the dock body's current rect. While F9
 *  temporarily hides DockView, retain the last non-zero box under visibility:hidden so
 *  Discord's managed scroller never observes a 0x0 viewport and discards its anchor. In
 *  every other missing-target case the portal is genuinely inactive and may collapse. */
function positionOver(node: HTMLElement, body: HTMLElement | null): void {
    const preserveHiddenBox = node.hasAttribute(OWNED_PORTAL_HIDDEN_ATTRIBUTE);
    if (!body) {
        if (!preserveHiddenBox) {
            retainChatScrollAnchor(node);
            node.style.display = "none";
        }
        return;
    }
    const r = body.getBoundingClientRect();
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

function scheduleObservedSync(): void {
    if (syncRaf || !visibleThread) return;
    const raf = window.requestAnimationFrame || ((cb: FrameRequestCallback) => window.setTimeout(cb, 16));
    syncRaf = raf(() => {
        syncRaf = 0;
        syncVisibleThreadPortalNow();
    });
}

function observeBody(body: HTMLElement | null): void {
    if (body === observedBody && syncObserver) return;
    syncObserver?.disconnect();
    syncObserver = null;
    observedBody = body;
    if (!body || typeof ResizeObserver !== "function") return;
    syncObserver = new ResizeObserver(scheduleObservedSync);
    syncObserver.observe(body);
}

/** Synchronise in the caller's current layout turn. ResizeObserver is the ambient
 * backstop; explicit F9 and window geometry changes call this before the browser paints. */
export function syncVisibleThreadPortalNow(): void {
    if (!visibleThread) return;
    const p = portals.get(visibleThread);
    const body = dockBodyEl();
    if (body !== observedBody) {
        // The live body was replaced/rebound under us (E3 retire/rebind): the previous
        // ResizeObserver is bound to the retired node and can never fire for the new
        // one, so arm a bounded settle to reacquire the live node over the next frames.
        settleSync.arm();
    }
    observeBody(body);
    if (p) positionOver(p.node, body);
}

function startSync(): void {
    syncVisibleThreadPortalNow();
    // An explicit show (engine tab switch, F9 reveal) can race a body swap; a bounded
    // settle re-syncs the live rect for a few frames and then stops.
    settleSync.arm();
}
function stopSync(): void {
    if (syncRaf) { (window.cancelAnimationFrame || clearTimeout)(syncRaf); syncRaf = 0; }
    settleSync.cancel();
    syncObserver?.disconnect();
    syncObserver = null;
    observedBody = null;
}

// A lazy error-boundary class (created on first use — React must not be touched at module
// top). If ANYTHING inside the wrapped tree throws during render (e.g. a provider-stack
// entry that doesn't re-render cleanly after a Discord update), React 18 would otherwise
// unmount the WHOLE portal root (a blank thread tab). The boundary catches it and falls
// back to the BARE chat render — popouts degrade, the chat itself survives.
let BoundaryClass: any = null;
function portalBoundary(): any {
    if (BoundaryClass) return BoundaryClass;
    class PortalErrorBoundary extends (React.Component as any) {
        declare props: any;
        state = { failed: false };
        static getDerivedStateFromError() { return { failed: true }; }
        componentDidCatch() { /* swallowed — the fallback render is the recovery */ }
        render() {
            return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
        }
    }
    BoundaryClass = PortalErrorBoundary;
    return BoundaryClass;
}

/** (Re)render a portal's chat with the current thread props. Shows an empty stub if the
 *  chat type isn't captured yet (the ThreadBody drives the capture poll and calls
 *  refreshThreadPortal once it lands). The chat is wrapped in the app's own captured
 *  provider STACK when available — without those contexts the popout-opening paths inside
 *  the chat (user popout, expression picker) silently no-op (the Mana context miss even
 *  warns); with the app's live values they mount into the app's own layer containers,
 *  which sit far above this overlay. An error boundary guards the wrapped tree: a broken
 *  provider entry degrades to the bare chat, never a blank portal. */
function renderPortal(p: Portal): boolean {
    try {
        const type = getChatType();
        const props = type ? buildThreadProps(p.threadId) : null;
        if (!type || !props) return false;
        const bare = React.createElement(type, props);
        let tree: any = bare;
        const stack = getProviderStack();
        // Nearest-first iteration wraps successively, leaving the root-most provider
        // outermost — the same nesting order the app itself renders.
        if (stack) {
            for (const p2 of stack) tree = React.createElement(p2.type, { value: p2.value }, tree);
            tree = React.createElement(portalBoundary(), { fallback: bare }, tree);
        }
        p.root.render(React.createElement("div", { className: "dockview-thread-portal-inner" }, tree));
        return true;
    } catch { return false; /* the isolated root failure cannot affect the dock */ }
}

/** A thread can be opened during Discord's channel-view bootstrap, before captureChat has
 * published the native type. Keep one bounded retry loop per blank portal; once the first
 * real tree lands, the loop stops permanently and later surface switches preserve it. */
function scheduleInitialRender(p: Portal): void {
    if (p.rendered || p.renderRetryRaf) return;
    const raf = window.requestAnimationFrame || ((cb: FrameRequestCallback) => window.setTimeout(cb, 16));
    let tries = 0;
    const tick = () => {
        p.renderRetryRaf = 0;
        if (portals.get(p.threadId) !== p || p.rendered) return;
        p.rendered = renderPortal(p);
        if (!p.rendered && ++tries < 180) p.renderRetryRaf = raf(tick);
    };
    p.renderRetryRaf = raf(tick);
}

/** Ensure a portal exists for `threadId` (create its body node + isolated root on first
 *  use), render the thread chat into it, and kick the one-time message fetch. Idempotent. */
export function ensureThreadPortal(threadId: string): void {
    if (!threadId) return;
    try { loadThreadMessages(threadId); } catch { /* messages fill when reachable */ }
    let p = portals.get(threadId);
    if (!p) {
        let node: HTMLElement | null = null;
        try {
            node = document.createElement("div");
            node.className = OVERLAY_CLASS;
            node.style.display = "none";
            document.body.appendChild(node);
            registerOwnedPortal(node);
            p = { node, root: createRoot(node), threadId, rendered: false, renderRetryRaf: 0 };
            portals.set(threadId, p);
        } catch {
            if (node) {
                unregisterOwnedPortal(node);
                node.remove();
            }
            return; /* couldn't create the isolated root — dock stays intact */
        }
    }
    // A live portal owns Discord's composer/virtual-scroller state. Render only until its
    // first real tree lands; tab/Search returns must merely reveal that mounted tree.
    if (!p.rendered) {
        p.rendered = renderPortal(p);
        if (!p.rendered) scheduleInitialRender(p);
    }
}

/** Re-render the ACTIVE portal's chat (e.g. after a late chat-type capture). No-op if the
 *  thread has no portal. */
export function refreshThreadPortal(threadId: string): void {
    const p = portals.get(threadId);
    if (!p) return;
    p.rendered = renderPortal(p) || p.rendered;
    if (!p.rendered) scheduleInitialRender(p);
}

// Claim counter for show/release pairing. TWO ThreadBody instances can briefly coexist
// (the dock root is retired + re-created when Discord remounts the placeholder — E3): the
// NEW body shows the portal, then the RETIRED body's unmount cleanup runs. A bare global
// hide there would hide the portal the new body just showed (observed on the rig: thread
// tab active, portal display:none). So show returns a CLAIM and the cleanup releases that
// claim — a release older than the latest show is a no-op. Same identity-guard pattern as
// forceRender.isRenderer / clearLiveController.
let showSeq = 0;

// A tiny op ring-buffer for the debug surface (__dockView.portalDebug) — the E3-family
// races were only diagnosable with an exact op ordering, so keep the last ops readable.
const debugLog: string[] = [];
function dlog(op: string): void {
    debugLog.push(`${Date.now() % 100000} ${op} seq=${showSeq} vis=${visibleThread}`);
    if (debugLog.length > 40) debugLog.shift();
}
export function portalDebugLog(): string[] { return [...debugLog]; }

/** Show `threadId`'s portal over the dock body and hide all others; start the position
 *  sync. Creates the portal first if needed. Returns a CLAIM for releaseThreadPortals —
 *  the caller's unmount cleanup passes it back so a stale cleanup can't hide a newer
 *  body's portal. */
export function showThreadPortal(threadId: string): number {
    dlog(`show ${threadId}`);
    ensureThreadPortal(threadId);
    visibleThread = threadId;
    for (const [id, p] of portals) {
        if (id !== threadId) {
            retainChatScrollAnchor(p.node);
            p.node.style.display = "none";
        }
    }
    startSync();
    return ++showSeq;
}

/** Release a show claim: hides the portals ONLY if `claim` is still the latest show
 *  (i.e. no newer ThreadBody has shown a portal since). The stale-cleanup no-op. */
export function releaseThreadPortals(claim: number): void {
    dlog(`release claim=${claim}`);
    if (claim === showSeq) hideThreadPortals();
}

/** Hide every thread portal (a non-thread view is active) + stop the sync. The portals stay
 *  mounted (each keeps its draft/scroll) — they're just display:none. Direct callers only
 *  (plugin stop / explicit hide-all); a ThreadBody cleanup must go through
 *  releaseThreadPortals so it can't clobber a newer body's show. */
export function hideThreadPortals(): void {
    dlog("hide-all");
    visibleThread = null;
    for (const p of portals.values()) {
        retainChatScrollAnchor(p.node);
        p.node.style.display = "none";
    }
    stopSync();
}

/** Imperative tab-transition seam. The engine calls this before its React repaint so a
 * thread never lingers over a file and a returning thread is already visible while the
 * new ThreadBody commit catches up. ThreadBody then takes the normal claimed ownership. */
export function selectThreadPortal(threadId: string | null): void {
    if (threadId) showThreadPortal(threadId);
    else hideThreadPortals();
}

/** Tear down `threadId`'s portal entirely (its tab was closed): unmount the root + remove
 *  the node. */
export function destroyThreadPortal(threadId: string): void {
    dlog(`destroy ${threadId}`);
    const p = portals.get(threadId);
    if (!p) return;
    portals.delete(threadId);
    if (visibleThread === threadId) { visibleThread = null; stopSync(); }
    const { root, node } = p;
    if (p.renderRetryRaf) (window.cancelAnimationFrame || window.clearTimeout)(p.renderRetryRaf);
    unregisterOwnedPortal(node);
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
