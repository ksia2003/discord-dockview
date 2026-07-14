/*
 * Slot-component acquisition (Batch C).
 *
 * The context tab renders Discord's OWN right-slot content — the guild member list or
 * the DM user-profile sidebar — inside OUR React root. We can't import those components
 * (they're minified, module-private, and drift every build), so we ACQUIRE them at
 * runtime by fiber inspection: find the native panel's DOM anchor, walk its fiber
 * ancestors, and match the FUNCTION COMPONENT by its prop-key SIGNATURE (never by a
 * minified name). The captured `type` is a plain function reference — it stays valid
 * after the native tree unmounts — so we cache it module-level for the session and
 * render our own element of that type with our own `{channel}` props.
 *
 * Prop-key signatures (proven on the live spike, shots/spike-0*):
 *   - member list: ancestor whose memoizedProps keys are EXACTLY {channel, className}.
 *   - DM profile:  ancestor whose memoizedProps keys are EXACTLY {channel}.
 *
 * The signatures are intentionally EXACT-key matches: a looser "has a channel prop"
 * test would grab a wrapping provider higher up the tree (many ancestors carry a
 * channel). The exact-set match pins the leaf render component the native parent wraps.
 *
 * PRIMING (the bootstrap problem): fiber capture needs the native panel to have
 * rendered at least once, but the interim seal (exclusivity.ts) collapses the native
 * panels so they never render → no fiber. So on plugin start we PRIME: ensure the
 * native section is open in the store, let it render while our CSS hide-mark keeps it
 * invisible (a hidden render still builds fibers), capture the TYPE, then re-collapse.
 * The member list is open by default in the store, so its prime is usually a no-op
 * capture with no toggle at all; the profile sidebar is not, so it needs a brief
 * hidden toggle. All of this is measured flash-free on the rig (the competing node
 * carries data-dockview-exclusive-hidden → display:none the whole time).
 *
 * NO module-top webpack access: every findByProps/React touch is inside a function.
 */

import { findByProps } from "@webpack";

import { getCurrentChannelId } from "./channel";

// The captured component TYPES, cached for the session. A capture is a plain function
// reference; it survives the native tree unmounting, so once captured we never need the
// native panel again — we render our own elements of these types.
let memberListType: any = null;
let profileType: any = null;

// --- fiber plumbing ---------------------------------------------------------

/** The React fiber attached to a DOM node (the `__reactFiber$<hash>` expando React 18
 *  hangs off every host node). Resolved by key PREFIX so the per-build hash suffix never
 *  matters. */
function fiberOf(el: Element | null): any {
    if (!el) return null;
    for (const key in el) {
        if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
            return (el as any)[key];
        }
    }
    return null;
}

/** Walk a fiber's `return` ancestry, calling `match` on each function-component fiber's
 *  memoizedProps. Returns the first fiber's `type` (the component) that matches, or null
 *  after `maxHops`. Only FUNCTION components are considered (host fibers have a string
 *  `type`, which we skip). */
function walkForComponent(start: any, match: (propKeys: string[], props: any) => boolean, maxHops = 40): any {
    let f = start;
    let hops = 0;
    while (f && hops++ < maxHops) {
        const t = f.type;
        const props = f.memoizedProps;
        if (typeof t === "function" && props && typeof props === "object") {
            const keys = Object.keys(props);
            try {
                if (match(keys, props)) return t;
            } catch { /* a match predicate throw just skips this fiber */ }
        }
        f = f.return;
    }
    return null;
}

/** True when `keys` is EXACTLY `want` (same members, same count) — an order-independent
 *  set equality. Pins the leaf render component instead of a wrapping provider. */
function keysAre(keys: string[], want: string[]): boolean {
    if (keys.length !== want.length) return false;
    for (const k of want) if (!keys.includes(k)) return false;
    return true;
}

// --- anchors ----------------------------------------------------------------

/** The member-list DOM anchor Discord renders (a `membersWrap`-classed element). It may
 *  be hidden (display:none) by our seal, but a hidden node still exists + carries a
 *  fiber, so this resolves during priming. */
function memberAnchor(): Element | null {
    return document.querySelector('[class*="membersWrap"]');
}

