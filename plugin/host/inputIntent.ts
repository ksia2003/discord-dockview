/*
 * One-shot trusted-user-input intent tracker.
 *
 * A capture-phase click / Enter-Space keydown on a real user gesture arms a one-shot
 * intent that lives only through the current event turn (cleared by a bounded
 * zero-timeout). The FIRST intercepted SIDEBAR_VIEW_CHANNEL in that turn consumes it,
 * marking the thread open explicit — so an already-active thread clicked while the dock
 * is F9-hidden refocuses (reveals). Internal portal render/retry dispatches never pass
 * through a trusted input event, so they never arm and stay non-explicit. Pure and
 * scheduler-injected so the F9 regression suite can drive it deterministically.
 */

export interface InputIntentTracker {
    /** A trusted user input just happened — arm one explicit open for this turn. */
    arm(): void;
    /** True exactly once per arm: the first open in the turn is the user's. */
    consume(): boolean;
    /** Stop cleanup: cancel the expiry timer and clear any pending intent. */
    cancel(): void;
}

/** True when a keyboard event targeting `target` must NOT arm user intent — text entry
 *  (input/textarea/select, any contenteditable/Slate composer, role=textbox). Otherwise
 *  sending a message with Enter while the dock is hidden would arm intent and
 *  misclassify the resulting portal rerender as an explicit thread open. Pure so the
 *  regression suite can drive it with plain objects. */
export function isEditableTarget(target: EventTarget | null): boolean {
    if (!target || typeof target !== "object") return false;
    const el = target as {
        tagName?: unknown;
        isContentEditable?: unknown;
        getAttribute?: (name: string) => string | null;
    };
    const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    // isContentEditable is true for the element or any editable ancestor (the Slate
    // composer is a contenteditable with nested spans).
    if (el.isContentEditable === true) return true;
    if (typeof el.getAttribute === "function") {
        const role = el.getAttribute("role");
        if (role === "textbox") return true;
    }
    return false;
}

/** Create a one-shot intent tracker. `schedule`/`clear` are injected so tests run
 *  deterministically; `holdMillis` bounds how long an unconsumed intent stays armed. */
export function createInputIntentTracker(
    schedule: (callback: () => void) => number,
    clear: (handle: number) => void,
    holdMillis = 0
): InputIntentTracker {
    let armed = false;
    let handle = 0;
    return {
        arm() {
            if (handle) { clear(handle); handle = 0; }
            armed = true;
            handle = schedule(() => { handle = 0; armed = false; });
        },
        consume() {
            if (!armed) return false;
            armed = false;
            if (handle) { clear(handle); handle = 0; }
            return true;
        },
        cancel() {
            if (handle) { clear(handle); handle = 0; }
            armed = false;
        }
    };
}
