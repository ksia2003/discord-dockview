/*
 * Bounded first-render retry for detached native Discord surfaces.
 *
 * The caller owns the render state and supplies the scheduler so this helper is
 * deterministic in tests and does not depend on a browser global at import time.
 */

export interface InitialRenderRetryOptions {
    isCurrent: () => boolean;
    isRendered: () => boolean;
    render: () => boolean;
    setRendered: (rendered: boolean) => void;
    request: (callback: () => void) => number;
    cancel: (handle: number) => void;
    maxAttempts?: number;
    onSettled?: () => void;
}

export interface InitialRenderRetryController {
    /** Arm one bounded retry window. Returns false while already armed or when stale. */
    arm: () => boolean;
    /** Cancel the current window and make every queued callback harmless. */
    cancel: () => void;
}

/** Create a bounded retry controller. A later explicit readiness signal may call arm(). */
export function createInitialRenderRetry(options: InitialRenderRetryOptions): InitialRenderRetryController {
    let handle = 0;
    let scheduled = false;
    let attempts = 0;
    let cancelled = false;
    let settled = false;
    const maxAttempts = options.maxAttempts ?? 180;

    const settle = () => {
        if (settled) return;
        settled = true;
        options.onSettled?.();
    };
    const queue = () => {
        scheduled = true;
        const next = options.request(tick);
        // A test or host scheduler may invoke the callback synchronously. Do not leave
        // its returned handle looking live after that callback has already settled.
        if (scheduled) handle = next;
    };
    const tick = () => {
        scheduled = false;
        handle = 0;
        if (cancelled || !options.isCurrent() || options.isRendered()) {
            settle();
            return;
        }
        const rendered = options.render();
        options.setRendered(rendered);
        attempts++;
        if (rendered || attempts >= maxAttempts) {
            settle();
            return;
        }
        queue();
    };

    const arm = (): boolean => {
        if (cancelled || scheduled || options.isRendered() || !options.isCurrent()) return false;
        attempts = 0;
        settled = false;
        queue();
        return true;
    };

    const cancel = (): void => {
        if (cancelled) return;
        cancelled = true;
        if (scheduled) options.cancel(handle);
        scheduled = false;
        handle = 0;
        settle();
    };

    arm();
    return { arm, cancel };
}

/** Schedule bounded retries until the first successful render, cancellation, or staleness. */
export function scheduleInitialRenderRetry(options: InitialRenderRetryOptions): () => void {
    return createInitialRenderRetry(options).cancel;
}
