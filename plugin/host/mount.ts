/*
 * Host mount + the open-state DOM reflection.
 *
 * PRIMARY PATH (patch): the dock host is a legitimate child of Discord's React tree.
 * A Vencord patch on the channel-view component appends $self.renderDockRail() right
 * after this.renderThreadSidebar() in the render Fragment, so the host takes the native
 * thread-sidebar's slot: a full-height flex sibling of the WHOLE chat column (header +
 * messages + composer) in the page-inner row, its top edge level with the channel header
 * (the header then spans only the chat column). Discord's reconciler owns it — it is
 * never torn out on re-render. renderDockRail returns a
 * stable placeholder <div id="dockview-root"> whose ref binds our own createRoot;
 * we keep a separate root (not render DockPanel through the patch directly) so the
 * whole engine render pipeline — setRenderer/requestRender, viewState, viewers — is
 * unchanged, and our React tree lives independent of Discord's churn.
 *
 * Measured on the rig (2026-07-14): the channel-view instance does NOT remount on
 * channel switch (same instance across guild↔DM↔guild, only channelId prop updates,
 * zero unmounts). So the placeholder mounts once and our dock React tree survives
 * every channel switch; no per-switch remount of viewer DOM.
 *
 * FALLBACK PATH (injection): if the patch never applies (Discord shifted the anchor),
 * the host would never appear. startHost arms a one-shot check; when the host is still
 * absent after the grace window it engages the OLD DOM-injection host — an 800ms
 * heartbeat re-running ensureHost + a MutationObserver that re-injects on detach —
 * so the dock keeps working (with the historical flicker) instead of dying silently.
 * The heartbeat/observer live ONLY in this fallback path.
 */

import { createRoot, React } from "@vencord/types/webpack/common";
import type { Root } from "react-dom/client";

import { DockPanel } from "../ui/DockPanel";
import {
    hideExclusiveRightSlot, nodeMayContainExclusiveRightSlot, restoreHiddenMembers
} from "./nativePanels";
import {
    clearDockHostState, isDockHostTreeActive, selectDockHost, setLiveHost
} from "./hostSelection";
import { applyDockLayout, findChat, findPageInner } from "./layout";
import { setOwnedPortalsTemporarilyHidden } from "./ownedPortalVisibility";
import { getUnifiedChannelHeader, markUnifiedRailSeen, setUnifiedHeaderActive } from "./unifiedHeader";

const HOST_ID = "dockview-root";

// How long to wait for the patch to render the host before falling back to injection.
const PATCH_GRACE_MS = 4000;

type Mode = "pending" | "patched" | "fallback";
let mode: Mode = "pending";

let root: Root | null = null; // React root
let rootHost: HTMLElement | null = null; // the node `root` is bound to
// F9 temporary-hide is session-only. The React root and every tab stay mounted; only
// the host's layout class is removed, so showing it restores the exact previous view.
let temporarilyHidden = false;
// Set true between start() and stop(). A heartbeat/observer callback already in
// flight when stop() ran must NOT re-inject the host afterwards.
let active = false;

// Lightweight lifecycle counters (the E3 churn-soak canary + the debug surface). A
// healthy session keeps rootCreates + rootAdopts - rootUnmounts == 1 live binding; drift
// is the "blank dock / ghost tab" fingerprint. refIgnored counts hidden-duplicate
// placeholder attaches we deliberately did NOT bind (see the steal guard). Read via
// __dockView.mountStats.
const stats = { rootCreates: 0, rootAdopts: 0, rootUnmounts: 0, refAttach: 0, refDetach: 0, refIgnored: 0 };
export function mountStats(): { rootCreates: number; rootAdopts: number; rootUnmounts: number; refAttach: number; refDetach: number; refIgnored: number } {
    return { ...stats };
}

// A small op ring-buffer (__dockView.mountDebug) — the E3 family of races was only
// diagnosable with exact op ordering, and a createRoot throw must be VISIBLE (it used to
// tear the binding down silently: root null, rootHost stale, dead dock until reload).
const mountLog: string[] = [];
function mlog(op: string): void {
    mountLog.push(`${Date.now() % 100000} ${op}`);
    if (mountLog.length > 40) mountLog.shift();
}
export function mountDebugLog(): string[] { return [...mountLog]; }

