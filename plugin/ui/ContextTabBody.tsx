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
 * FALLBACK: if acquisition fails (signature drift after a Discord update), we render an
 * honest error card (the StateCards visual grammar) with a subtle "Open native panel"
 * action that one-shot bypasses the seal — never a silent break, never a crash that
 * takes the dock down.
 */

import { React } from "@webpack/common";

import { requestRender } from "../engine/forceRender";
import { armSealBypass } from "../engine/contextTab";
import { hostActions } from "../engine/hostBridge";
import { getCurrentChannelMemId } from "../engine/channelMemory";
import {
    captureMemberList, captureProfile, contextKindFor, getChannelObject, getMemberListType,
    getProfileType, primeMemberList, primeProfile
} from "../host/slotComponents";
import type { ContextKind } from "../host/slotComponents";
import { STRINGS } from "../strings";

/** Render the guild member list for `channel` from the captured type, or null if the
 *  type isn't acquired yet (the caller falls to loading/error). */
function renderMembers(channel: any) {
    const type = getMemberListType();
    if (!type || !channel) return null;
    // Our own wrapper class so the container (not the native parent) supplies styling.
    return React.createElement(type, { channel, className: "dockview-context-native" });
}

/** Render the DM profile sidebar for `channel` from the captured type, or null. */
function renderProfile(channel: any) {
    const type = getProfileType();
    if (!type || !channel) return null;
    return React.createElement(type, { channel });
}

/** The honest failure card (acquisition drifted). Mirrors StateCards' centred glyph/
 *  title/sub/actions rhythm. The "Open native panel" action one-shot bypasses the seal
 *  so the user can still reach the native member list / profile. */
function ErrorCard({ channelId, kind }: { channelId: string | null; kind: ContextKind }) {
    const openNative = () => {
        // Arm the one-shot bypass FIRST so the subsequent applyOpenState leaves the native
        // panel's node un-hidden (hideExclusiveRightSlot skips marking while bypassed).
        armSealBypass(channelId);
        const host = hostActions();
        // Un-collapse the native panel this one time (store section → open)...
        if (kind === "profile") host.syncNativeProfileSidebar(false);
        else host.syncNativeMemberList(false);
        // ...and re-apply the layout so the existing display:none hide-mark on the native
        // node is cleared (and not re-applied while the bypass holds) — otherwise the store
        // says "open" but the node stays hidden and the escape reveals nothing.
        host.applyOpenState();
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
        const need = kind === "profile" ? getProfileType() : getMemberListType();
        if (need) return;
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
    if (body) {
        return React.createElement("div", { className: "dockview-context-body" }, body);
    }
    // No captured type yet → loading, then the honest error card if the prime failed.
    return React.createElement(ContextFallback, { channelId, kind });
}

/** After a prime attempt resolves, decide loading vs error. We give the prime a short
 *  grace before declaring failure so a slow (but succeeding) capture shows loading, not a
 *  flash of the error card. */
function ContextFallback({ channelId, kind }: { channelId: string | null; kind: ContextKind }) {
    const { useEffect, useState } = React;
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let alive = true;
        const prime = kind === "profile" ? primeProfile() : primeMemberList();
        prime.then(ok => { if (alive && !ok) setFailed(true); });
        // A hard ceiling: if the prime never resolves, still surface the error card.
        const t = setTimeout(() => {
            if (!alive) return;
            const ty = kind === "profile" ? getProfileType() : getMemberListType();
            if (!ty) setFailed(true);
        }, 4000);
        return () => { alive = false; clearTimeout(t); };
    }, [channelId, kind]);
    if (failed) return React.createElement(ErrorCard, { channelId, kind });
    return React.createElement(LoadingCard, null);
}
