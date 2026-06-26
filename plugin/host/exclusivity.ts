/*
 * Sidebar exclusivity — make the dock behave EXACTLY like a native thread in the
 * one exclusive "right slot" Discord gives to a thread / the server member list /
 * the DM user-profile sidebar.
 *
 * Two directions:
 *  FORWARD (we open) → collapse whatever holds the slot: close the native channel/
 *    thread sidebar, collapse the member list (server) / user-profile sidebar (DM),
 *    and JS-mark the competing nodes so style.css hides them while we're open.
 *  REVERSE (the user opens one of those while we hold the slot) → vacate: close the
 *    whole dock and DON'T re-collapse what they just opened.
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

import { dockHasWindows } from "../engine/channelMemory";
import { getCurrentChannelId } from "./channel";
import { findPageInner } from "./layout";

const HOST_ID = "dockview-root";
const EXCLUSIVE_HIDDEN_ATTR = "data-dockview-exclusive-hidden";

// True ⟺ we collapsed the member list and owe a restore when the dock closes.
let memberListRestorePending = false;
// DM analogue: true only when WE collapsed the user-profile sidebar while opening.
let profileSidebarRestorePending = false;

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
export function syncNativeMemberList(open: boolean): void {
    if (open) {
        if (isMemberListShown() && dispatchMemberListToggle()) {
            memberListRestorePending = true;
        }
    } else if (memberListRestorePending) {
        if (!isMemberListShown()) dispatchMemberListToggle();
        memberListRestorePending = false;
    }
}

export function syncNativeProfileSidebar(open: boolean): void {
    if (open) {
        if (isUserProfileSidebarShown() && dispatchUserProfileSidebarToggle()) {
            profileSidebarRestorePending = true;
        }
    } else if (profileSidebarRestorePending) {
        if (!isUserProfileSidebarShown()) dispatchUserProfileSidebarToggle();
        profileSidebarRestorePending = false;
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
    if (!dockHasWindows() || !inner) return;

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
    if (!dockHasWindows()) return;
    memberListRestorePending = false;
    profileSidebarRestorePending = false;
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
    if (!dockHasWindows()) return;            // nothing of ours to evict
    let tries = 0;
    const check = () => {
        if (!dockHasWindows()) return;        // closed meanwhile
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
    if (!dockHasWindows()) return;
    closeForExclusiveTakeover();
}

/** SIDEBAR_VIEW_CHANNEL subscriber: a native thread/channel sidebar opened while the
 *  dock owns the right slot — vacate, and do not restore the dock when it later closes. */
export function onChannelSidebarView(): void {
    if (!dockHasWindows()) return;
    closeForExclusiveTakeover();
}

// --- debug accessors (the __dockView surface reads these) -------------------
export function getMemberListRestorePending(): boolean { return memberListRestorePending; }
export function getProfileSidebarRestorePending(): boolean { return profileSidebarRestorePending; }
export function getSelfMemberToggle(): boolean { return selfMemberToggle; }
export function getSelfProfileToggle(): boolean { return selfProfileToggle; }
