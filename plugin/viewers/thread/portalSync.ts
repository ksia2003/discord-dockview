/*
 * Portal sync state machines (thread chat portals) — extracted pure so the F9
 * regression suite can drive them without a browser.
 *
 * 1. The thread-open decision: a same-thread open is a REFOCUS only when it carries
 *    the explicit user-intent marker — the Threads browser-card seam (always a user
 *    click) or the one-shot trusted-input seam (a capture-phase click / Enter-Space
 *    keydown consumed by the first intercepted SIDEBAR_VIEW_CHANNEL in that event
 *    turn). Every other same-thread open — the captured chat's recursive
 *    SIDEBAR_VIEW_CHANNEL, internal render/retry rerenders, background reconciliation
 *    — is a pure NOOP (the loop-breaker), even while the dock is F9-hidden, because
 *    those paths carry no trusted input. A different-thread open always proceeds OPEN.
 *
 * 2. The bounded body-settle: after a show or a live .dockview-body identity change
 *    (an E3 root retire/rebind, or a reveal that re-creates the dock tree) the portal
 *    must reacquire the NEW body. A fixed number of settle frames re-syncs while the
 *    swap settles, then stops — no permanent rAF loop, steady state stays
 *    zero-per-frame.
 */

/** What a thread open should do. `alreadyActive`: the active dock view IS this thread
 *  (context tab not active). `explicit`: the open carries a trusted user-intent marker
 *  (Threads browser card, or a consumed click/key activation). */
export type ThreadOpenDecision = "noop" | "refocus" | "open";

export function decideThreadOpen(alreadyActive: boolean, explicit: boolean): ThreadOpenDecision {
    if (!alreadyActive) return "open";
    return explicit ? "refocus" : "noop";
}

export interface BoundedSettle {
    /** Re-arm the settle window (keeps any already-scheduled ticks running). */
    arm(): void;
    /** Stop the settle immediately. */
    cancel(): void;
}

/** Create a bounded settle: `arm()` schedules `maxFrames` consecutive ticks and then
 *  stops. Each tick RUNS `action` (the owner's sync pass) before scheduling the next,
 *  so a replaced body is actually re-synced for the whole budget. The default window
 *  (~12 frames ≈ 200ms) is sized to cover a Discord channel-view retire/rebind: the
 *  E3 root un-/remount, the placeholder ref re-binding the root, and the reveal layout
 *  settling can each take a frame or two. Bounded — steady state stays zero-per-frame. */
export function createBoundedSettle(
    schedule: (callback: () => void) => number,
    cancel: (handle: number) => void,
    action: () => void,
    maxFrames = 12
): BoundedSettle {
    let remaining = 0;
    let handle = 0;
    const tick = () => {
        handle = 0;
        if (remaining <= 0) return;
        remaining -= 1;
        // Run the actual sync work this frame; it may re-arm (a still-changing body
        // identity), which the !handle guard keeps from double-scheduling.
        action();
        if (remaining > 0 && !handle) handle = schedule(tick);
    };
    return {
        arm() {
            remaining = maxFrames;
            if (!handle) handle = schedule(tick);
        },
        cancel() {
            if (handle) { cancel(handle); handle = 0; }
            remaining = 0;
        }
    };
}
