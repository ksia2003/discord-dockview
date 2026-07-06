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
        if (typeof child?.className === "string" && child.className.indexOf("activity") !== -1) {
            setTimeout(() => {
                try { orig.call(this, child); } catch { /* node already gone */ }
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
