/*
 * Sidebar exclusivity — make the dock behave EXACTLY like a native thread in the
 * one exclusive "right slot" Discord gives to a thread / the server member list /
 * the DM user-profile sidebar. The dock is just ONE more competitor for that slot;
 * at most one of {member list, profile sidebar, thread, DockView} shows at a time.
 *
 * THE RULES (agreed model — "the dock acts like a native thread"):
 *  1. Dock OPENS → it takes the slot: collapse the member list / profile sidebar
 *     (remembering, PER CHANNEL, that WE collapsed it) and close any open thread.
 *  2. Dock CLOSES (F9 / X) → restore what it displaced: the member list / profile
 *     reappears (back to the pre-dock state). A thread does NOT reopen — closing a
 *     thread is navigation, not a sidebar toggle (mirrors native).
 *  3. The user opens the member list / a thread / the profile WHILE the dock is open
 *     → the dock YIELDS (closes) so that thing shows; it does NOT come back on its
 *     own when that thing later closes. The slot holds one thing; the switch was the
 *     user's. Member list, thread, and profile are treated identically here.
 *  4. All of this is tracked PER CHANNEL (owed-restore is a Set keyed by channelId),
 *     so switching channels never strands a collapsed/visible member list.
 *
 * Implemented as two directions:
 *  FORWARD (we open) → collapse whatever holds the slot: close the native channel/
 *    thread sidebar, collapse the member list (server) / user-profile sidebar (DM),
 *    and JS-mark the competing nodes so style.css hides them while we're open. A
 *    member list can REAPPEAR async (closing a thread restores it a tick later), so
 *    we also schedule a brief reconcile to re-collapse it (scheduleMemberListReconcile).
 *  REVERSE (the user opens one of those while we hold the slot) → vacate: close the
 *    whole dock and DON'T re-collapse what they just opened (rule 3).
 *
 * VERBATIM HAZARDS (live-verified, expensive to rediscover — see plugin-rewrite.md
 * §6.4 + commits 6c160a5 / d8fc765):
 *  - NO persistent `:has()` CSS over the page/sidebar tree — it stalled composer
 *    typing even with the dock closed. We hide via a targeted JS data attribute
 *    (`data-dockview-exclusive-hidden`) that style.css keys off, set only on the
 *    actual competing nodes, only while open.
 *  - isMemberListShown() must require REAL visibility: a collapsed `membersWrap`
 *    aside can stay MOUNTED, so DOM presence alone is not "shown" (we'd skip the
 *    owed restore). We walk computed style + the bounding rect.
 *  - the self-dispatch flags (selfMemberToggle / selfProfileToggle) distinguish OUR
 *    Flux toggle from a user click. Flux dispatch is SYNCHRONOUS — the subscriber
 *    runs INSIDE dispatch*Toggle — so the flag is reliably true for our own toggles
 *    and false for a real user click.
 */

import { findByProps } from "@webpack";

import { dockVisible } from "../engine/channelMemory";
import { getCurrentChannelId } from "./channel";
import { findPageInner } from "./layout";

const HOST_ID = "dockview-root";
const EXCLUSIVE_HIDDEN_ATTR = "data-dockview-exclusive-hidden";

// Channels where WE collapsed the native member list / DM profile sidebar and owe a
// restore. PER-CHANNEL (not a global boolean): Discord remembers member-list state per
// channel, so a single global flag can never reconcile across channel switches — that
// was the root of the stranded "member list left visible/hidden" bug. We restore a
// channel's list when the dock is hidden in THAT channel (toggle / close / a return
// with the dock hidden), keyed by the channel that was current when we collapsed it.
const memberListOwed = new Set<string>();
const profileSidebarOwed = new Set<string>();
// At most one pending member-list reconcile poll (catches an async reappearance).
let memberReconcileTimer: ReturnType<typeof setTimeout> | null = null;

