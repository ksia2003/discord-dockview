/*
 * The context-tab body: renders Discord's own right-slot content (member list in a guild
 * channel, profile sidebar in a DM) inside our React root, from the component TYPES
 * acquired by host/slotComponents.ts.
 *
 * The captured type is a plain function component; we render `createElement(type,
 * { channel })` with the CURRENT channel's object (the components are frozen to their
 * `channel` prop, so we re-render with fresh props on channel select — DockPanel keys the
 * body on the channel id so a switch remounts it). Member list also wants a `className`;
 * we hand it our own wrapper class so the native card styling (background/sizing) comes
 * from the dock container via SEMANTIC CSS variables, not the native parent wrapper.
 *
 * DM PROFILE — session cache + self-heal, NO placeholder: the profile TYPE (the sidebar
 * wrapper captured from the native aside) is GENERIC — it renders ANY DM's profile — and is
 * cached module-level for the session on the FIRST DM view. So once any DM is opened while
 * Discord has the sidebar enabled, EVERY DM (including ones opened later during a transient
 * "(Unavailable)" window) renders a real profile from that cache. When Discord ships the
 * sidebar disabled AND no type is cached yet (a session whose first-ever DM view lands inside
 * the off-window), the body shows a calm LOADING state that SELF-HEALS — it re-attempts the
 * capture every few seconds and becomes a real profile the instant the sidebar is re-enabled.
 * The old "Discord turned it off → empty card" placeholder is gone; that state is now either a
 * real cached profile or a self-healing loading, never a dead-end message.
 *
 * FALLBACK CARD: the honest error card (StateCards grammar, "Open native panel" escape) is the
 * TRUE last resort ONLY — the capture SIGNATURE genuinely drifted after a Discord update (a
 * different, honest failure). Never shown for the calm "sidebar unavailable" state. Never a
 * silent break, never a crash that takes the dock down.
 */

import { React } from "@vencord/types/webpack/common";

import { requestRender } from "../engine/forceRender";
import { armSealBypass } from "../engine/contextTab";
import { hostActions } from "../engine/hostBridge";
import { getCurrentChannelMemId } from "../engine/channelMemory";
import {
    currentSection, dispatchMemberListToggle, dispatchUserProfileSidebarToggle
} from "../host/nativePanels";
import {
    captureMemberList, captureProfile, contextKindFor, getChannelObject, getMemberListType,
    getProfileType, getThemeContextType, getThemeContextValue, isProfileSectionUnavailable,
    primeMemberList, primeProfile
} from "../host/slotComponents";
import type { ContextKind } from "../host/slotComponents";
import { STRINGS } from "../strings";
import { ChannelOverview } from "./ChannelOverview";

/** Wrap a captured Discord component in the app's own ThemeContext.Provider so the
 *  components resolve the SAME theme they do natively. The redesigned DM profile reads its
 *  light/dark base from `useThemeContext().theme`; in our detached root that provider is
 *  absent, so React falls back to the context DEFAULT (theme "light") and the profile paints
 *  a white body. Re-supplying Discord's context + its LIVE value (dark for a default account,
 *  carrying adaptive profile colours when the user has a custom theme) makes ours match native
 *  exactly — no hardcoded colour, Discord's own value verbatim. If the context/value isn't
 *  captured yet we render the element bare (its prior behaviour) — the effect below drives the
 *  capture and re-renders once it lands. */
function withAppTheme(el: any) {
    const ctx = getThemeContextType();
    const value = getThemeContextValue();
    if (!ctx || value == null) return el;
    return React.createElement(ctx.Provider, { value }, el);
}

/** Render the guild member list for `channel` from the captured type, or null if the
 *  type isn't acquired yet (the caller falls to loading/error). */
function renderMembers(channel: any) {
    const type = getMemberListType();
    if (!type || !channel) return null;
    // Our own wrapper class so the container (not the native parent) supplies styling.
    return withAppTheme(React.createElement(type, { channel, className: "dockview-context-native" }));
}

/** Render the DM profile sidebar for `channel` from the captured type, or null. */
function renderProfile(channel: any) {
    const type = getProfileType();
    if (!type || !channel) return null;
    return withAppTheme(React.createElement(type, { channel }));
}

/** The honest failure card (acquisition drifted). Mirrors StateCards' centred glyph/
 *  title/sub/actions rhythm. The "Open native panel" action one-shot bypasses the seal
 *  so the user can still reach the native member list / profile. */
