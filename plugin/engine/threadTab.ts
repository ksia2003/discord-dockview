/*
 * Thread tabs — opening a Discord thread as a dock tab (the D-batch replacement for the
 * native thread sidebar, which action interception now swallows).
 *
 * A thread tab is a normal channel-bound DockWindow with content.type "thread" and
 * content.threadChannelId = the thread's id, living in the thread's PARENT channel strip
 * (spec §2: all tabs are channel-bound). It rides the whole tab model — dedup (same thread
 * → focus its tab), multiple threads open at once, closable like a file tab — with no new
 * lifecycle. The ThreadViewer's Body renders Discord's own chat component bound to the
 * thread (host/slotComponents.ts), so messages + composer work; nothing is fetched by the
 * plugin except the one-time message load the Body kicks.
 *
 * ARCHITECTURAL CUT: like load()/openTab, this owns the open + tab bookkeeping; the actual
 * chat rendering is the viewer's. It sets the window content directly (a thread has no
 * fetch/descriptor/cache), then reflects the layout + renders.
 */

import { decideThreadOpen } from "../viewers/thread/portalSync";
import { destroyThreadPortal, selectThreadPortal } from "../viewers/thread/threadPortal";
import { requestRender } from "./forceRender";
import { hostActions } from "./hostBridge";
import { isContextActive, setContextActive } from "./contextTab";
import {
    allThreadTabs, focusEmptyShell, getActiveWindow, getActiveWindowId, getWindowChannelId,
    openThreadWindow, reconcileActiveFromCache, removeWindowEverywhere, setActiveWindow, stripFor
} from "./window";
import { getChannelObject } from "../host/slotComponents";
import type { DockWindow } from "./types";

// The explicit-user-intent seam. The Threads browser card is the one thread-open path
// that is ALWAYS a user click (the patch only fires on a browser row selection); the
// captured chat's recursive SIDEBAR_VIEW_CHANNEL and background-channel reconciliation
// never travel through it. The flag arms the NEXT openThreadTab call and is consumed
// there, so it can never leak into a later dispatch.
let explicitThreadOpenPending = false;

/** Arm the explicit-user-intent flag for the next openThreadTab (Threads browser card). */
export function markExplicitThreadOpen(): void {
    explicitThreadOpenPending = true;
}

/** Open (or focus) a dock tab for `threadId`. `parentId` is the thread's parent channel
 *  (from the SIDEBAR_VIEW_CHANNEL payload's baseChannelId); when absent we resolve it from
 *  the thread channel object. Dedup: reopening the same thread focuses its existing tab.
 *  The tab lives in the parent channel's strip and becomes the active view when the parent
 *  is the current channel. */
export function openThreadTab(threadId: string, parentId?: string | null): void {
    const explicit = explicitThreadOpenPending;
    explicitThreadOpenPending = false;
    if (!threadId) return;
    // LOOP-BREAKER + REFOCUS SPLIT: the captured thread chat, rendered in our portal, can
    // itself dispatch SIDEBAR_VIEW_CHANNEL for its own channel — interception routes that
    // back here. A same-thread open through any NON-explicit seam is that internal
    // recursion (or background reconciliation) and stays a pure no-op — no seq bump, no
    // render, no reveal — so re-entrancy can't spin a render loop. Only the explicit
    // user seam (Threads browser card) refocuses: reveal an F9-hidden dock (last non-zero
    // preset) and re-show the mounted chat WITHOUT a seq bump — remounting the chat is
    // what would re-arm the recursion.
    const active = getActiveWindow();
    const alreadyActive = !!(active
        && active.content.type === "thread"
        && active.content.threadChannelId === threadId
        && !isContextActive(getWindowChannelId()));
    const decision = decideThreadOpen(alreadyActive, explicit);
    if (decision === "noop") {
        return;
    }
    if (decision === "refocus") {
        const host = hostActions();
        host.ensureHost();
        host.revealDock();
        selectThreadPortal(threadId);
        return;
    }

    const thread = getChannelObject(threadId);
    // Prefer the payload's parent; fall back to the thread's own parent_id, then the
    // current channel (a thread opened from its parent's chat — the common path).
    const parent = parentId ?? thread?.parent_id ?? getWindowChannelId();

    const win = openThreadWindow(parent ?? null, threadId);
    // Fill the thread content (idempotent on a dedup-focus of an existing tab).
    win.content.type = "thread";
    win.content.threadChannelId = threadId;
    // The tab label is the thread name (isRealTab keys on content.name != null, so this
    // also makes the window a real tab). Fall back to a neutral label pre-resolution.
    win.content.name = thread?.name ?? "Thread";
    win.content.loading = false;
    win.content.error = null;
    win.content.url = null;
    win.content.seq += 1; // fresh body identity so the ThreadBody (re)mounts for this thread

    // Opening a thread tab makes it the active VIEW for its parent channel (yields the
    // context tab) — but only when the parent is the channel we're actually looking at.
    const takesOverView = (parent ?? null) === getWindowChannelId();
    if (takesOverView) {
        hostActions().deactivateSearchView();
        setContextActive(getWindowChannelId(), false);
    }

    // Reflect the dock into the DOM + render. No native sidebar to collapse — interception
    // ensured Discord never opened one — so this is just ensure-host + apply-layout.
    const host = hostActions();
    host.ensureHost();
    // A thread opened into the visible/current channel is an explicit new Dock tab and
    // therefore reveals an F9-hidden dock. A background-channel reconciliation must not.
    if (takesOverView) host.revealDock();
    else host.applyOpenState();
    // When this thread takes over the view, hide the outgoing context body NOW so React's
    // (later) body swap can't flash the stale member list in the dock as the portal opens.
    if (takesOverView) host.hideContextBody();
    if (takesOverView) selectThreadPortal(threadId);
    requestRender();
}