// Set while WE are the ones firing CHANNEL_TOGGLE_MEMBERS_SECTION (our open-time
// collapse / close-time restore). The action is a pure argument-less toggle Discord
// ALSO fires on a user click of the people-icon button, both through the same Flux
// dispatcher — so the only way to tell our dispatch from a user click in the Flux
// subscriber is this flag. Flux dispatch is synchronous (the subscriber runs INSIDE
// dispatchMemberListToggle), so the flag is reliable.
let selfMemberToggle = false;
// Same self-dispatch guard for DM user-profile sidebar toggles.
let selfProfileToggle = false;

// open.ts registers the "vacate the whole dock" routine here (it owns closePanel +
// the persist/open-state side-effects). Keeping it as a settable slot avoids a host
// import cycle (open.ts imports the sync functions from here). A no-op until set.
let vacateDock: () => void = () => { };
export function registerVacateDock(fn: () => void): void { vacateDock = fn; }

// --- visibility predicates --------------------------------------------------

function elementIsActuallyVisible(el: HTMLElement): boolean {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
        const style = getComputedStyle(cur);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
            return false;
        }
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
}

/** Is the server member list currently shown? Keyed off the `membersWrap` aside
 *  PLUS real visibility — a collapsed member list may remain mounted in the DOM, and
 *  treating mere presence as "shown" makes DockView skip the owed restore (d8fc765). */
export function isMemberListShown(): boolean {
    return Array.from(document.querySelectorAll<HTMLElement>('aside[class*="membersWrap"]'))
        .some(elementIsActuallyVisible);
}

export function isUserProfileSidebarShown(): boolean {
    return !!document.querySelector('aside[aria-labelledby^="user-profile-sidebar-heading"]');
}

function isThreadCard(el: Element | null): boolean {
    return el instanceof HTMLElement && el.matches('div[class*="chatLayerWrapper"]');
}

function findNativeChannelSidebar(inner: HTMLElement | null = findPageInner()): HTMLElement | null {
    if (!inner) return null;
    for (const child of Array.from(inner.children) as HTMLElement[]) {
        if (child.id === HOST_ID) continue;
        if (isThreadCard(child)) return child;
        if (isThreadCard(child.firstElementChild)) return child;
    }
    return null;
}

// --- native toggle dispatch (Discord's own actions) -------------------------

/** Dispatch Discord's own member-list toggle (same action the header button and a
 *  thread fire). Resolved fresh each call so a late webpack chunk can't stale it.
 *  Flagged with `selfMemberToggle` so our Flux subscriber ignores the resulting
 *  synchronous CHANNEL_TOGGLE_MEMBERS_SECTION (it's us, not a user click). */
function dispatchMemberListToggle(): boolean {
    selfMemberToggle = true;
    try {
        const mod = (findByProps as any)?.("toggleMembersSection");
        if (mod && typeof mod.toggleMembersSection === "function") {
            mod.toggleMembersSection();
            return true;
        }
    } catch { /* ignore — fall through, dock still works without the collapse */ }
    finally { selfMemberToggle = false; }
    return false;
}

function dispatchUserProfileSidebarToggle(): boolean {
    selfProfileToggle = true;
    try {
        const mod = (findByProps as any)?.("toggleUserProfileSidebarSection");
        if (mod && typeof mod.toggleUserProfileSidebarSection === "function") {
            mod.toggleUserProfileSidebarSection();
            return true;
        }
    } catch { /* ignore — fall through, dock still works without the collapse */ }
    finally { selfProfileToggle = false; }
    return false;
}

/** Close the native channel/thread sidebar so the dock can take the right slot. */
export function closeNativeChannelSidebar(): boolean {
    if (!findNativeChannelSidebar()) return false;
    try {
        const mod = (findByProps as any)?.("openThreadAsSidebar", "closeChannelSidebar");
        const baseChannelId = getCurrentChannelId();
        if (baseChannelId && mod && typeof mod.closeChannelSidebar === "function") {
            mod.closeChannelSidebar(baseChannelId);
            return true;
        }
    } catch { /* ignore — fallback hiding still prevents visual overlap */ }
    return false;
}

/** Drive the native member-list state to match the dock's open state.
 *  open=true  → if shown, collapse it (button light off) and remember a restore.
 *  open=false → if WE collapsed it and it's still collapsed, restore it. A user
 *               re-show meanwhile is left intact. */
