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
 * PRIMING (the bootstrap problem): member/profile fiber capture needs the native panel to
 * have rendered at least once, but action interception (host/interception.ts) swallows the
 * user toggles so the sections never open → no fiber. So on plugin start we PRIME through
 * host/nativePanels' FLAGGED toggle dispatchers (the self-flag makes interception let OUR
 * toggle through): open the section, let it render while our hide-mark keeps it invisible
 * (a hidden render still builds fibers), capture the TYPE, then toggle it back off. All of
 * this is measured flash-free on the rig (the primed node carries
 * data-dockview-exclusive-hidden → display:none the whole time).
 *
 * The CHAT capture (thread tabs) needs NO priming: the main chat is always in the tree, so
 * captureChat reads its type + a props snapshot straight from the always-rendered fiber.
 *
 * NO module-top webpack access: every findByProps/React touch is inside a function.
 */

import { findByProps } from "@webpack";

import { getCurrentChannelId } from "./channel";
import { findPageInner } from "./layout";
import { dispatchMemberListToggle, dispatchUserProfileSidebarToggle } from "./nativePanels";

// The captured component TYPES, cached for the session. A capture is a plain function
// reference; it survives the native tree unmounting, so once captured we never need the
// native panel again — we render our own elements of these types.
let memberListType: any = null;
let profileType: any = null;
// The chat component TYPE, captured from the MAIN chat's fiber (always rendered — no
// priming needed). Rendered with a THREAD's channel props to become a dock thread tab.
let chatType: any = null;
// A snapshot of the main chat's memoizedProps at capture time — the frozen "shape" of a
// channel-view's props. A thread tab clones this and swaps the channel-identity fields, so
// every prop the chat component expects (guild, layout, gating flags, …) is present.
let chatBaseProps: any = null;

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

/** The MAIN chat DOM anchor (the `chat_`-classed element Discord always renders on a
 *  channel page). Always present in a channel — no priming needed to capture from it. */
function chatAnchor(): Element | null {
    return document.querySelector('[class*="chatContent"], [class*="chat_"]');
}

const EXCLUSIVE_HIDDEN_ATTR = "data-dockview-exclusive-hidden";
const HOST_ID = "dockview-root";

/** Mark any native right-slot anchor (member list / profile aside) hidden IMMEDIATELY, so
 *  a panel we toggled on during priming is display:none before it can paint (style.css
 *  keys off this attribute). Never marks our own host. In patched mount mode there is no
 *  MutationObserver, so priming hides the primed panel itself here. Idempotent. */