// container → its live React root. React 18 FORBIDS createRoot() twice on the same
// container while the first root is mounted — and our retire unmounts are DEFERRED, so a
// rebind back to a container whose old root hasn't unmounted yet must ADOPT the resident
// root (re-render into it) instead of re-creating. Without this the second createRoot
// throws and strands the binding (rig-hit: dead dock, rendererLive=false, empty spacer).
const containerRoots = new Map<HTMLElement, Root>();
// A root can be retired, re-adopted, and retired again before earlier microtasks run.
// One token per root makes every older retirement stale; adopting deletes the current
// token so no queued callback may unmount the root that just became live again.
const rootRetirements = new WeakMap<Root, object>();

function setRootHost(host: HTMLElement | null): void {
    rootHost = host;
    setLiveHost(host);
}

export function isActive(): boolean { return active; }
export function setActive(v: boolean): void { active = v; }

/** The node our live React root is currently bound to (null when unbound). The thread
 *  portal tracks THIS node's `.dockview-body` — during a two-instance overlap (below)
 *  `getElementById` can return the OTHER, stale placeholder. */
export function liveHost(): HTMLElement | null {
    return rootHost;
}

export function isDockTemporarilyHidden(): boolean {
    return temporarilyHidden;
}

/** Bind (or rebind) our React root onto `host` and render the dock. Idempotent: no-op
 *  when already bound to THIS node — leaves React's async first-commit gap alone.
 *
 *  E3 ROOT-CAUSE FIX (rig-proven, mountStats trace 2026-07-16): Discord CAN mount a
 *  SECOND channel-view instance whose render carries a second placeholder while the first
 *  stays mounted (observed on a thread-open flash navigation: refAttach 2, refDetach 0,
 *  TWO strips in the document). The old bindRoot left the previous root mounted forever —
 *  two live DockPanels, and the single setRenderer slot means only the newest repaints;
 *  the older panel's DOM FREEZES (the "ghost tab with an empty store"), and when the
 *  newer instance later unmounts, that frozen strip is what remains visible while
 *  requestRender() writes into a detached tree (the "stale dock" / "blank dock").
 *  So on a node switch we RETIRE the old root: deferred unmount (a ref callback runs
 *  mid-commit; React forbids unmounting a root synchronously there), which also clears
 *  the old node's children so no frozen strip can survive. Shared by both paths. */
function bindRoot(host: HTMLElement): void {
    // Discord fires this ref repeatedly for the same node. Cancel a queued retirement,
    // but do NOT render again: redundant root renders here amplify ordinary chat churn.
    // Dead registry entries are handled by the resident-adoption try/catch below.
    if (root && rootHost === host) {
        rootRetirements.delete(root);
        return;
    }
    if (root) retireRoot(root, rootHost);
    else if (rootHost && rootHost !== host) clearDockHostState(rootHost);
    // A placeholder may retain DockView state from an earlier root. Clear only our
    // marker/geometry before adopting it; applyOpenState reapplies the current state.
    if (rootHost !== host) clearDockHostState(host);
    const resident = containerRoots.get(host);
    if (resident) {
        // The container already carries a root (its retire hasn't landed, or a past bind
        // left it mounted). createRoot again would THROW — adopt it and re-render.
        rootRetirements.delete(resident);
        root = resident;
        setRootHost(host);
        try {
            resident.render(React.createElement(DockPanel));
            stats.rootAdopts++;
            mlog("adopt");
            return;
        } catch (e) {
            // A root that an older callback already unmounted can remain in the registry.
            // Evict it and fall through to createRoot so one stale entry cannot strand the
            // visible host as an empty div.
            if (containerRoots.get(host) === resident) containerRoots.delete(host);
            root = null;
            setRootHost(null);
            mlog(`resident root was dead: ${String(e).slice(0, 80)}`);
        }
    }
    try {
        root = createRoot(host);
    } catch (e) {
        // Never strand the binding on a throw — log it loudly and leave root/rootHost
        // null so the next ensureHost retries cleanly.
        root = null;
        setRootHost(null);
        mlog(`createRoot threw: ${String(e).slice(0, 80)}`);
        console.error("[DockView] createRoot failed", e);
        return;
    }
    containerRoots.set(host, root);
    setRootHost(host);
    stats.rootCreates++;
    mlog("create");
    root.render(React.createElement(DockPanel));
}

/** Retire a root: deferred unmount (a ref callback runs mid-commit; React forbids a
 *  synchronous root unmount there), CANCELLED if the same root is re-adopted before the
 *  microtask runs (a bounce back to the same container must not unmount what it just
 *  re-rendered). Cleans the container registry on a real unmount. */