function ErrorCard({ channelId, kind }: { channelId: string | null; kind: ContextKind }) {
    const openNative = () => {
        // Arm the one-shot bypass FIRST so (1) host/interception lets the native toggle
        // below through instead of swallowing it, and (2) the subsequent applyOpenState
        // leaves the native panel un-hidden (hideExclusiveRightSlot skips marking while
        // bypassed). The bypass is cleared on the next channel select, so the seal resumes.
        armSealBypass(channelId);
        // Open the native section this one time (toggle it on only if it isn't already).
        if (kind === "profile") {
            if (currentSection(true) !== "PROFILE") dispatchUserProfileSidebarToggle();
        } else if (currentSection() !== "MEMBERS") {
            dispatchMemberListToggle();
        }
        // Re-apply the layout so any display:none hide-mark on the native node is cleared
        // (and not re-applied while the bypass holds) — otherwise the store says "open" but
        // the node stays hidden and the escape reveals nothing.
        hostActions().applyOpenState();
        requestRender();
    };
    return React.createElement(
        "div",
        { className: "dockview-unsupported dockview-error-card" },
        React.createElement(
            "svg",
            { className: "dockview-unsupported-icon dockview-error-icon", width: 48, height: 48, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", {
                fill: "currentColor",
                d: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 5h2v7h-2V7Zm0 9h2v2h-2v-2Z"
            })
        ),
        React.createElement("div", { className: "dockview-unsupported-title" }, STRINGS.context.failTitle),
        React.createElement(
            "div",
            { className: "dockview-unsupported-sub" },
            STRINGS.context.failSub(
                kind === "profile" ? STRINGS.context.failWhatProfile : STRINGS.context.failWhatMembers
            )
        ),
        React.createElement(
            "div",
            { className: "dockview-unsupported-actions" },
            React.createElement(
                "button",
                {
                    type: "button",
                    className: "dockview-unsupported-btn dockview-unsupported-btn-primary",
                    onClick: openNative
                },
                STRINGS.context.openNative
            )
        )
    );
}

/** A brief loading card while a lazy acquisition (first render of an un-primed type) is
 *  in flight. Reuses the empty-state layout so it reads calm, not error-like. */
function LoadingCard() {
    return React.createElement(
        "div",
        { className: "dockview-loading" },
        React.createElement("div", { className: "dockview-loading-spinner", "aria-hidden": true }),
        React.createElement(
            "div",
            { className: "dockview-loading-title", role: "status", "aria-live": "polite" },
            STRINGS.loading.title
        )
    );
}

/** The context-tab body. Reads the current channel, picks member list vs profile, renders
 *  the captured component, and self-heals: if the type isn't cached it kicks a lazy prime
 *  and shows a loading card until the prime resolves (then re-renders). If the prime
 *  fails it shows the error card. A group DM / voice / other channel type with a guild_id
 *  shows the member list (matching native); a private channel without a profile shows the
 *  error/empty card. */
export function ContextTabBody() {
    const { useEffect, useState } = React;
    const channelId = getCurrentChannelMemId();
    const kind = contextKindFor(channelId);
    const channel = getChannelObject(channelId);

    // A local bump so a resolved lazy prime re-renders THIS body even if nothing else
    // in the engine changed.
    const [, bump] = useState(0);

    // Lazy acquisition: if the needed type isn't cached, prime it (hidden render capture)
    // and re-render on resolve. Cheap no-op when already cached / for the empty kind.
    // Keyed on channel/kind so a switch re-checks.
    useEffect(() => {
        if (kind === "empty") return;
        let alive = true;
        // Ensure the app ThemeContext value is captured for the profile theming wrap. It
        // reads off the always-present main chat, so this normally lands synchronously on the
        // first render (renderProfile → withAppTheme already pulls it); this re-render guards
        // the case where the value only becomes available a frame later.
        const hadTheme = getThemeContextValue() != null;
        const need = kind === "profile" ? getProfileType() : getMemberListType();
        if (need) {
            if (!hadTheme && getThemeContextValue() != null) bump((n: number) => n + 1);
            return;
        }
        // Try a straight capture first (the native panel may already be in the tree).
        const captured = kind === "profile" ? captureProfile() : captureMemberList();
        if (captured) { bump((n: number) => n + 1); return; }
        const prime = kind === "profile" ? primeProfile() : primeMemberList();
        prime.then(() => { if (alive) bump((n: number) => n + 1); });
        return () => { alive = false; };
    }, [channelId, kind]);

    if (kind === "empty") {
        // @me / no channel / a channel type with no slot content: the calm empty card.
        return React.createElement(
            "div",
            { className: "dockview-empty" },
            React.createElement("div", { className: "dockview-empty-text" }, STRINGS.empty.text)
        );
    }

    const body = kind === "profile" ? renderProfile(channel) : renderMembers(channel);
    // Guild CHANNEL is a composed surface: the channel identity/topic/actions remain at
    // the top even if Discord's member-list acquisition is still loading or drifted.
    // Group DM/DM retain their old Members/Profile body without the guild overview.
    const isVoiceChannel = !!channel?.guild_id && channel.type === 2;
    const slotBody = body ?? (
        // Discord does not mount its ordinary server member-list surface while a voice
        // channel is the selected call view. If we captured the generic list earlier in
        // the session it still renders here; on a direct voice-channel boot, keep CHANNEL
        // as a clean channel overview instead of claiming signature drift with an error.
        isVoiceChannel ? null : React.createElement(ContextFallback, { channelId, kind })
    );
    return React.createElement(
        "div",
        { className: "dockview-context-body" },
        channel?.guild_id && channelId
            ? React.createElement(ChannelOverview, { channelId })
            : null,
        React.createElement(
            "div",
            { className: "dockview-context-slot" },
            slotBody
        )
    );
}

