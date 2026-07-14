/*
 * Sidebar exclusivity (INTERIM — Batch B).
 *
 * The dock is now ALWAYS open (it IS the right rail), so it permanently holds the one
 * exclusive "right slot" Discord gives to a thread / the server member list / the DM
 * user-profile sidebar. This module keeps that slot sealed: whenever the dock is
 * (re)mounted or a channel is entered, it collapses the native member list / profile
 * sidebar and closes any native channel/thread sidebar, and JS-marks the competing
 * nodes so style.css hides them.
 *
 * ★ INTERIM SCOPE (Batch B → Batch D): the dock can no longer YIELD (there is no hide
 * state), so the old REVERSE-takeover paths — vacating the dock when the user opened the
 * member list / a thread / the profile — are DELETED. Proper action interception (so
 * Discord's state never becomes "sidebar open" in the first place) is Batch D's job; the
 * whole module is deleted then. Until then the seal is one-directional: we keep the
 * native panels collapsed on our events, but a native sidebar opened by a user action
 * between our reseal points can still momentarily appear (notably: opening a THREAD does
 * nothing useful in the dock yet — accepted interim quirk, Batch D fixes it).
 *
 * VERBATIM HAZARDS (live-verified, expensive to rediscover — see plugin-rewrite.md
 * §6.4 + commits 6c160a5 / d8fc765):
 *  - NO persistent `:has()` CSS over the page/sidebar tree — it stalled composer
 *    typing. We hide via a targeted JS data attribute (`data-dockview-exclusive-hidden`)
 *    that style.css keys off, set only on the actual competing nodes.
 *  - isMemberListShown() reads Discord's OWN ChannelSectionStore, NOT the DOM. The
 *    collapse/restore we drive is a SYNCHRONOUS Flux dispatch, but the DOM only reflects
 *    it a tick LATER; gating on the lagging DOM stranded the list hidden.
 *  - the self-dispatch flags (selfMemberToggle / selfProfileToggle) distinguish OUR
 *    Flux toggle from a user click. Flux dispatch is SYNCHRONOUS — the subscriber runs
 *    INSIDE dispatch*Toggle — so the flag is reliably true for our own toggles.
 */

import { findByProps } from "@webpack";

import { isSealBypassed } from "../engine/contextTab";
import { settings } from "../settings";
import { getCurrentChannelId } from "./channel";
import { findPageInner } from "./layout";

const HOST_ID = "dockview-root";
const EXCLUSIVE_HIDDEN_ATTR = "data-dockview-exclusive-hidden";

// Discord's member list / DM profile sidebar are GLOBAL client toggles: collapsing the
// list in one channel collapses it everywhere. So the owed-restore is a single GLOBAL
// flag — true ⟺ WE collapsed it and owe a restore (used only on plugin stop, since the
// dock never voluntarily closes). Reconciled on every channel switch via
// syncNative*(true), so the global list ends up collapsed wherever the dock is.
let memberListCollapsedByUs = false;
let profileSidebarCollapsedByUs = false;
// At most one pending member-list reconcile poll (catches an async reappearance).
let memberReconcileTimer: ReturnType<typeof setTimeout> | null = null;

// Set while WE are the ones firing CHANNEL_TOGGLE_MEMBERS_SECTION (our open-time
// collapse / stop-time restore). The action is a pure argument-less toggle Discord ALSO
// fires on a user click of the people-icon button, so the self flag lets a future
// subscriber tell them apart. Flux dispatch is synchronous, so the flag is reliable.
let selfMemberToggle = false;
let selfProfileToggle = false;

// --- visibility predicates --------------------------------------------------

/** The current channel's right-slot section from Discord's ChannelSectionStore
 *  ("MEMBERS" for the member list, "PROFILE" for the DM user-profile sidebar).
 *  Resolved fresh each call so a late webpack chunk can't stale it; null before the
 *  store (or a channel) resolves. `withProfile` passes getSection's second argument,
 *  which the store requires as truthy before it will report the PROFILE section. */
function currentSection(withProfile = false): string | null {
    const channelId = getCurrentChannelId();
    if (!channelId) return null;
    try {
        const store = (findByProps as any)?.("getSection", "getGuildSidebarState");
        if (store && typeof store.getSection === "function") return store.getSection(channelId, withProfile);
    } catch { /* store not resolved yet — treat as no section */ }
    return null;
}

/** True in a guild channel (member list applies), false in a DM / group DM (where the
 *  user-profile sidebar applies instead). */
function currentChannelIsGuild(): boolean {
    const channelId = getCurrentChannelId();
    if (!channelId) return false;
    try {
        const store = (findByProps as any)?.("getChannel", "hasChannel");
        const channel = store?.getChannel?.(channelId);
        return !!(channel && channel.guild_id);
    } catch { return false; }
}

/** Is the server member list currently shown? Answered from Discord's own
 *  ChannelSectionStore, NOT the DOM. Guild-only: a DM's global "members open"
 *  preference also reads as "MEMBERS" but shows no list. */
export function isMemberListShown(): boolean {
    return currentChannelIsGuild() && currentSection() === "MEMBERS";
}