/** After the dock takes the slot the member list can REAPPEAR asynchronously — most
 *  notably, closing a thread (which dock-open does) makes Discord restore the channel's
 *  member list a tick LATER, so the synchronous collapse in syncNativeMemberList misses
 *  it and the list lingers beside the dock (the thread+F9 bug). Poll briefly and
 *  re-collapse it the moment it appears while the dock still holds the slot. Self-
 *  terminates when the list is collapsed, the dock closes, or the budget runs out. */
function scheduleMemberListReconcile(): void {
    if (memberReconcileTimer) return; // one poll in flight at a time
    let tries = 0;
    const tick = () => {
        memberReconcileTimer = null;
        if (!dockVisible()) return;                         // dock closed → stop
        if (isMemberListShown()) { syncNativeMemberList(true); return; } // appeared → collapse
        if (++tries < 6) memberReconcileTimer = setTimeout(tick, 30);
    };
    memberReconcileTimer = setTimeout(tick, 30);
}

export function syncNativeMemberList(open: boolean): void {
    const c = getCurrentChannelId();
    if (open) {
        // Only owe a restore if WE actually collapsed a SHOWN list (never restore one
        // the user had already hidden themselves).
        if (c && isMemberListShown() && dispatchMemberListToggle()) memberListOwed.add(c);
        // The list may also reappear a tick later (e.g. a thread we just closed) — watch
        // for that and collapse it so it never lingers beside the dock.
        scheduleMemberListReconcile();
    } else if (c && memberListOwed.has(c)) {
        if (!isMemberListShown()) dispatchMemberListToggle();
        memberListOwed.delete(c);
    }
}

export function syncNativeProfileSidebar(open: boolean): void {
    const c = getCurrentChannelId();
    if (open) {
        if (c && isUserProfileSidebarShown() && dispatchUserProfileSidebarToggle()) profileSidebarOwed.add(c);
    } else if (c && profileSidebarOwed.has(c)) {
        if (!isUserProfileSidebarShown()) dispatchUserProfileSidebarToggle();
        profileSidebarOwed.delete(c);
    }
}

// --- the JS hide marking (replaces the `:has()` selectors) -------------------

function clearExclusiveRightSlotHidden(root: ParentNode = document): void {
    root.querySelectorAll<HTMLElement>(`[${EXCLUSIVE_HIDDEN_ATTR}]`)
        .forEach(el => el.removeAttribute(EXCLUSIVE_HIDDEN_ATTR));
}

/** Mark the current native sidebar / thread / DM-profile nodes so style.css hides
 *  ONLY them while the dock holds the slot. Never marks our own host. */
export function hideExclusiveRightSlot(inner: HTMLElement | null = findPageInner()): void {
    clearExclusiveRightSlotHidden();
    if (!dockVisible() || !inner) return;

    const host = document.getElementById(HOST_ID);
    const mark = (el: Element | null) => {
        if (!(el instanceof HTMLElement)) return;
        if (el.id === HOST_ID || (host && host.contains(el))) return;
        el.setAttribute(EXCLUSIVE_HIDDEN_ATTR, "true");
    };

    inner.querySelectorAll<HTMLElement>('aside[aria-labelledby^="user-profile-sidebar-heading"]')
        .forEach(mark);

    const children = Array.from(inner.children) as HTMLElement[];
    for (const child of children) {
        if (child.id === HOST_ID) continue;
        if (isThreadCard(child) || isThreadCard(child.firstElementChild)) {
            mark(child);
            continue;
        }
        const next = child.nextElementSibling;
        if (
            child.children.length === 0
            && !(child.textContent || "").trim()
            && (isThreadCard(next) || isThreadCard(next?.firstElementChild ?? null))
        ) {
            mark(child);
        }
    }
}

/** True when a mutated/added node may BE or CONTAIN the exclusive right slot, so the
 *  re-injection observer knows when to re-run the hide marking. */
