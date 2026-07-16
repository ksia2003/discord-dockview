/*
 * Host mount + the open-state DOM reflection.
 *
 * PRIMARY PATH (patch): the dock host is a legitimate child of Discord's React tree.
 * A Vencord patch on the channel-view component (the PureComponent that renders the
 * chat/sidebar flex row) appends $self.renderDockRail() as the row's last flex child,
 * so the host sits beside chat_ exactly like a native thread sidebar AND Discord's
 * reconciler owns it — it is never torn out on re-render. renderDockRail returns a
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

import { createRoot, React } from "@webpack/common";
import type { Root } from "react-dom/client";

import { DockPanel } from "../ui/DockPanel";
import {
    hideExclusiveRightSlot, nodeMayContainExclusiveRightSlot, restoreHiddenMembers
} from "./nativePanels";
import { applyDockLayout, findChat, findPageInner } from "./layout";

const HOST_ID = "dockview-root";

// How long to wait for the patch to render the host before falling back to injection.
const PATCH_GRACE_MS = 4000;

type Mode = "pending" | "patched" | "fallback";
let mode: Mode = "pending";

let root: Root | null = null; // React root
let rootHost: HTMLElement | null = null; // the node `root` is bound to
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

/** Is `el` actually laid out (no display:none ancestor)? Discord keeps a CACHED /
 *  preloaded channel-view instance MOUNTED under display:none (rig-proven: a thread-open
 *  flash navigation mounts a hidden duplicate whose placeholder ref fires like the real
 *  one). display:none ⇒ offsetParent === null (our host is never position:fixed), so this
 *  cheaply separates the dock the user SEES from a hidden duplicate. */
function isDisplayed(el: HTMLElement): boolean {
    return el.isConnected && el.offsetParent !== null;
}

export function isActive(): boolean { return active; }
export function setActive(v: boolean): void { active = v; }

/** The node our live React root is currently bound to (null when unbound). The thread
 *  portal tracks THIS node's `.dockview-body` — during a two-instance overlap (below)
 *  `getElementById` can return the OTHER, stale placeholder. */
export function liveHost(): HTMLElement | null {
    return rootHost;
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
    if (root && rootHost === host) return; // already bound to THIS node
    if (root) retireRoot(root, rootHost);
    const resident = containerRoots.get(host);
    if (resident) {
        // The container already carries a root (its retire hasn't landed, or a past bind
        // left it mounted). createRoot again would THROW — adopt it and re-render.
        root = resident;
        rootHost = host;
        stats.rootAdopts++;
        mlog("adopt");
        root.render(React.createElement(DockPanel));
        return;
    }
    try {
        root = createRoot(host);
    } catch (e) {
        // Never strand the binding on a throw — log it loudly and leave root/rootHost
        // null so the next ensureHost retries cleanly.
        root = null;
        rootHost = null;
        mlog(`createRoot threw: ${String(e).slice(0, 80)}`);
        console.error("[DockView] createRoot failed", e);
        return;
    }
    containerRoots.set(host, root);
    rootHost = host;
    stats.rootCreates++;
    mlog("create");
    root.render(React.createElement(DockPanel));
}

/** Retire a root: deferred unmount (a ref callback runs mid-commit; React forbids a
 *  synchronous root unmount there), CANCELLED if the same root is re-adopted before the
 *  microtask runs (a bounce back to the same container must not unmount what it just
 *  re-rendered). Cleans the container registry on a real unmount. */
function retireRoot(stale: Root, staleHost: HTMLElement | null): void {
    root = null;
    Promise.resolve().then(() => {
        if (stale === root) return; // re-adopted since — still the live root
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
        rootHost = null;
        if (stale) retireRoot(stale, node);
        else root = null;
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
export function renderDockRail(): any {
    let bound: HTMLElement | null = null;
    return React.createElement("div", {
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
            // STEAL GUARD (E3): a HIDDEN duplicate instance's placeholder must not take
            // the root away from a healthy, displayed dock — binding it would empty the
            // dock the user is looking at and render into the hidden tree (rig-proven).
            // A hidden attach with NO live displayed root still binds (something over
            // nothing; ensureHost rebinds to a displayed node the moment one exists).
            if (root && rootHost && rootHost !== el && isDisplayed(rootHost) && !isDisplayed(el)) {
                stats.refIgnored++;
                return;
            }
            bindRoot(el);
            applyOpenState();
        }
    });
}

/** Ensure the host carries a bound root and reflects open state. In the patched path
 *  the patch owns the node, so this is "bind if needed + apply state"; in the fallback
 *  path it re-injects the node. Cheap + idempotent — engine call sites (load / channel
 *  switch / open) and the fallback heartbeat call it freely. Returns true once the host
 *  is mounted.
 *
 *  BINDING STABILITY + DISPLAYED-NODE PREFERENCE (E3): while our bound node is connected
 *  AND laid out, keep it — never rebind by lookup (during a two-instance overlap the
 *  document holds TWO #dockview-root placeholders; hopping between them would ping-pong
 *  the root). When the bound node is gone OR hidden (Discord swapped which instance is
 *  visible — the cached-view flip), rebind to a DISPLAYED placeholder; a hidden one is
 *  the last resort so the dock still exists if Discord hides the whole page. */
export function ensureHost(): boolean {
    if (!active) return false;

    if (mode === "fallback") return ensureHostInjected();

    // Bound, in the document, and actually laid out → keep it, just reflect state.
    if (root && rootHost && isDisplayed(rootHost)) {
        if (mode === "pending") mode = "patched";
        applyOpenState();
        return true;
    }

    // No healthy binding: pick the best placeholder — a DISPLAYED one first (the dock
    // the user can see), else any connected one (covers ensureHost racing ahead of the
    // ref callback, the post-detach rebind, and the hidden-instance flip).
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(`#${HOST_ID}`));
    const host = nodes.find(isDisplayed) ?? nodes[0] ?? null;
    if (host) {
        if (mode === "pending") mode = "patched";
        bindRoot(host);
        applyOpenState();
        return true;
    }
    return false;
}

/** Reflect the dock into the DOM. The dock is ALWAYS open in the rewrite, so the
 *  `dockview-open` class (display:block !important — Discord's layout code
 *  intermittently resets our sibling's inline display to none, but never beats the
 *  class rule) is applied unconditionally. Geometry (docked push + clamp / floating
 *  overlay) is owned by applyDockLayout; the native right-slot (member list / profile /
 *  thread sidebar) is kept collapsed via the targeted data attribute set by
 *  hideExclusiveRightSlot. */
export function applyOpenState(): void {
    const host = document.getElementById(HOST_ID);
    const inner = findPageInner();
    // A harmless debug/compat marker; the hide path no longer depends on this class.
    if (inner) inner.classList.add("dockview-page-inner");

    if (host) host.classList.add("dockview-open");
    document.documentElement.classList.add("dockview-open");
    applyDockLayout();
    hideExclusiveRightSlot(inner);
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
    const inner = findPageInner();
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
    active = true;
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
    rootHost = null;
    if (r) {
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