/** The DM user-profile sidebar anchor (its labelled <aside>). */
function profileAnchor(): Element | null {
    return document.querySelector('aside[aria-labelledby^="user-profile-sidebar-heading"]');
}

const EXCLUSIVE_HIDDEN_ATTR = "data-dockview-exclusive-hidden";
const HOST_ID = "dockview-root";

/** Mark any native right-slot anchor (member list / profile aside) hidden IMMEDIATELY, so
 *  a panel we toggled on during priming is display:none before it can paint (style.css
 *  keys off this attribute). Never marks our own host. In patched mount mode there is no
 *  MutationObserver, so priming hides the primed panel itself here. Idempotent. */
function hidePrimedAnchors(): void {
    const host = document.getElementById(HOST_ID);
    const mark = (el: Element | null) => {
        if (!(el instanceof HTMLElement)) return;
        if (el.id === HOST_ID || (host && host.contains(el))) return;
        el.setAttribute(EXCLUSIVE_HIDDEN_ATTR, "true");
    };
    mark(memberAnchor());
    mark(profileAnchor());
    // The profile aside can sit inside a wrapping right-slot column; also mark the aside's
    // nearest positioned ancestor sibling of chat if it carries the same aria label.
    document.querySelectorAll('aside[aria-labelledby^="user-profile-sidebar-heading"]').forEach(mark);
}

// --- capture ----------------------------------------------------------------

/** Try to capture the member-list component from the live tree. Returns true if a fresh
 *  type was captured (or one was already cached and the anchor confirms it's still
 *  present). Caches module-level on success. */
export function captureMemberList(): boolean {
    if (memberListType) return true;
    const fiber = fiberOf(memberAnchor());
    if (!fiber) return false;
    const type = walkForComponent(fiber, keys => keysAre(keys, ["channel", "className"]));
    if (type) { memberListType = type; return true; }
    return false;
}

/** Try to capture the DM profile-sidebar component from the live tree. */
export function captureProfile(): boolean {
    if (profileType) return true;
    const fiber = fiberOf(profileAnchor());
    if (!fiber) return false;
    const type = walkForComponent(fiber, keys => keysAre(keys, ["channel"]));
    if (type) { profileType = type; return true; }
    return false;
}

export function getMemberListType(): any { return memberListType; }
export function getProfileType(): any { return profileType; }

/** Drop the cached types (plugin stop, or a self-test that wants a fresh acquisition).
 *  A re-capture happens lazily on the next context-tab render / prime. */
export function invalidateSlotComponents(): void {
    memberListType = null;
    profileType = null;
}

// --- channel resolution -----------------------------------------------------

/** Resolve a Channel OBJECT for `channelId` from Discord's ChannelStore. The captured
 *  components take a `channel` object prop (not an id), and they're frozen to the channel
 *  they were captured with — so we re-render with the CURRENT channel's object on every
 *  channel select. Null before the store resolves / for an unknown id. */
export function getChannelObject(channelId: string | null): any {
    if (!channelId) return null;
    try {
        const store = (findByProps as any)?.("getChannel", "hasChannel");
        return store?.getChannel?.(channelId) ?? null;
    } catch {
        return null;
    }
}

/** What the context tab should SHOW for a channel, matching native:
 *   - "members" — a guild channel OR a group DM (Discord shows a member list in both).
 *   - "profile" — a 1:1 DM (the user-profile sidebar).
 *   - "empty"   — @me / no channel / a channel type with no sensible slot content.
 *  Discord channel types: 1 = DM, 3 = GROUP_DM; anything with a guild_id is a guild
 *  channel (text/voice/forum/thread all carry one and native shows the member list). */
export type ContextKind = "members" | "profile" | "empty";
export function contextKindFor(channelId: string | null): ContextKind {
    const ch = getChannelObject(channelId);
    if (!ch) return "empty";
    if (ch.guild_id) return "members";     // any guild channel → member list
    if (ch.type === 3) return "members";   // group DM → member list (native parity)
    if (ch.type === 1) return "profile";   // 1:1 DM → user-profile sidebar
    return "empty";
}

