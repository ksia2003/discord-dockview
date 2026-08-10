/*
 * One-shot trusted-user-input intent + conservative activation-id evidence.
 *
 * A capture-phase click / Enter-Space keydown on a real user gesture arms a one-shot
 * intent that lives only through the current event turn (cleared by a bounded
 * zero-timeout) — but ONLY when the activated target carries evidence of a
 * channel/thread id, and the intercepted SIDEBAR_VIEW_CHANNEL is granted explicit
 * only when its payload.channelId matches that evidence. So an unrelated click (no
 * thread evidence) or a click whose evidence doesn't match the payload can never
 * misclassify a same-turn internal portal rerender as explicit. Internal portal
 * render/retry dispatches never pass through a trusted input event, so they never arm
 * and stay non-explicit. Pure and scheduler-injected so the regression suite can drive
 * it deterministically.
 */

export interface InputIntentTracker {
    /** A trusted user input activated a target evidencing these channel/thread ids. */
    arm(ids: Iterable<string>): void;
    /** True once, only when the armed evidence includes `channelId` (one-shot; a
     *  non-matching SIDEBAR leaves the intent armed for a matching one this turn). */
    consumeFor(channelId: string): boolean;
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
 *  deterministically. The scheduler's own delay bounds how long an unconsumed intent
 *  stays armed (the app uses a zero-timeout — one event turn). */
export function createInputIntentTracker(
    schedule: (callback: () => void) => number,
    clear: (handle: number) => void
): InputIntentTracker {
    let armed = false;
    let ids = new Set<string>();
    let handle = 0;
    return {
        arm(candidates: Iterable<string>) {
            if (handle) { clear(handle); handle = 0; }
            armed = true;
            ids = new Set(candidates);
            handle = schedule(() => { handle = 0; armed = false; ids = new Set(); });
        },
        consumeFor(channelId: string) {
            if (!armed || !ids.has(channelId)) return false;
            armed = false;
            ids = new Set();
            if (handle) { clear(handle); handle = 0; }
            return true;
        },
        cancel() {
            if (handle) { clear(handle); handle = 0; }
            armed = false;
            ids = new Set();
        }
    };
}

/** Conservative channel/thread-id evidence from an activation path (a click/keydown
 *  composedPath). Supported evidence: an anchor whose href is /channels/<guild>/<id>,
 *  a STRICT-digit data-channel-id, a prefixed/trailing data-list-item-id snowflake
 *  (channels___456, thread-row___456), and the node's OWN React fiber memoizedProps
 *  (channel.id / thread.id / channelId) — digit ids only. Anything else (plain divs,
 *  non-channel hrefs, ancestor fibers, generic `id` props) contributes nothing, so an
 *  unrelated click never arms intent. */
export function extractActivationIds(path: readonly unknown[]): string[] {
    const ids: string[] = [];
    const push = (raw: unknown) => {
        const id = typeof raw === "string" ? raw.trim() : "";
        if (/^\d+$/.test(id) && !ids.includes(id)) ids.push(id);
    };
    for (const node of path) {
        if (!node || typeof node !== "object") continue;
        const el = node as {
            getAttribute?: (name: string) => string | null;
            [key: string]: unknown;
        };
        // Only real Element nodes (those carrying getAttribute) are inspected; window,
        // document, and other objects are skipped immediately — enumerating their keys
        // on every click would be slow and can only pull unrelated fiber evidence.
        if (typeof el.getAttribute !== "function") continue;
        const href = el.getAttribute("href");
        if (href) {
            const m = /\/channels\/[^/]+\/(\d+)(?:\/|$)/.exec(href);
            if (m) push(m[1]);
        }
        push(el.getAttribute("data-channel-id")); // strict digits
        const listItemId = el.getAttribute("data-list-item-id");
        if (listItemId) {
            const token = trailingSnowflake(listItemId);
            if (token) push(token);
        }
        for (const key of Object.keys(el)) {
            if (!key.startsWith("__reactFiber$") && !key.startsWith("__reactInternalInstance$")) continue;
            const fiber = el[key] as { memoizedProps?: unknown } | null | undefined;
            const props = fiber?.memoizedProps as Record<string, unknown> | undefined;
            if (!props || typeof props !== "object") continue;
            push(props.channelId);
            const channel = props.channel as { id?: unknown } | undefined;
            if (channel && typeof channel === "object") push(channel.id);
            const thread = props.thread as { id?: unknown } | undefined;
            if (thread && typeof thread === "object") push(thread.id);
        }
    }
    return ids;
}

/** The trailing, delimiter-bound snowflake token of a prefixed list-item id — Discord's
 *  data-list-item-id is usually "channels___<snowflake>" or "thread-row___<snowflake>".
 *  Accepts only a TRAILING digit run (preceded by the start or a non-digit delimiter),
 *  never digits buried in arbitrary text. */
function trailingSnowflake(value: string): string | null {
    const m = /(?:^|\D)(\d+)$/.exec(value);
    return m ? m[1] : null;
}