function retireRoot(stale: Root, staleHost: HTMLElement | null): void {
    clearDockHostState(staleHost);
    if (root === stale) {
        root = null;
        if (rootHost === staleHost) setRootHost(null);
    }
    const retirement = {};
    rootRetirements.set(stale, retirement);
    Promise.resolve().then(() => {
        // A later retirement supersedes this callback, and adoption deletes the token.
        // Either case means this queued callback no longer owns the right to unmount.
        if (rootRetirements.get(stale) !== retirement) return;
        rootRetirements.delete(stale);
        try { stale.unmount(); } catch { /* already unmounted */ }
        if (staleHost && containerRoots.get(staleHost) === stale) containerRoots.delete(staleHost);
        stats.rootUnmounts++;
        mlog("retired");
    });
}

// ---------------------------------------------------------------------------
// PRIMARY PATH — the patched React child.
// ---------------------------------------------------------------------------

/** The bound placeholder DETACHED from Discord's tree (its ref fired null). Deferred
 *  (mid-commit), verify it really left the document — a same-node re-render fires
 *  null+el in one commit and a reconciler move keeps it connected; both must NOT tear
 *  the root down. When it's genuinely gone (the overlapped channel-view instance that
 *  owned it unmounted), retire the root and IMMEDIATELY rebind to any surviving
 *  placeholder (the cached first instance Discord just re-showed renders no new ref —
 *  ensureHost's id lookup is the only way back, and waiting for the next engine action
 *  would leave the dock blank until then). */
function onPlaceholderDetach(node: HTMLElement): void {
    Promise.resolve().then(() => {
        if (!active) return;            // stopHost owns teardown
        if (rootHost !== node) return;  // already rebound elsewhere
        if (node.isConnected) return;   // re-attach in the same commit (move) — still live
        const stale = root;
        setRootHost(null);
        if (stale) retireRoot(stale, node);
        else {
            clearDockHostState(node);
            root = null;
        }
        mlog("detach-retire");
        ensureHost();
    });
}

/** The patched channel-view render appends this as the chat/sidebar row's last flex
 *  child. It's a placeholder host div; its ref callback binds our own React root when it
 *  attaches. Rendered unconditionally by the patch — the dock's open state is the
 *  `dockview-open` class, applied by applyOpenState, not element presence.
 *
 *  The ref closure captures ITS element (each channel-view render creates a fresh
 *  closure), so the detach call can tell WHICH node left — the E3 fix needs that to
 *  ignore detaches of nodes we already rebound away from. */
export function renderDockRail(channelView?: any): any {
    markUnifiedRailSeen(channelView);
    const unifiedHeader = getUnifiedChannelHeader(channelView);
    let bound: HTMLElement | null = null;
    const rail = React.createElement("div", {
        id: HOST_ID,
        key: HOST_ID,
        ref: (el: HTMLElement | null) => {
            if (!el) {
                stats.refDetach++;
                const node = bound;
                bound = null;
                if (node && active) onPlaceholderDetach(node);
                return;
            }
            if (!active) return;
            bound = el;
            stats.refAttach++;
            mode = "patched";
            // STEAL GUARD (E3): a hidden duplicate instance's placeholder must not take
            // the root away from a healthy active tree — binding it would empty the dock
            // the user is looking at and render into the cached tree. The host itself is
            // display:none by design, so only containing-tree state is compared.
            if (
                root
                && rootHost
                && rootHost !== el
                && isDockHostTreeActive(rootHost)
                && !isDockHostTreeActive(el)
            ) {
                stats.refIgnored++;
                return;
            }
            bindRoot(el);
            applyOpenState();
        }
    });
    if (!unifiedHeader) return rail;
    let layoutParent: HTMLElement | null = null;
    return React.createElement(
        React.Fragment,
        null,
        React.createElement(
            "div",
            {
                key: "dockview-unified-header",
                className: "dockview-unified-header",
                ref: (el: HTMLElement | null) => {
                    if (!el) {
                        layoutParent?.classList.remove("dockview-unified-layout");
                        layoutParent = null;
                        return;
                    }
                    layoutParent = el.parentElement;
                    layoutParent?.classList.add("dockview-page-inner", "dockview-unified-layout");
                }
            },
            unifiedHeader
        ),
        rail
    );
}

