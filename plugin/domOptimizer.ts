/*
 * DockView — DOM optimizer (opt-in).
 * ---------------------------------------------------------------------------
 * An OpenAsar / Dorion trick: patch Element.prototype.removeChild so any element
 * whose className mentions "activity" (the member-list activity rows Discord churns
 * on every channel/server switch) is removed 100ms LATER via setTimeout. Chat paints
 * immediately on a switch and the cosmetic activity DOM settles a beat after, which
 * reads as snappier. Only removeChild is patched — the appendChild variant in the
 * original is left off.
 *
 * Off by default (settings.store.domOptimizer). It rewrites a global DOM prototype, so
 * it's gated + fully reversible: start() installs the patch (idempotent), stop() puts
 * the native removeChild back exactly. We only restore OUR wrapper, so we never clobber
 * another patch that landed on top.
 *
 * NO webpack access — this touches only Element.prototype, safe to call from start().
 */

type RemoveChild = <T extends Node>(child: T) => T;

// The native removeChild, captured when we install so stop() can restore it. Tagged
// wrapper so we recognise our own patch and refuse to restore over a foreign one.
let nativeRemoveChild: RemoveChild | null = null;
type Patched = RemoveChild & { __dockViewDomOpt?: true; };

export function startDomOptimizer(): void {
    const current = Element.prototype.removeChild as Patched;
    if (current.__dockViewDomOpt) return; // already installed

    nativeRemoveChild = current;
    const orig = current;

    const patched: Patched = function (this: Element, child: any) {
        // Only defer a node that IS currently our child AND carries the activity class —
        // this is the member-list activity row Discord churns on a switch. Anything else
        // (including React's own reconciliation removals of unrelated nodes) removes now,
        // synchronously, so we don't intercept a commit that expects immediate detach.
        if (child?.parentNode === this
            && typeof child.className === "string"
            && child.className.indexOf("activity") !== -1) {
            const parent = this;
            setTimeout(() => {
                // If the node was re-parented or already removed within the delay, the
                // deferred detach would throw NotFoundError (and leak it, never removed).
                // Only detach while it's still our child; otherwise the move already did it.
                if (child.parentNode === parent) {
                    try { orig.call(parent, child); } catch { /* raced with another removal */ }
                }
            }, 100);
            return child;
        }
        return orig.call(this, child);
    } as Patched;
    patched.__dockViewDomOpt = true;

    Element.prototype.removeChild = patched;
}

export function stopDomOptimizer(): void {
    const current = Element.prototype.removeChild as Patched;
    if (current?.__dockViewDomOpt && nativeRemoveChild) {
        Element.prototype.removeChild = nativeRemoveChild;
    }
    nativeRemoveChild = null;
}

/** Apply or remove the patch to match the live setting — used by the Performance
 *  toggle so a flip takes effect without a reload. */
export function syncDomOptimizer(enabled: boolean): void {
    if (enabled) startDomOptimizer();
    else stopDomOptimizer();
}
