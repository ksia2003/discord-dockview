/*
 * Native right-slot handling (Batch D — the slim survivor of exclusivity.ts).
 *
 * The dock is the right rail. In Batch D, host/interception.ts SWALLOWS the actions that
 * would open Discord's native right slot (member list / profile sidebar / thread sidebar),
 * so Discord's state never becomes "sidebar open" from a user action — the whole
 * collapse/reseal simulation the old exclusivity.ts ran is gone.
 *
 * What survives here is only what fiber PRIMING + the default-open case still need:
 *  - the hide-mark helpers: a native right-slot node can still appear in two cases — (1)
 *    a fresh client where the member-list section defaults OPEN in the store (not a user
 *    action, so interception doesn't touch it), and (2) OUR OWN priming, which briefly
 *    toggles a native section on to capture its fiber. Both are hidden via a targeted JS
 *    data attribute (style.css keys off it) so nothing ever flashes beside the dock. NO
 *    persistent :has() over the page tree (it stalled composer typing — verbatim hazard).
 *  - the ChannelSectionStore read (getSection), for priming + the debug surface.
 *  - the profile/member toggle dispatchers, used ONLY by priming (host/slotComponents.ts);
 *    interception lets these pass through via the internal self-flags below.
 *  - the seal-bypass passthrough (the context error card's "Open native panel" escape).
 *
 * VERBATIM HAZARDS (live-verified, expensive to rediscover — plugin-rewrite.md §6.4):
 *  - hide via a targeted data attribute on the actual competing node, never a page-wide
 *    :has() selector.
 *  - the self-dispatch flags distinguish OUR priming toggle from a user click; Flux
 *    dispatch is SYNCHRONOUS, so the flag is reliably true while our toggle runs and
 *    interception reads it inside the same dispatch.
 */

import { findByProps } from "@vencord/types/webpack";

import { isSealBypassed } from "../engine/contextTab";
import { getCurrentChannelId } from "./channel";
import { findPageInner } from "./layout";

const HOST_ID = "dockview-root";
const EXCLUSIVE_HIDDEN_ATTR = "data-dockview-exclusive-hidden";

// Set true while WE (priming) fire a native section toggle, so host/interception.ts lets
// that dispatch through instead of swallowing it. Flux dispatch is synchronous, so the
// subscriber/patched-dispatcher runs INSIDE the toggle call and the flag is reliable.
let selfMemberToggle = false;
let selfProfileToggle = false;
let selfVoiceChatToggle = false;

export function isSelfMemberToggle(): boolean { return selfMemberToggle; }
export function isSelfProfileToggle(): boolean { return selfProfileToggle; }
export function isSelfVoiceChatToggle(): boolean { return selfVoiceChatToggle; }

// --- store reads ------------------------------------------------------------

/** The current channel's right-slot section from Discord's ChannelSectionStore
 *  ("MEMBERS" / "PROFILE" / "NONE"). Resolved fresh each call. `withProfile` passes
 *  getSection's second arg (required truthy before it reports PROFILE). */
export function currentSection(withProfile = false): string | null {
    const channelId = getCurrentChannelId();
    if (!channelId) return null;
    try {
        const store = (findByProps as any)?.("getSection", "getGuildSidebarState");
        if (store && typeof store.getSection === "function") return store.getSection(channelId, withProfile);
    } catch { /* store not resolved yet */ }
    return null;
}

/** True in a guild channel (member list applies), false in a DM / group DM. */
function currentChannelIsGuild(): boolean {
    const channelId = getCurrentChannelId();
    if (!channelId) return false;
    try {
        const store = (findByProps as any)?.("getChannel", "hasChannel");
        const channel = store?.getChannel?.(channelId);
        return !!(channel && channel.guild_id);
    } catch { return false; }
}

/** Is the server member list currently shown (per the store, NOT the DOM)? Guild-only. */
export function isMemberListShown(): boolean {
    return currentChannelIsGuild() && currentSection() === "MEMBERS";
}