/** Ensure the host carries a bound root and reflects open state. In the patched path
 *  the patch owns the node, so this is "bind if needed + apply state"; in the fallback
 *  path it re-injects the node. Cheap + idempotent — engine call sites (load / channel
 *  switch / open) and the fallback heartbeat call it freely. Returns true once the host
 *  is mounted.
 *
 *  BINDING STABILITY + ACTIVE-TREE PREFERENCE (E3): while our bound node is connected
 *  and its owning tree is active, keep it — never rebind by lookup (during a two-instance
 *  overlap the document holds TWO #dockview-root placeholders; hopping between them would
 *  ping-pong the root). The host itself is always display:none by design, so the selector
 *  ignores its own box and rebinds only when Discord swaps the active channel-view tree. */
export function ensureHost(): boolean {
    if (!active) return false;

    if (mode === "fallback") return ensureHostInjected();

    const host = selectDockHost();
    if (host) {
        if (mode === "pending") mode = "patched";
        // This is also the repair path when Discord swaps the active channel-view tree:
        // selected host !== rootHost must move the live React root before any class or
        // geometry write, otherwise the new strip and old content split-brain.
        if (!root || rootHost !== host) bindRoot(host);
        applyOpenState();
        return !!root;
    }
    return false;
}

/** Reflect the dock into the DOM. Normally the `dockview-open` class wins over
 *  Discord's intermittent inline display reset. F9's optional temporary-hide mode
 *  deliberately removes that class while leaving the React root and tab state mounted.
 *  Geometry (docked push + clamp / floating overlay) is owned by applyDockLayout; the
 *  native right-slot remains collapsed while DockView is hidden. */
export function applyOpenState(): void {
    let host = selectDockHost();
    if (active && mode !== "fallback" && host && rootHost !== host) bindRoot(host);
    // Rebinding can change both the host and its owning page tree.
    host = selectDockHost();
    const inner = findPageInner(host);
    // A harmless debug/compat marker; the hide path no longer depends on this class.
    if (inner) inner.classList.add("dockview-page-inner");

    const visible = !temporarilyHidden;
    host?.classList.toggle("dockview-open", visible);
    document.documentElement.classList.toggle("dockview-open", visible);
    setOwnedPortalsTemporarilyHidden(temporarilyHidden);
    if (visible) applyDockLayout(host);
    hideExclusiveRightSlot(inner);
}

/** Show a temporarily hidden dock without changing its compact/expanded width. This is
 *  the explicit-new-tab path: files, websites, new files, and visible thread opens. */
export function revealDock(): void {
    temporarilyHidden = false;
    applyOpenState();
}

/** Hide without toggling. Automatic callers must never reveal a dock the user already
 * hid with F9. Closing the triggering surface deliberately does not restore it. */
export function hideDockTemporarily(): void {
    if (temporarilyHidden) return;
    temporarilyHidden = true;
    applyOpenState();
}

/** F9 hide-mode toggle. Returns true when the dock is visible after the toggle. */
export function toggleDockTemporaryVisibility(): boolean {
    temporarilyHidden = !temporarilyHidden;
    applyOpenState();
    return !temporarilyHidden;
}

/** Hide the mounted context body (member list / profile) in the SAME synchronous turn a
 *  view switch flips the active view away from the context tab. The DockPanel swaps its
 *  body by re-rendering; that commit lands on a later frame and — because the member list
 *  is Discord's heavy component — can spill past a paint, flashing the stale member list in
 *  the dock for a frame right as a thread portal opens (rig-proven via screencast). Setting
 *  display:none on the live node closes that paint race; React unmounts the node on its own
 *  commit (it never re-shows this node — the next render mounts a different body), and our
 *  inline style is on a node React is about to discard, so there's nothing to fight. No-op
 *  when the context body isn't mounted. Scoped to the LIVE host (a hidden E3 duplicate's
 *  own body is left alone). */
export function hideContextBody(): void {
    const dock = selectDockHost();
    const body = dock?.querySelector<HTMLElement>(".dockview-context-body");
    if (body) body.style.display = "none";
}

// ---------------------------------------------------------------------------
// FALLBACK PATH — DOM injection (the historical host). Heartbeat + observer live
// HERE ONLY; engaged when the patch never rendered the host.
// ---------------------------------------------------------------------------
let observer: MutationObserver | null = null;
let observedParent: HTMLElement | null = null;
let debounce: any = null;
let heartbeat: any = null;

/** Inject the host as the page-inner's last flex child and bind the root. Cheap +
 *  idempotent; the heartbeat calls it forever. Used only in the fallback path. */