/** Close the tab(s) for `threadId` wherever they live (any channel's strip), destroying
 *  the isolated chat portal and repointing the active view if the closed tab WAS the one
 *  currently shown. Idempotent — a no-op when no thread tab holds this id.
 *
 *  E1: a thread deleted OUTSIDE the app (THREAD_DELETE, or its parent channel going away)
 *  leaves a ghost tab in the strip; this removes it. Unlike the user-facing closeTab (which
 *  only ever touches the CURRENT strip), this searches every strip — the deleted thread may
 *  belong to a channel that isn't the one on screen (its tab just quietly disappears there).
 *  Returns true if anything was closed. */
export function closeThreadTabEverywhere(threadId: string): boolean {
    if (!threadId) return false;
    const matches = allThreadTabs().filter(w => w.content.threadChannelId === threadId);
    if (matches.length === 0) return false;

    const activeId = getActiveWindowId();
    let closedActive = false;
    let activeStrip: DockWindow[] | null = null;
    let activeIdx = -1;

    for (const win of matches) {
        if (win.id === activeId) {
            // Record where the active tab sat in the CURRENT strip so we can activate its
            // neighbour after removal (matches closeTab's right-else-left rule).
            activeStrip = stripFor(getWindowChannelId());
            activeIdx = activeStrip.indexOf(win);
            closedActive = true;
        }
        // Tear down the isolated chat portal (document.body root + overlay node).
        destroyThreadPortal(threadId);
        removeWindowEverywhere(win);
    }

    if (!closedActive) {
        // The closed tab(s) were in a background channel's strip — nothing on screen
        // changed, but repaint so a strip that IS visible drops the ghost tab.
        requestRender();
        return true;
    }

    // The active view was the closed thread — repoint within the CURRENT strip, mirroring
    // closeTab's neighbour selection / empty-state fallback.
    const rest = stripFor(getWindowChannelId());
    if (rest.length === 0) {
        focusEmptyShell(getWindowChannelId());
        setContextActive(getWindowChannelId(), true);
        selectThreadPortal(null);
    } else if (activeStrip) {
        const next = rest[activeIdx] ?? rest[Math.max(0, activeIdx - 1)];
        if (next) {
            setActiveWindow(next);
            reconcileActiveFromCache();
            getActiveWindow().content.seq += 1;
            selectThreadPortal(
                getActiveWindow().content.type === "thread"
                    ? getActiveWindow().content.threadChannelId
                    : null
            );
        }
    }
    hostActions().applyOpenState();
    requestRender();
    return true;
}

/** Rename the strip tab(s) for `threadId` to `name` (E1 — a thread renamed externally,
 *  THREAD_UPDATE). The ThreadBody already self-heals its own label from the store, but a
 *  thread whose tab is NOT the active view never mounts a ThreadBody, so its strip label
 *  would stay stale; this updates every strip's tab directly. Repaints only when a label
 *  actually changed. Returns true if anything was renamed. */
export function renameThreadTab(threadId: string, name: string | null): boolean {
    if (!threadId || !name) return false;
    let changed = false;
    for (const w of allThreadTabs()) {
        if (w.content.threadChannelId === threadId && w.content.name !== name) {
            w.content.name = name;
            changed = true;
        }
    }
    if (changed) requestRender();
    return changed;
}
