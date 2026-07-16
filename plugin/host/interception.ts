/*
 * Action interception (Batch D — the seal becomes real).
 *
 * The dock is the right rail. Instead of the old exclusivity.ts's observe-and-collapse
 * simulation (which raced Discord's state machine), we INTERCEPT the FluxDispatcher so the
 * actions that would open Discord's native right slot never take effect — Discord's state
 * never becomes "sidebar open" from a user action, so there is no conflict to reconcile.
 *
 * The mechanism is a FluxDispatcher.dispatch WRAP (the exact precedent in
 * messageEncryption.ts: capture the original bound reference, wrap, restore on stop). For
 * the three intercepted actions the wrap SWALLOWS the dispatch (returns without calling the
 * original) and converts it to a dock action:
 *
 *   SIDEBAR_VIEW_CHANNEL   (opening a thread / channel as a sidebar) → open/focus a dock
 *                          thread tab for payload.channelId (parent = payload.baseChannelId).
 *                          A close (SIDEBAR_CLOSE, or a null channelId) is left alone —
 *                          nothing native ever opened, so there is nothing to close.
 *   CHANNEL_TOGGLE_MEMBERS_SECTION        → focus the context tab (member list in the dock).
 *   USER_PROFILE_SIDEBAR_TOGGLE_SECTION   → focus the context tab (profile in the dock).
 *
 * PRIMING PASS-THROUGH: host/slotComponents.ts primes fiber capture by briefly toggling a
 * native section on. Those toggles set the self-flags in host/nativePanels.ts; the wrap
 * checks them and lets OUR toggle through (else priming could never open the section to
 * capture it). Flux dispatch is synchronous, so the flag is reliably set while our toggle
 * runs and the wrap reads it in the same call.
 *
 * SEAL BYPASS: the context error card's "Open native panel" escape arms a one-shot bypass
 * (engine/contextTab isSealBypassed). While armed for the current channel the wrap lets the
 * NEXT member/profile toggle through so the native panel can actually appear; it's cleared
 * on the next channel select (channelMemory), and the toggle-focus path skips re-focusing.
 *
 * STOP RESTORE: uninstall restores FluxDispatcher.dispatch to the exact original reference
 * (like messageEncryption), so a disable/enable cycle leaves Discord's dispatch untouched.
 *
 * NO module-top webpack/DOM access — FluxDispatcher is grabbed inside install().
 */

import { FluxDispatcher } from "@webpack/common";

import { getCurrentChannelMemId } from "../engine/channelMemory";
import { isContextActive, isSealBypassed, setContextActive } from "../engine/contextTab";
import { requestRender } from "../engine/forceRender";
import { openThreadTab } from "../engine/threadTab";
import { isSelfMemberToggle, isSelfProfileToggle } from "./nativePanels";

/** The captured original FluxDispatcher.dispatch, restored EXACTLY on stop. Null when the
 *  wrap isn't installed. */
let originalDispatch: ((payload: any) => any) | null = null;

/** Re-entrancy guard: handling an intercepted action opens/focuses a dock tab and requests
 *  a render; that render (the captured thread chat) can synchronously dispatch again, which
 *  must NOT re-enter our handler and spin a render loop. While true, intercepted actions are
 *  let through untouched (the state we already set stands). */
let handling = false;

/** Focus the context tab for the current channel (the member-list / profile toggle
 *  redirect). If it's already the active view this is a no-op EXCEPT for the render — the
 *  store never flips, so pressing the native member button repeatedly is harmless. */
function focusContextTab(): void {
    const channelId = getCurrentChannelMemId();
    // The bypass escape hatch: while armed, the user asked for the NATIVE panel, so don't
    // yank focus back to the (broken) context tab — let the pass-through handle it.
    if (isSealBypassed(channelId)) return;
    if (!isContextActive(channelId)) setContextActive(channelId, true);
    requestRender();
}

/** The interception, run BEFORE the original dispatch. Returns true if the action was
 *  SWALLOWED (the caller must NOT call the original dispatch). Total + cheap: only the
 *  three intercepted types are handled; everything else falls through. Never throws into
 *  dispatch. */
function handleDispatch(payload: any): boolean {
    if (!payload || handling) return false;
    const channelId = getCurrentChannelMemId();
    switch (payload.type) {
        case "SIDEBAR_VIEW_CHANNEL": {
            // Opening a thread / channel as a sidebar. channelId = the thread (or channel)
            // being shown; baseChannelId = its parent. A close path carries no channelId —
            // let it through (nothing native opened, so nothing to reconcile).
            const target = payload.channelId;
            if (!target) return false;
            handling = true;
            try { openThreadTab(String(target), payload.baseChannelId ? String(payload.baseChannelId) : null); }
            finally { handling = false; }
            return true; // swallow — the native sidebar never opens
        }
        case "CHANNEL_TOGGLE_MEMBERS_SECTION": {
            // OUR priming toggle → let it through so fiber capture can open the section.
            if (isSelfMemberToggle()) return false;
            // The bypass escape → let the real toggle through this once.
            if (isSealBypassed(channelId)) return false;
            handling = true;
            try { focusContextTab(); } finally { handling = false; }
            return true; // swallow — the store never flips to MEMBERS from a user click
        }
        case "USER_PROFILE_SIDEBAR_TOGGLE_SECTION": {
            if (isSelfProfileToggle()) return false;
            if (isSealBypassed(channelId)) return false;
            handling = true;
            try { focusContextTab(); } finally { handling = false; }
            return true; // swallow — the store never flips to PROFILE from a user click
        }
    }
    return false;
}

/** Install the dispatch wrap once, capturing the original bound reference. */
export function startInterception(): void {
    if (originalDispatch) return;
    const flux: any = FluxDispatcher;
    if (!flux || typeof flux.dispatch !== "function") return;
    const orig: (payload: any) => any = flux.dispatch.bind(flux);
    originalDispatch = orig;
    flux.dispatch = function (payload: any) {
        try {
            if (handleDispatch(payload)) return; // swallowed → do not run the original
        } catch {
            /* never let our interception break Discord's dispatch */
        }
        return orig(payload);
    };
}

/** Restore FluxDispatcher.dispatch to the exact original and drop the reference. */
export function stopInterception(): void {
    if (!originalDispatch) return;
    try {
        (FluxDispatcher as any).dispatch = originalDispatch;
    } catch {
        /* ignore */
    }
    originalDispatch = null;
}

/** Whether the wrap is currently installed — for the CDP debug surface / gates. */
export function interceptionInstalled(): boolean {
    return originalDispatch !== null;
}
