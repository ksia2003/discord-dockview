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

import { dockVisible } from "../engine/channelMemory";
import { DockPanel } from "../ui/DockPanel";
import {
    hideExclusiveRightSlot, nodeMayContainExclusiveRightSlot, restoreHiddenMembers
} from "./exclusivity";
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

export function isActive(): boolean { return active; }
export function setActive(v: boolean): void { active = v; }

/** Bind (or rebind) our React root onto `host` and render the dock. Idempotent: only
 *  (re)creates the root when it isn't already bound to THIS node — leaves React's
 *  async first-commit gap alone. Shared by both paths. */
function bindRoot(host: HTMLElement): void {
    if (!root || rootHost !== host) {
        root = createRoot(host);
        rootHost = host;
        root.render(React.createElement(DockPanel));
    }
}

// ---------------------------------------------------------------------------
// PRIMARY PATH — the patched React child.
// ---------------------------------------------------------------------------

/** The patched channel-view render appends this as the chat/sidebar row's last flex
 *  child. It's a stable placeholder host div; its ref callback binds our own React
 *  root the first (and, since the channel-view never remounts, only) time it attaches.
 *  Rendered unconditionally by the patch — the dock's own open/close is the
 *  `dockview-open` class, applied by applyOpenState, not element presence. */
export function renderDockRail(): any {
    return React.createElement("div", {
        id: HOST_ID,
        key: HOST_ID,
        ref: (el: HTMLElement | null) => {
            if (!el || !active) return;
            mode = "patched";
            bindRoot(el);
            applyOpenState();
        }
    });
}

/** Ensure the host carries a bound root and reflects open state. In the patched path
 *  the host is always present (React owns it) so this is just "bind if needed + apply
 *  state"; in the fallback path it re-injects the node. Cheap + idempotent — engine
 *  call sites (load / channel switch / open) and the fallback heartbeat call it freely.
 *  Returns true once the host is mounted. */
export function ensureHost(): boolean {
    if (!active) return false;

    if (mode === "fallback") return ensureHostInjected();

    // pending / patched: the patch owns the node. Bind the root if the host is already
    // in the tree (covers ensureHost racing ahead of the ref callback) and apply state.
    const host = document.getElementById(HOST_ID);
    if (host) {
        if (mode === "pending") mode = "patched";
        bindRoot(host);
        applyOpenState();
        return true;
    }
    return false;
}

/** Reflect the active window's open state across the host node + the exclusive right
 *  slot (member list / DM user-profile sidebar / native thread sidebar). Open/closed
 *  is driven by the `dockview-open` CLASS (display:block !important) instead of inline
 *  display, because Discord's layout code intermittently resets our sibling's inline
 *  display to none — but never beats the class rule. Geometry (docked push + clamp /
 *  floating overlay) is owned by applyDockLayout; the sidebar exclusion is the targeted
 *  data attribute set by hideExclusiveRightSlot. */
export function applyOpenState(): void {
    const host = document.getElementById(HOST_ID);
    const inner = findPageInner();
    // A harmless debug/compat marker; the hide path no longer depends on this class.
    if (inner) inner.classList.add("dockview-page-inner");

    if (dockVisible()) {
        if (host) host.classList.add("dockview-open");
        document.documentElement.classList.add("dockview-open");
    } else {
        if (host) host.classList.remove("dockview-open");
        document.documentElement.classList.remove("dockview-open");
    }
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
        if (dockVisible() && records.some(r =>
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
    if (!wasFallback) return; // patched: leave Discord's placeholder node for a fast rebind.
    const removeHosts = () => {
        document.querySelectorAll(`#${HOST_ID}`).forEach(el => el.remove());
    };
    removeHosts();
    Promise.resolve().then(removeHosts);
    setTimeout(removeHosts, 0);
}