/** Is the DM user-profile sidebar currently shown (per the store)? */
export function isUserProfileSidebarShown(): boolean {
    return !currentChannelIsGuild() && currentSection(true) === "PROFILE";
}

// --- priming toggle dispatch (used ONLY by host/slotComponents.ts) ----------

/** Dispatch Discord's member-list toggle for PRIMING. Flagged so interception passes it
 *  through. Returns true if the module resolved. */
export function dispatchMemberListToggle(): boolean {
    selfMemberToggle = true;
    try {
        const mod = (findByProps as any)?.("toggleMembersSection");
        if (mod && typeof mod.toggleMembersSection === "function") { mod.toggleMembersSection(); return true; }
    } catch { /* ignore — priming falls back to lazy capture / error card */ }
    finally { selfMemberToggle = false; }
    return false;
}

/** Dispatch Discord's profile-sidebar toggle for PRIMING. Flagged so interception passes
 *  it through. */
export function dispatchUserProfileSidebarToggle(): boolean {
    selfProfileToggle = true;
    try {
        const mod = (findByProps as any)?.("toggleUserProfileSidebarSection");
        if (mod && typeof mod.toggleUserProfileSidebarSection === "function") { mod.toggleUserProfileSidebarSection(); return true; }
    } catch { /* ignore */ }
    finally { selfProfileToggle = false; }
    return false;
}

/** Open/close Discord's native call-chat surface for a hidden, one-shot capture. The
 * self flag lets this action pass host/interception.ts; ordinary user opens are swallowed
 * and focus DockView's permanent CHAT tab instead. */
export function dispatchVoiceChatOpen(channelId: string, open: boolean): boolean {
    if (!channelId) return false;
    selfVoiceChatToggle = true;
    try {
        const mod = (findByProps as any)?.("updateChatOpen");
        if (mod && typeof mod.updateChatOpen === "function") {
            mod.updateChatOpen(channelId, open);
            return true;
        }
    } catch { /* capture falls back to the honest unavailable state */ }
    finally { selfVoiceChatToggle = false; }
    return false;
}

// --- native right-slot detection + hide marking -----------------------------

function isThreadCard(el: Element | null): boolean {
    // A native thread/channel sidebar card. Our OWN dock also carries chatLayerWrapper
    // (DockPanel mimics the native chrome), so callers must exclude #dockview-root.
    return el instanceof HTMLElement && el.matches('div[class*="chatLayerWrapper"]');
}

function clearExclusiveRightSlotHidden(root: ParentNode = document): void {
    root.querySelectorAll<HTMLElement>(`[${EXCLUSIVE_HIDDEN_ATTR}]`)
        .forEach(el => el.removeAttribute(EXCLUSIVE_HIDDEN_ATTR));
}

/** Discord account experiments sometimes wrap membersWrap in another fixed-width flex
 *  item. Hiding only membersWrap then removes the rows but leaves a blank native-sidebar
 *  column beside DockView. Walk outward through the branch that contains ONLY the native
 *  slot, stopping before the shared chat/page container, and collapse that layout root. */
function exclusiveLayoutRoot(el: HTMLElement, inner: HTMLElement): HTMLElement {
    let root = el;
    while (root.parentElement && root.parentElement !== inner) {
        const parent = root.parentElement;
        if (parent.id === HOST_ID || parent.closest(`#${HOST_ID}`)) break;
        // Climb only through wrapper-only branches. The first parent with another child
        // is the shared content row (normally main chat + native sidebar); hiding it
        // would remove the conversation as well.
        if (parent.children.length !== 1) break;
        root = parent;
    }
    return root;
}

/** Mark any native right-slot node (member list / profile aside / thread sidebar) hidden
 *  so style.css display:none-s it. Two callers: applyOpenState on every channel entry (in
 *  case a fresh client renders the member list by default) and priming (to hide a section
 *  it toggled on for fiber capture). Never marks our own host. When the seal bypass is
 *  armed (the context error card's "Open native panel" escape), we clear marks and DON'T
 *  re-mark so the one native panel is actually visible; the bypass is one-shot. */