// --- priming ----------------------------------------------------------------
// The store + toggle actions live in exclusivity.ts's world; we re-resolve them here so
// this module owns its own priming and doesn't couple to the seal's internals. Both are
// plain findByProps lookups (the exact modules the seal drives).

function sectionStore(): any {
    try { return (findByProps as any)?.("getSection", "getGuildSidebarState") ?? null; }
    catch { return null; }
}
function memberToggle(): any {
    try { return (findByProps as any)?.("toggleMembersSection") ?? null; }
    catch { return null; }
}
function profileToggle(): any {
    try { return (findByProps as any)?.("toggleUserProfileSidebarSection") ?? null; }
    catch { return null; }
}

/** The current channel's store section ("MEMBERS" / "PROFILE" / null). `withProfile`
 *  passes getSection's second arg (required truthy before it reports PROFILE). */
function storeSection(withProfile = false): string | null {
    const cid = getCurrentChannelId();
    if (!cid) return null;
    const store = sectionStore();
    try { return store?.getSection?.(cid, withProfile) ?? null; }
    catch { return null; }
}

/** Prime + capture the member list. If the store section isn't MEMBERS, toggle it on
 *  (a HIDDEN render — the seal's data-attribute keeps the node display:none), poll a few
 *  frames for the anchor to mount, capture, then restore the store to its prior state.
 *  Resolves true once the type is cached (or immediately if already cached). The member
 *  list is usually open by default (a straight capture, no toggle). */
export async function primeMemberList(): Promise<boolean> {
    if (memberListType) return true;
    if (captureMemberList()) return true;

    const toggle = memberToggle();
    const wasOpen = storeSection() === "MEMBERS";
    if (!wasOpen && toggle?.toggleMembersSection) {
        try { toggle.toggleMembersSection(); } catch { /* fall through */ }
    }
    const ok = await pollCapture(captureMemberList);
    // Restore the store to its prior state (the seal re-collapses on channel select
    // anyway, but leave the store as we found it here to avoid a visible flip).
    if (!wasOpen && toggle?.toggleMembersSection && storeSection() === "MEMBERS") {
        try { toggle.toggleMembersSection(); } catch { /* ignore */ }
    }
    return ok;
}

/** Prime + capture the DM profile sidebar. The profile section is NOT open by default,
 *  so this nearly always needs a brief hidden toggle, then a poll for the aside to mount
 *  (the profile card takes a few commits to render). Same shape as primeMemberList. */
export async function primeProfile(): Promise<boolean> {
    if (profileType) return true;
    if (captureProfile()) return true;

    const toggle = profileToggle();
    const wasOpen = storeSection(true) === "PROFILE";
    if (!wasOpen && toggle?.toggleUserProfileSidebarSection) {
        try { toggle.toggleUserProfileSidebarSection(); } catch { /* fall through */ }
    }
    hidePrimedAnchors(); // mark hidden immediately so the toggled panel can't paint visible
    const ok = await pollCapture(captureProfile);
    if (!wasOpen && toggle?.toggleUserProfileSidebarSection && storeSection(true) === "PROFILE") {
        try { toggle.toggleUserProfileSidebarSection(); } catch { /* ignore */ }
    }
    return ok;
}

/** Poll `attempt` across a handful of animation frames (a just-toggled section can take
 *  several commits to mount its anchor). Resolves true on the first success, false after
 *  the budget. The whole window is < ~250ms, and the competing node is display:none the
 *  entire time (the seal's hide-mark), so this is flash-free. */
function pollCapture(attempt: () => boolean): Promise<boolean> {
    return new Promise(resolve => {
        const raf = (window as any).requestAnimationFrame || ((cb: any) => setTimeout(cb, 16));
        let tries = 0;
        const tick = () => {
            // Hide the primed panel BEFORE we attempt (and each frame it may (re)mount), so
            // a panel toggled on for capture never flashes visible during priming.
            hidePrimedAnchors();
            if (attempt()) { resolve(true); return; }
            if (++tries >= 15) { resolve(false); return; } // ~15 frames ceiling
            raf(tick);
        };
        // Hide synchronously first (the toggle already ran), then poll.
        hidePrimedAnchors();
        raf(tick);
    });
}