/** Is the DM user-profile sidebar currently shown? The private-channel analog of the
 *  member list, read from the same synchronous ChannelSectionStore. */
export function isUserProfileSidebarShown(): boolean {
    return !currentChannelIsGuild() && currentSection(true) === "PROFILE";
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

/** Dispatch Discord's own member-list toggle. Flagged with `selfMemberToggle` so a Flux
 *  subscriber ignores the resulting synchronous CHANNEL_TOGGLE_MEMBERS_SECTION. */
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

/** After the dock takes the slot the member list can REAPPEAR asynchronously (e.g.
 *  closing a thread restores it a tick later). Poll briefly and re-collapse it. The
 *  dock is always open, so this self-terminates only when the list is collapsed or the
 *  budget runs out. */
function scheduleMemberListReconcile(): void {
    if (memberReconcileTimer) return; // one poll in flight at a time
    let tries = 0;
    const tick = () => {
        memberReconcileTimer = null;
        if (isMemberListShown()) { syncNativeMemberList(true); return; } // appeared → collapse
        if (++tries < 6) memberReconcileTimer = setTimeout(tick, 30);
    };
    memberReconcileTimer = setTimeout(tick, 30);
}

/** Exclusivity is a user setting (General page, default ON). When OFF the dock does NOT
 *  collapse the member list / profile sidebar (they stay open beside the dock). Read
 *  live so a change applies with no reload. (The Batch D rewrite replaces this whole
 *  module; the setting row is preserved until then.) */
function exclusivityEnabled(): boolean {
    try {
        return settings.store.dockExclusivity !== false;
    } catch {
        return true; // settings not resolved yet → the default (on) behaviour
    }
}

export function syncNativeMemberList(open: boolean): void {
    if (open) {
        // Exclusivity off → don't take the slot: leave the member list alone.
        if (!exclusivityEnabled()) return;
        // Only owe a restore if WE actually collapsed a SHOWN list.
        if (isMemberListShown() && dispatchMemberListToggle()) memberListCollapsedByUs = true;
        // The list may reappear a tick later (e.g. a thread we just closed) — watch for
        // that and collapse it so it never lingers beside the dock.
        scheduleMemberListReconcile();
    } else if (memberListCollapsedByUs) {
        if (!isMemberListShown()) dispatchMemberListToggle();
        memberListCollapsedByUs = false;
    }
}

export function syncNativeProfileSidebar(open: boolean): void {
    if (open) {
        if (!exclusivityEnabled()) return;
        if (isUserProfileSidebarShown() && dispatchUserProfileSidebarToggle()) profileSidebarCollapsedByUs = true;
    } else if (profileSidebarCollapsedByUs) {
        if (!isUserProfileSidebarShown()) dispatchUserProfileSidebarToggle();
        profileSidebarCollapsedByUs = false;
    }
}

// --- the JS hide marking (replaces the `:has()` selectors) -------------------

function clearExclusiveRightSlotHidden(root: ParentNode = document): void {
    root.querySelectorAll<HTMLElement>(`[${EXCLUSIVE_HIDDEN_ATTR}]`)
        .forEach(el => el.removeAttribute(EXCLUSIVE_HIDDEN_ATTR));
}

/** Mark the current native sidebar / thread / DM-profile nodes so style.css hides
 *  ONLY them while the dock holds the slot (always, now). Never marks our own host.
 *
 *  SEAL BYPASS (Batch C fallback): when the context tab's acquisition failed and the user
 *  hit "Open native panel", the seal is bypassed for that channel (isSealBypassed) so the
 *  native member list / profile can be reached. In that one case we clear the marks and do
 *  NOT re-mark, so the un-collapsed native panel is actually visible (otherwise the node
 *  keeps display:none and the escape reveals nothing). The bypass is one-shot — cleared on
 *  the next channel switch — so the seal resumes normally after. */
export function hideExclusiveRightSlot(inner: HTMLElement | null = findPageInner()): void {
    clearExclusiveRightSlotHidden();
    if (isSealBypassed(getCurrentChannelId())) return; // leave the native panel visible
    if (!inner) return;

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
 *  natively-collapsed member list / profile sidebar — so no DockView marks linger after
 *  the plugin stops. */
export function restoreHiddenMembers(): void {
    if (memberReconcileTimer) { clearTimeout(memberReconcileTimer); memberReconcileTimer = null; }
    document.documentElement.classList.remove("dockview-open");
    document.querySelectorAll(".dockview-page-inner").forEach(el => el.classList.remove("dockview-page-inner"));
    clearExclusiveRightSlotHidden();
    syncNativeMemberList(false);
    syncNativeProfileSidebar(false);
}

// --- debug accessors (the __dockView surface reads these) -------------------
export function getMemberListRestorePending(): boolean { return memberListCollapsedByUs; }
export function getProfileSidebarRestorePending(): boolean { return profileSidebarCollapsedByUs; }
export function getSelfMemberToggle(): boolean { return selfMemberToggle; }
export function getSelfProfileToggle(): boolean { return selfProfileToggle; }