export function hideExclusiveRightSlot(inner: HTMLElement | null = findPageInner()): void {
    clearExclusiveRightSlotHidden();
    if (isSealBypassed(getCurrentChannelId())) return; // leave the escaped native panel visible
    if (!inner) return;

    // Exclusion by closest() (not a single getElementById+contains): the document can
    // briefly hold TWO #dockview-root placeholders during a channel-view instance overlap
    // (E3), and the member list the context tab renders INSIDE the second dock must never
    // be hide-marked. closest() covers a node inside ANY dock host.
    const mark = (el: Element | null, collapseBranch = false) => {
        if (!(el instanceof HTMLElement)) return;
        if (el.id === HOST_ID || el.closest(`#${HOST_ID}`)) return;
        const target = collapseBranch && inner.contains(el)
            ? exclusiveLayoutRoot(el, inner)
            : el;
        target.setAttribute(EXCLUSIVE_HIDDEN_ATTR, "true");
    };

    // The member list anchor + any account-experiment wrapper that reserves its width.
    document.querySelectorAll<HTMLElement>('[class*="membersWrap"]')
        .forEach(el => mark(el, true));
    inner.querySelectorAll<HTMLElement>('aside[aria-labelledby^="user-profile-sidebar-heading"]')
        .forEach(mark);

    // A direct `/channels/<guild>/<thread>/<message>` navigation (not the ordinary
    // SIDEBAR_VIEW_CHANNEL action intercepted above) nests the native thread card one
    // level inside the chat content row. Looking only at page-inner children misses it
    // and lets that sidebar reserve its full width beside DockView, crushing the main
    // chat to a 1px sliver. Collapse the card's wrapper-only branch; `mark` excludes any
    // card rendered inside our own Dock host, and `exclusiveLayoutRoot` stops before the
    // shared row that also owns the primary chat.
    inner.querySelectorAll<HTMLElement>('div[class*="chatLayerWrapper"]')
        .forEach(el => mark(el, true));

    // A native thread/channel sidebar card among the page-inner's flex children (skip our
    // own dock host, which shares the chatLayerWrapper class).
    for (const child of Array.from(inner.children) as HTMLElement[]) {
        if (child.id === HOST_ID) continue;
        if (isThreadCard(child) || isThreadCard(child.firstElementChild)) { mark(child); continue; }
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

/** True when a mutated/added node may BE or CONTAIN a native right slot, so the fallback
 *  re-injection observer knows when to re-run the hide marking. */
export function nodeMayContainExclusiveRightSlot(node: Node): boolean {
    if (!(node instanceof HTMLElement)) return false;
    if (node.matches('[class*="membersWrap"], aside[aria-labelledby^="user-profile-sidebar-heading"], div[class*="chatLayerWrapper"]')) return true;
    return !!node.querySelector('[class*="membersWrap"], aside[aria-labelledby^="user-profile-sidebar-heading"], div[class*="chatLayerWrapper"]');
}

/** Drop the document state class + page-inner tag + all hide marks (plugin stop) so no
 *  DockView marks linger. Nothing to "restore" any more — interception never collapsed a
 *  section, so the store is exactly as the user/Discord left it. */
export function restoreHiddenMembers(): void {
    document.documentElement.classList.remove("dockview-open");
    document.querySelectorAll(".dockview-page-inner").forEach(el => {
        el.classList.remove("dockview-page-inner", "dockview-unified-layout");
    });
    clearExclusiveRightSlotHidden();
}

// --- debug accessors (the __dockView surface reads these) -------------------
export function getSelfMemberToggle(): boolean { return selfMemberToggle; }
export function getSelfProfileToggle(): boolean { return selfProfileToggle; }
export function getSelfVoiceChatToggle(): boolean { return selfVoiceChatToggle; }
