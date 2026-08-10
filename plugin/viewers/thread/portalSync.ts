/*
 * Portal sync state machines (thread chat portals) — extracted pure so the F9
 * regression suite can drive them without a browser.
 *
 * 1. The explicit-intent decision: the ONLY thread-open seam that is unambiguously a
 *    user click is the Threads browser card (openThreadFromBrowser). A same-thread
 *    open through that seam is an explicit REFOCUS (reveal an F9-hidden dock, re-show
 *    the mounted chat, no seq bump); every other same-thread open — the captured
 *    chat's recursive SIDEBAR_VIEW_CHANNEL, background-channel reconciliation — is a
 *    pure NOOP (the loop-breaker). A different-thread open always proceeds OPEN.
 *
 * 2. The bounded body-settle: after a show or a live .dockview-body identity change
 *    (an E3 root retire/rebind, or a reveal that re-creates the dock tree) the portal
 *    must reacquire the NEW body. A fixed number of settle frames re-syncs while the
 *    swap settles, then stops — no permanent rAF loop, steady state stays
 *    zero-per-frame.
 */

/** What a thread open should do. `alreadyActive`: the active dock view IS this thread
 *  (context tab not active). `explicit`: the open arrived through the user-intent seam
 *  (Threads browser card). */
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
 *  stops. Each tick is a callback the owner uses to perform one sync pass. */
export function createBoundedSettle(
    schedule: (callback: () => void) => number,
    cancel: (handle: number) => void,
    maxFrames = 3
): BoundedSettle {
    let remaining = 0;
    let handle = 0;
    const tick = () => {
        handle = 0;
        if (remaining > 0) {
            remaining -= 1;
            if (remaining > 0) handle = schedule(tick);
        }
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