function hidePrimedAnchors(): void {
    // closest() exclusion (not getElementById+contains): with two overlapped dock
    // placeholders (E3) the member list inside the SECOND dock must not be marked.
    const mark = (el: Element | null) => {
        if (!(el instanceof HTMLElement)) return;
        if (el.id === HOST_ID || el.closest(`#${HOST_ID}`)) return;
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
    if (forceSidebarUnavailable) return false; // test seam: sidebar route forced off
    const fiber = fiberOf(profileAnchor());
    if (!fiber) return false;
    const type = walkForComponent(fiber, keys => keysAre(keys, ["channel"]));
    if (type) { profileType = type; return true; }
    return false;
}

export function getMemberListType(): any { return memberListType; }
export function getProfileType(): any { return profileType; }

// --- chat capture (thread tabs) ---------------------------------------------
// The thread chat is Discord's channel-view chat component. It's the SAME component the
// main chat renders (always in the tree), so we capture its TYPE + a props snapshot from
// the main chat with no priming, then render it with a THREAD's channel props. The spike
// proved this yields a live thread chat (messages + working composer) — the captured
// component subscribes to the thread's message store, we just have to fetch its messages.

/** The main chat component's prop SIGNATURE — the exact leaf channel-view is pinned by
 *  requiring these keys all present (a wrapper higher up carries only a subset). */
const CHAT_SIGNATURE = ["guildId", "channelId", "channel", "channelName", "parentChannel"];

/** Capture the chat component TYPE + a base-props snapshot from the MAIN chat's fiber.
 *  The main chat is always rendered, so this needs no priming. Caches module-level on
 *  success (the type survives re-renders; the props snapshot is refreshed each capture so
 *  it stays a current channel-view shape). Returns true once the type is cached. */
export function captureChat(): boolean {
    const fiber = fiberOf(chatAnchor());
    if (!fiber) return chatType != null;
    // The Mana provider rides along (needed for popouts inside the portal chat) — same
    // anchor, so capture it in the same pass. Failure is non-fatal (chat still renders;
    // popouts just stay unavailable until a later capture lands).
    try { captureProviderStack(); } catch { /* ignore */ }
    // Walk for the leaf channel-view: a function component carrying the full signature.
    let f = fiber;
    let hops = 0;
    while (f && hops++ < 45) {
        const t = f.type;
        const props = f.memoizedProps;
        if (typeof t === "function" && props && typeof props === "object"
            && CHAT_SIGNATURE.every(k => k in props)) {
            chatType = t;
            chatBaseProps = props;
            return true;
        }
        f = f.return;
    }
    return chatType != null;
}

export function getChatType(): any { return chatType; }

// --- provider-stack capture (portal popout support) ---------------------------
// The captured chat renders fine bare, but Discord's POPOUT-opening paths (user popout,
// expression picker) read React CONTEXTS the app shell provides — the Mana design-system
// context (its absence warns "useManaContext must be used within a ManaContext.Provider"
// and no-ops the click, rig-proven), plus the window/app contexts that route a popout to
// its window's layer containers. Rather than name-match individual contexts (drift-prone,
// and the misses fail silently), we capture the ENTIRE provider ancestry above the main
// chat — every context-provider fiber's TYPE + its live value — and the portal re-wraps
// the chat in the same stack, innermost-first, exactly replicating the environment the
// chat had in place. The values are the app's LIVE objects (layer containers, history,
// theme...), so popouts mount into the app's own layers (z≈1002), far above the portal
// overlay by construction. Values are refreshed on every capture pass.
let providerStack: Array<{ type: any; value: any }> | null = null;

// The React fiber tag for a ContextProvider fiber — stable across React 16→19. Matching
// by TAG (not by the type object's shape) is the authoritative test: a shape test that
// admits react.context objects catches CONSUMERS too, and re-rendering a consumer as an
// element type crashes the portal render (rig-proven: the whole portal root unmounted).
const CONTEXT_PROVIDER_TAG = 10;

/** Capture the provider ancestry above the main chat (nearest-first). Cached; refreshed
 *  per pass so the values stay current. Only fibers whose TAG says ContextProvider are
 *  taken; re-rendering the exact captured fiber type reproduces what React itself did. */
export function captureProviderStack(): boolean {
    const fiber = fiberOf(chatAnchor());
    if (!fiber) return providerStack != null;
    const found: Array<{ type: any; value: any }> = [];
    let f = fiber.return;
    let hops = 0;
    while (f && hops++ < 400) {
        if (f.tag === CONTEXT_PROVIDER_TAG && f.type) {
            found.push({ type: f.type, value: f.memoizedProps ? f.memoizedProps.value : undefined });
        }
        f = f.return;
    }
    if (found.length) { providerStack = found; return true; }
    return providerStack != null;
}

/** The captured provider stack, NEAREST-first (wrap iteratively to put the root-most
 *  provider outermost), or null before capture. */
export function getProviderStack(): Array<{ type: any; value: any }> | null {
    return providerStack;
}

// --- theme-context capture (profile theming parity) ---------------------------
// The redesigned DM profile sidebar derives its light/dark base from the APP theme, not
// from a prop: its `themeOverride` is `useThemeContext().theme` (Discord's ThemeContext).
// Rendered in OUR detached root that ThemeContext.Provider is absent, so React's
// `useContext` falls back to the context's DEFAULT value — whose `theme` is "light" — and
// the profile paints a WHITE body that clashes with the dark app (rig-proven: the
// `themeContainer` gets `theme-light images-light` → `--profile-gradient-*` resolve white).
// We fix it at the root the same way the portal fixes popouts: capture Discord's own
// ThemeContext + its LIVE value from the app tree, and wrap our captured profile in that
// provider. The live value is the app's real theme object — its `theme` field is dark for a
// default account, and it carries the ambient adaptive `primaryColor`/`secondaryColor`/
// `gradient` when the profile has a custom theme — so the profile renders EXACTLY as native:
// custom-theme users keep their colours, default users follow the dark app theme. No
// hardcoded colour, no theme string we invent — Discord's own context value verbatim.
let themeContextType: any = null;
let themeContextValue: any = null;

/** Resolve Discord's ThemeContext object (the thing you pass to `React.createElement(ctx
 *  .Provider, …)`). Module signature: exports the hook `wR` + the context `Dx` + the default
 *  value `PQ`. Cached once resolved (the module reference is stable for the session). */
function resolveThemeContext(): any {
    if (themeContextType) return themeContextType;
    try {
        const mod = (findByProps as any)?.("wR", "Dx", "PQ");
        const ctx = mod?.Dx;
        // A React context object is identified by its $$typeof + a Provider — never by a
        // minified key alone.
        if (ctx && ctx.$$typeof && ctx.Provider) { themeContextType = ctx; return ctx; }
    } catch { /* fall through — profile still renders bare (its old behaviour) */ }
    return null;
}

/** True when the app's live ThemeContext value has been captured. */
function isThemeValue(v: any): boolean {
    return !!v && typeof v === "object" && "theme" in v
        && ("primaryColor" in v || "gradient" in v || "density" in v);
}

/** Capture the app's LIVE ThemeContext value by walking a live fiber's ancestry for the
 *  ThemeContext.Provider (matched by TAG + the theme value shape, not a minified name).
 *  Prefers the main chat anchor (always present); falls back to the profile aside if the
 *  chat isn't found. Refreshed each pass so the value tracks a live theme change. Returns
 *  true once a value is cached. */
export function captureThemeContext(): boolean {
    resolveThemeContext();
    const anchor = chatAnchor() || profileAnchor() || memberAnchor();
    const fiber = fiberOf(anchor);
    if (!fiber) return themeContextValue != null;
    let f = fiber;
    let hops = 0;
    while (f && hops++ < 400) {
        if (f.tag === CONTEXT_PROVIDER_TAG && f.type && f.memoizedProps) {
            const v = f.memoizedProps.value;
            if (isThemeValue(v)) { themeContextValue = v; return true; }
        }
        f = f.return;
    }
    return themeContextValue != null;
}

/** Discord's ThemeContext object (for wrapping our captured profile in its Provider), or
 *  null before it resolves. */
export function getThemeContextType(): any { return resolveThemeContext(); }

/** The app's live ThemeContext value (dark for a default account, carrying adaptive
 *  profile colours when present), or null before capture. */
export function getThemeContextValue(): any {
    // Refresh opportunistically so a theme change (or a first render before any capture)
    // still lands a current value; cheap (one fiber walk) and only on the context-tab path.
    captureThemeContext();
    return themeContextValue;
}

/** Build the props to render the chat component for a THREAD. Clones the captured main-
 *  chat props (so every flag/context the component reads is present) and swaps the
 *  channel-identity fields to the thread + its parent. Returns null if we haven't captured
 *  a base-props shape yet (the caller shows a loading card until capture lands). */
export function buildThreadProps(threadId: string | null): any {
    if (!threadId || !chatBaseProps) return null;
    const thread = getChannelObject(threadId);
    if (!thread) return null;
    const parent = getChannelObject(thread.parent_id ?? null);
    return {
        ...chatBaseProps,
        channel: thread,
        channelId: thread.id,
        channelName: thread.name,
        formattedChannelName: thread.name,
        parentChannel: parent ?? chatBaseProps.parentChannel ?? null,
        guildId: thread.guild_id ?? chatBaseProps.guildId,
        // The thread tab is its own chat surface, not a sidebar-of-a-channel view — drop
        // any inherited sidebar section so the component renders as a full channel chat.
        section: undefined,
        channelSidebarState: undefined
    };
}

/** Ensure the thread's messages are loaded into Discord's MessageStore. The captured chat
 *  component subscribes to the store but does NOT auto-fetch when it isn't the *selected*
 *  channel (the native thread sidebar triggers this on open) — so on thread-tab open we
 *  drive the same fetch. Idempotent + safe: a no-op if already loaded / mid-fetch. */
export function loadThreadMessages(threadId: string | null): void {
    if (!threadId) return;
    try {
        const store = (findByProps as any)?.("getMessages", "getMessage");
        const msgs = store?.getMessages?.(threadId);
        // `ready` is true once a fetch has landed; skip a redundant re-fetch.
        if (msgs && msgs.ready) return;
    } catch { /* fall through — attempt the fetch */ }
    try {
        const fetcher = (findByProps as any)?.("fetchMessages");
        fetcher?.fetchMessages?.({ channelId: threadId, limit: 50 });
    } catch { /* the chat still renders its chrome + composer; messages fill when reachable */ }
}

/** Drop the cached types (plugin stop, or a self-test that wants a fresh acquisition).
 *  A re-capture happens lazily on the next context-tab render / prime. */
export function invalidateSlotComponents(): void {
    memberListType = null;
    profileType = null;
    chatType = null;
    chatBaseProps = null;
    providerStack = null;
    themeContextType = null;
    themeContextValue = null;
    profileSectionUnavailableFlag = false;
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
// Fiber capture needs the native section to have rendered once. With interception
// swallowing user toggles, priming drives the toggle through host/nativePanels' FLAGGED
// dispatchers (dispatchMemberListToggle / dispatchUserProfileSidebarToggle) — the self-flag
// makes host/interception.ts let our toggle through, and the hide-mark keeps the toggled
// panel display:none so it never flashes. The store read is a plain findByProps lookup.

/** The current channel's store section ("MEMBERS" / "PROFILE" / null). `withProfile`
 *  passes getSection's second arg (required truthy before it reports PROFILE). */
function storeSection(withProfile = false): string | null {
    const cid = getCurrentChannelId();
    if (!cid) return null;
    try {
        const store = (findByProps as any)?.("getSection", "getGuildSidebarState");
        return store?.getSection?.(cid, withProfile) ?? null;
    } catch { return null; }
}

/** Prime + capture the member list. If the store section isn't MEMBERS, toggle it on via
 *  the flagged dispatcher (a HIDDEN render — the hide-mark keeps the node display:none),
 *  poll a few frames for the anchor to mount, capture, then restore the store to its prior
 *  state. Resolves true once the type is cached (or immediately if already cached). */
export async function primeMemberList(): Promise<boolean> {
    if (memberListType) return true;
    if (captureMemberList()) return true;

    const wasOpen = storeSection() === "MEMBERS";
    if (!wasOpen) dispatchMemberListToggle();
    hidePrimedAnchors(); // hide immediately so a toggled-on panel can't paint visible
    const ok = await pollCapture(captureMemberList);
    // Restore the store to its prior state (leave it as we found it — interception keeps
    // the store from flipping otherwise, so we must undo our own priming toggle).
    if (!wasOpen && storeSection() === "MEMBERS") dispatchMemberListToggle();
    return ok;
}

/** Prime + capture the DM profile sidebar. The profile section is NOT open by default, so
 *  this nearly always needs a brief flagged hidden toggle, then a poll for the aside to
 *  mount (the profile card takes a few commits to render). Same shape as primeMemberList. */
// Capability flag: Discord sometimes ships the DM profile sidebar DISABLED for some
// builds/accounts (the DM header button reads "Show User Profile (Unavailable)", and even
// with no plugin installed the toggle dispatch doesn't flip ChannelSectionStore — verified
// naked on the rig 2026-07-16). That is NOT signature drift: the sidebar MOUNT SITE is gated
// off, so priming can't capture from it. It is NOT an error state either — the captured
// profile TYPE is generic and cached for the session, so any DM viewed while the sidebar was
// enabled leaves a type that renders every DM's profile through the off-window; only a session
// whose FIRST DM view lands inside the off-window has no type yet, and that shows a calm
// self-healing LOADING (ContextTabBody), never a placeholder. The flag is detected
// behaviourally (our flagged toggle passed interception yet the store never entered PROFILE and
// no aside mounted) — no locale strings, no experiment names — and self-heals: a later prime
// that succeeds clears it.
let profileSectionUnavailableFlag = false;
export function isProfileSectionUnavailable(): boolean { return profileSectionUnavailableFlag; }

// TEST SEAM (not a production path): the sidebar off-state is Discord-controlled and not
// reproducible on demand, so the rig suite forces it. When on, primeProfile reports the
// sidebar UNAVAILABLE without perturbing Discord's DOM/stores (patching those breaks the
// channel-view the dock is patched onto). It deliberately does NOT clear an already-captured
// profileType — that is the whole point: it proves the CACHED generic type still renders a
// real profile through the off-window. Off in all normal use; only the debug surface flips it.
let forceSidebarUnavailable = false;
export function setForceProfileSidebarUnavailable(on: boolean): void {
    forceSidebarUnavailable = !!on;
    if (on) profileSectionUnavailableFlag = true;
}

// Prime-verdict trace (debug surface primeLog) — the unavailable-detection misfired
// silently once; keep the last few verdicts inspectable.
const primeTrace: string[] = [];
export function primeDebugLog(): string[] { return [...primeTrace]; }
function plog(s: string): void {
    primeTrace.push(`${Date.now() % 100000} ${s}`);
    if (primeTrace.length > 20) primeTrace.shift();
}

export async function primeProfile(): Promise<boolean> {
    if (profileType) { plog("profile: cached"); return true; }
    // Test seam: sidebar forced off — report unavailable (the calm self-healing state), no
    // capture attempt, no Discord perturbation. A cached type would have returned above.
    if (forceSidebarUnavailable) { profileSectionUnavailableFlag = true; plog("profile: forced-unavailable"); return false; }
    if (captureProfile()) { plog("profile: direct-capture"); return true; }

    // Snapshot the panel surface BEFORE toggling: the unavailable-vs-drift discriminator
    // is whether the toggle mounts ANY new panel node at all. On this Discord the section
    // store happily flips to PROFILE while the RENDER site is gated off ("(Unavailable)")
    // and nothing mounts — that's unavailability. A signature/anchor DRIFT still mounts
    // SOMETHING (a panel whose class/aria we no longer match) — that's drift, keep the
    // error card + native bypass.
    const inner = findPageInner();
    const kidsBefore = inner ? inner.children.length : -1;
    const asidesBefore = document.querySelectorAll("aside").length;

    const wasOpen = storeSection(true) === "PROFILE";
    if (!wasOpen) dispatchUserProfileSidebarToggle();
    hidePrimedAnchors(); // mark hidden immediately so the toggled panel can't paint visible
    const ok = await pollCapture(captureProfile);
    const flipped = storeSection(true) === "PROFILE";
    // Measure growth BEFORE restoring the toggle (the restore unmounts what mounted).
    const grewPanel = document.querySelectorAll("aside").length > asidesBefore
        || (kidsBefore >= 0 && inner != null && inner.isConnected && inner.children.length > kidsBefore);
    plog(`profile: ok=${ok} wasOpen=${wasOpen} flipped=${flipped} grew=${grewPanel} anchor=${!!profileAnchor()}`);
    if (ok) profileSectionUnavailableFlag = false;
    else if (!wasOpen && !grewPanel) profileSectionUnavailableFlag = true;
    if (!wasOpen && flipped) dispatchUserProfileSidebarToggle();
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
