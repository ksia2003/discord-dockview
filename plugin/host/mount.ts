/*
 * Host injection + React mount + the open-state DOM reflection.
 *
 * Discord owns the page layout and RIPS our injected node out of the tree (re-render
 * passes, navigation). So mounting the dock is not a one-shot: we
 *  - ensureHost(): append our host div as the page-inner's LAST flex child (a
 *    sibling of chat_, so it pushes the chat like a native thread sidebar) and bind
 *    a React root to it,
 *  - run an 800ms HEARTBEAT that re-runs ensureHost (cheap — early-returns when the
 *    host is already in place),
 *  - run a MutationObserver scoped to the page-inner that RE-INJECTS the host (and
 *    re-applies the sidebar hide marking) the moment Discord detaches it,
 *  - gate all of this behind an `active` LATCH: a heartbeat/observer callback that
 *    was already in flight when stop() ran must NOT re-inject afterwards.
 *
 * VERBATIM-fragile (live-verified — plugin-rewrite.md §6.5): the heartbeat interval,
 * the observer's debounce + scope, the `active` latch, and the stopPanel TRIPLE
 * host-sweep (immediate + microtask + setTimeout, for React 18's deferred unmount).
 * Port faithfully; this is the part that makes the dock survive Discord at all.
 */

import { createRoot, React } from "@webpack/common";
import type { Root } from "react-dom/client";

import { dockHasWindows } from "../engine/channelMemory";
import { DockPanel } from "../ui/DockPanel";
import {
    hideExclusiveRightSlot, nodeMayContainExclusiveRightSlot, restoreHiddenMembers
} from "./exclusivity";
import { applyDockLayout, findChat, findPageInner } from "./layout";

const HOST_ID = "dockview-root";

let root: Root | null = null; // React root
let rootHost: HTMLElement | null = null; // the node `root` is bound to
// Set true between start() and stop(). A heartbeat/observer callback already in
// flight when stop() ran must NOT re-inject the host afterwards.
let active = false;

export function isActive(): boolean { return active; }
export function setActive(v: boolean): void { active = v; }

/** Ensure the host node exists, is the page-inner's last flex child, and carries a
 *  bound React root. Cheap + idempotent (early-returns when already in place), so
 *  the heartbeat can call it forever. Returns true once the host is mounted. */
export function ensureHost(): boolean {
    if (!active) return false; // plugin stopped — never (re)inject
    const inner = findPageInner();
    if (!inner) return false;
    const chat = findChat(inner);
    if (!chat) return false;

    let host = document.getElementById(HOST_ID);
    const inPlace = host && host.parentElement === inner && host === inner.lastElementChild;

    if (!inPlace) {
        let freshHost = false;
        if (!host) {
            host = document.createElement("div");
            host.id = HOST_ID;
            freshHost = true;
        }
        inner.appendChild(host);

        if (!root || freshHost || rootHost !== host) {
            root = createRoot(host);
            rootHost = host;
            root.render(React.createElement(DockPanel));
        }
    }
    applyOpenState();
    return true;
}

/** Reflect the active window's open state across the host node + the exclusive right
 *  slot (member list / DM user-profile sidebar / native thread sidebar). Open/closed
 *  is driven by the `dockview-open` CLASS (display:block !important) instead of inline
 *  display, because Discord's layout code intermittently resets our injected sibling's
 *  inline display to none — but never beats the class rule. Geometry (docked push +
 *  clamp / floating overlay) is owned by applyDockLayout; the sidebar exclusion is the
 *  targeted data attribute set by hideExclusiveRightSlot. */
export function applyOpenState(): void {
    const host = document.getElementById(HOST_ID);
    const inner = findPageInner();
    // A harmless debug/compat marker; the hide path no longer depends on this class.
    if (inner) inner.classList.add("dockview-page-inner");

    if (dockHasWindows()) {
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
// Re-injection: debounced observer scoped to the PAGE INNER div only.
// ---------------------------------------------------------------------------
let observer: MutationObserver | null = null;
let observedParent: HTMLElement | null = null;
let debounce: any = null;

export function attachObserver(): void {
    const inner = findPageInner();
    if (!inner) return; // no chat layout yet; the heartbeat poll will retry
    if (inner === observedParent && observer) return;

    observer?.disconnect();
    observedParent = inner;
    observer = new MutationObserver(records => {
        if (dockHasWindows() && records.some(r =>
            r.target === observedParent
            || Array.from(r.addedNodes).some(nodeMayContainExclusiveRightSlot)
        )) {
            hideExclusiveRightSlot();
        }
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            ensureHost(); // also re-applies open/exclusion state
            const cur = findPageInner();
            if (cur && cur !== observedParent) attachObserver();
        }, 150);
    });
    observer.observe(inner, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------
let heartbeat: any = null;

/** Start the host: mark active, run the heartbeat, and mount immediately if a chat
 *  layout is already present. The keybind / Flux / persist wiring is index.tsx's. */
export function startHost(): void {
    active = true;
    heartbeat = setInterval(() => {
        if (ensureHost()) attachObserver();
    }, 800);
    if (ensureHost()) attachObserver();
}

/** Tear the host all the way down. Marks inactive FIRST (so any in-flight callback
 *  can't re-inject), kills the heartbeat + observer, restores the native sidebars,
 *  then unmounts React and TRIPLE-SWEEPS the host node (immediate + microtask +
 *  setTimeout) — React 18's root.unmount() may defer detaching its container, so we
 *  remove all matching hosts by id across three ticks to be sure none lingers. */
export function stopHost(): void {
    // 0. mark inactive FIRST.
    active = false;
    // 1. heartbeat.
    if (heartbeat != null) {
        clearInterval(heartbeat);
        heartbeat = null;
    }
    // 2. observer + its debounce.
    observer?.disconnect();
    observer = null;
    observedParent = null;
    clearTimeout(debounce);
    debounce = null;
    // 3. restore the native sidebars / member list (mutual-exclusion undo).
    restoreHiddenMembers();
    // 4. unmount React + sweep the host DOM node(s).
    const r = root;
    root = null;
    rootHost = null;
    const removeHosts = () => {
        document.querySelectorAll(`#${HOST_ID}`).forEach(el => el.remove());
    };
    if (r) {
        try { r.unmount(); } catch { /* ignore */ }
    }
    removeHosts();
    Promise.resolve().then(removeHosts);
    setTimeout(removeHosts, 0);
}