export function nodeMayContainExclusiveRightSlot(node: Node): boolean {
    if (!(node instanceof HTMLElement)) return false;
    if (node.matches('aside[aria-labelledby^="user-profile-sidebar-heading"], div[class*="chatLayerWrapper"]')) return true;
    return !!node.querySelector('aside[aria-labelledby^="user-profile-sidebar-heading"], div[class*="chatLayerWrapper"]');
}

/** Drop the document state class + page-inner tag + all hide marks, AND restore the
 *  natively-collapsed member list / profile sidebar — so no DockView marks linger
 *  after the plugin stops. A normal close goes through applyOpenState + syncNative*. */
export function restoreHiddenMembers(): void {
    if (memberReconcileTimer) { clearTimeout(memberReconcileTimer); memberReconcileTimer = null; }
    document.documentElement.classList.remove("dockview-open");
    document.querySelectorAll(".dockview-page-inner").forEach(el => el.classList.remove("dockview-page-inner"));
    clearExclusiveRightSlotHidden();
    syncNativeMemberList(false);
    syncNativeProfileSidebar(false);
}

// --- reverse takeover: a native sidebar opens while WE hold the slot ----------
// A real thread and the member list are mutually exclusive, so clicking the people-
// icon button while a thread is open CLOSES the thread. The dock sits in that same
// exclusive slot, so it must do the same. Driven off the Flux toggle actions (wired
// in index.tsx), not a button-DOM listener, so it survives header re-renders + locale.

/** Clear the owed restores BEFORE vacating, so the close machinery can't re-hide the
 *  sidebar the user just opened, then close the whole dock via the registered vacate
 *  routine (open.ts). */
function closeForExclusiveTakeover(): void {
    if (!dockVisible()) return;
    // The user is opening this sidebar — drop THIS channel's owed restores so the
    // vacate (open.ts) can't re-collapse what they just asked for.
    const c = getCurrentChannelId();
    if (c) { memberListOwed.delete(c); profileSidebarOwed.delete(c); }
    vacateDock();
}

/** CHANNEL_TOGGLE_MEMBERS_SECTION subscriber. Fires for BOTH our own dispatches and
 *  a real user click. We act only on a genuine user click (selfMemberToggle false)
 *  while the dock is open: the user is turning the member list ON in our slot, so we
 *  vacate it. The action carries no show/hide flag and the aside mounts a tick LATER
 *  (not synchronously here), so we confirm the list actually came up across a few
 *  short ticks before closing — guarding a spurious toggle that would hide. */
export function onMemberSectionToggle(): void {
    if (selfMemberToggle) return;       // our own collapse/restore — ignore
    if (!dockVisible()) return;               // nothing of ours to evict
    let tries = 0;
    const check = () => {
        if (!dockVisible()) return;           // hidden meanwhile
        if (isMemberListShown()) { closeForExclusiveTakeover(); return; }
        if (++tries < 4) setTimeout(check, 24);
    };
    setTimeout(check, 0);
}

/** USER_PROFILE_SIDEBAR_TOGGLE_SECTION subscriber — the DM analog. We never dispatch
 *  this ourselves, so any fire is a user click; vacate the slot for the profile
 *  sidebar when the dock is open. */
export function onUserProfileSidebarToggle(): void {
    if (selfProfileToggle) return;
    if (!dockVisible()) return;
    closeForExclusiveTakeover();
}

/** SIDEBAR_VIEW_CHANNEL subscriber: a native thread/channel sidebar opened while the
 *  dock owns the right slot — vacate, and do not restore the dock when it later closes. */
export function onChannelSidebarView(): void {
    if (!dockVisible()) return;
    closeForExclusiveTakeover();
}

// --- debug accessors (the __dockView surface reads these) -------------------
export function getMemberListRestorePending(): boolean { const c = getCurrentChannelId(); return c != null && memberListOwed.has(c); }
export function getProfileSidebarRestorePending(): boolean { const c = getCurrentChannelId(); return c != null && profileSidebarOwed.has(c); }
export function getSelfMemberToggle(): boolean { return selfMemberToggle; }
export function getSelfProfileToggle(): boolean { return selfProfileToggle; }