function ensureHostInjected(): boolean {
    const inner = findPageInner(null);
    if (!inner) return false;
    const chat = findChat(inner);
    if (!chat) return false;

    let host = document.getElementById(HOST_ID);
    const inPlace = host && host.parentElement === inner && host === inner.lastElementChild;
    if (!inPlace) {
        if (!host) {
            host = document.createElement("div");
            host.id = HOST_ID;
        }
        inner.appendChild(host);
    }
    if (host) bindRoot(host);
    applyOpenState();
    return true;
}

function attachObserver(): void {
    const inner = findPageInner();
    if (!inner) return;
    if (inner === observedParent && observer) return;

    observer?.disconnect();
    observedParent = inner;
    observer = new MutationObserver(records => {
        if (records.some(r =>
            r.target === observedParent
            || Array.from(r.addedNodes).some(nodeMayContainExclusiveRightSlot)
        )) {
            hideExclusiveRightSlot();
        }
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            ensureHostInjected();
            const cur = findPageInner();
            if (cur && cur !== observedParent) attachObserver();
        }, 150);
    });
    observer.observe(inner, { childList: true, subtree: true });
}

/** Engage the fallback: switch mode, start the heartbeat + observer, inject now. Called
 *  once when the patch is judged to have failed (host still absent after the grace). */
function engageFallback(): void {
    if (!active || mode === "fallback") return;
    mode = "fallback";
    console.warn("[DockView] layout patch did not apply — falling back to DOM injection host.");
    heartbeat = setInterval(() => {
        if (ensureHostInjected()) attachObserver();
    }, 800);
    if (ensureHostInjected()) attachObserver();
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------
let patchCheck: any = null;

/** Start the host: mark active, bind the root immediately if the patch already rendered
 *  the placeholder, and arm a one-shot check that engages the injection fallback if the
 *  host never appears (patch anchor drifted). The keybind / Flux / persist wiring is
 *  index.tsx's. */
export function startHost(): void {
    temporarilyHidden = false;
    active = true;
    setUnifiedHeaderActive(true);
    mode = "pending";
    // The patch may already have committed the placeholder before start() runs.
    ensureHost();
    patchCheck = setTimeout(() => {
        patchCheck = null;
        if (!active) return;
        if (!document.getElementById(HOST_ID)) engageFallback();
    }, PATCH_GRACE_MS);
}

/** Tear the host all the way down. Marks inactive FIRST (so any in-flight callback
 *  can't re-inject), kills the patch-check timer + fallback heartbeat/observer, restores
 *  the native sidebars, then unmounts our React root.
 *
 *  Node ownership decides the sweep: in the FALLBACK path the host div is ours (we
 *  document.createElement + appendChild it), so we TRIPLE-SWEEP it by id (immediate +
 *  microtask + setTimeout — React 18's root.unmount() may defer detaching its container).
 *  In the PATCHED path the placeholder belongs to Discord's React tree; sweeping it would
 *  fight the reconciler and — because Discord won't re-render the channel-view just
 *  because our plugin restarted — it would NOT come back, dropping a stop→start cycle onto
 *  the slow injection fallback. So we leave the node: unmounting our root empties it, a
 *  re-start's ensureHost rebinds the still-present node instantly, and a genuine disable
 *  leaves an inert display:none div that Discord drops on its next channel-view render. */
export function stopHost(): void {
    const wasFallback = mode === "fallback";
    active = false;
    setUnifiedHeaderActive(false);
    temporarilyHidden = false;
    mode = "pending";
    if (patchCheck != null) { clearTimeout(patchCheck); patchCheck = null; }
    if (heartbeat != null) { clearInterval(heartbeat); heartbeat = null; }
    observer?.disconnect();
    observer = null;
    observedParent = null;
    clearTimeout(debounce);
    debounce = null;
    restoreHiddenMembers();
    const r = root;
    root = null;
    clearDockHostState(rootHost);
    setRootHost(null);
    if (r) {
        // Cancel any older queued retirement before performing the authoritative teardown.
        rootRetirements.delete(r);
        try { r.unmount(); } catch { /* ignore */ }
    }
    // Drop every container→root association: the roots are unmounted (r above, and any
    // pending retirement lands via its own microtask) — a restart must CREATE fresh roots,
    // never adopt an unmounted one (render into it throws).
    containerRoots.clear();
    if (!wasFallback) return; // patched: leave Discord's placeholder node for a fast rebind.
    const removeHosts = () => {
        document.querySelectorAll(`#${HOST_ID}`).forEach(el => el.remove());
    };
    removeHosts();
    Promise.resolve().then(removeHosts);
    setTimeout(removeHosts, 0);
}