/** After a prime attempt resolves, decide loading vs error. We give the prime a short
 *  grace before declaring failure so a slow (but succeeding) capture shows loading, not a
 *  flash of the error card. On SUCCESS it bumps a local counter so THIS component re-renders
 *  and the parent (ContextTabBody) re-evaluates — the captured type is now cached, so the
 *  member list / profile actually renders instead of staying stuck on the loading card
 *  (a prime that resolves after the first render never re-rendered the parent otherwise). */
function ContextFallback({ channelId, kind }: { channelId: string | null; kind: ContextKind }) {
    const { useEffect, useState } = React;
    const [failed, setFailed] = useState(false);
    const [, bump] = useState(0);
    useEffect(() => {
        let alive = true;
        const prime = kind === "profile" ? primeProfile() : primeMemberList();
        prime.then(ok => {
            if (!alive) return;
            if (ok) { requestRender(); bump((n: number) => n + 1); } // captured → repaint so the body shows
            // A profile prime that failed because Discord has the DM profile sidebar DISABLED
            // ("(Unavailable)") is NOT drift — do NOT surface the error card. The profile TYPE
            // is generic + cached for the session, so if ANY DM was viewed while the sidebar
            // was available this session the parent already rendered a real profile and we
            // never got here; when it wasn't, keep a calm LOADING state and RETRY (below) so
            // the moment Discord re-enables the sidebar (or a store re-check succeeds) a real
            // profile appears. The old "→ empty card" placeholder for this state is gone.
            else if (!(kind === "profile" && isProfileSectionUnavailable())) setFailed(true);
        });
        // A hard ceiling: if the prime never resolves and the type still isn't captured, it's a
        // genuine drift (not the calm unavailable state) → surface the error card.
        const t = setTimeout(() => {
            if (!alive) return;
            const ty = kind === "profile" ? getProfileType() : getMemberListType();
            if (ty) { requestRender(); bump((n: number) => n + 1); }
            else if (!(kind === "profile" && isProfileSectionUnavailable())) setFailed(true);
        }, 4000);
        // SELF-HEAL RETRY (profile-unavailable only): while Discord has the DM sidebar gated
        // off and no profile type is cached, re-attempt the prime every few seconds. The
        // instant Discord re-enables the sidebar the prime captures the type and the profile
        // renders — no reload, no manual step, and never a placeholder in the meantime.
        let retry: ReturnType<typeof setInterval> | null = null;
        if (kind === "profile") {
            retry = setInterval(() => {
                if (!alive) return;
                if (getProfileType()) { requestRender(); bump((n: number) => n + 1); return; }
                if (!isProfileSectionUnavailable()) return; // a drift path handles itself
                primeProfile().then(ok => {
                    if (alive && ok) { requestRender(); bump((n: number) => n + 1); }
                });
            }, 3000);
        }
        return () => { alive = false; clearTimeout(t); if (retry) clearInterval(retry); };
    }, [channelId, kind]);
    if (failed) return React.createElement(ErrorCard, { channelId, kind });
    // Loading — and, for the sidebar-unavailable profile state, a self-healing loading that
    // becomes a real profile the moment the sidebar is re-enabled (never an empty placeholder).
    return React.createElement(LoadingCard, null);
}
