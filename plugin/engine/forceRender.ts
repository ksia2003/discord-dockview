/*
 * The repaint pub/sub + the live-controller slot registry.
 *
 * Two unrelated bridges between the imperative engine and React live here:
 *
 *  1. requestRender / setRenderer — the imperative→React repaint. The DockPanel
 *     publishes its rerender callback via setRenderer() on mount (and clears it
 *     on unmount); everything else calls requestRender() to schedule a repaint.
 *     The slot is nullable: before the panel mounts (or after it unmounts) a
 *     requestRender() is a silent no-op, exactly like the old `forceRender?.()`.
 *
 *  2. liveController — the per-viewer imperative API slots (the old pdfControls /
 *     imgControls / codeCtrl / csvCtrl / treeCtrl module singletons). A viewer's
 *     Body publishes its controller on mount; the header toolbar + keyboard
 *     shortcuts read it back. Each slot is keyed by name so a viewer claims its
 *     own without the engine knowing any concrete controller shape.
 *
 *     UNMOUNT GUARD (load-bearing): on unmount a Body must only clear the slot if
 *     it still owns it — `if (getLiveController(name) === mine) clearLiveController(name)`.
 *     A remount can race the old Body's cleanup: the new Body registers first,
 *     then the old Body's effect cleanup runs; without the identity guard that
 *     cleanup would null out the LIVE controller the new Body just published.
 *
 * Leaf module: no engine imports, no module-top React.
 */

let renderer: (() => void) | null = null;

/** Publish the panel's rerender callback (DockPanel mount). Pass null to clear
 *  it (unmount). Mirrors the old `forceRender = rerender` assignment with the
 *  same identity-guarded clear the panel does on teardown. */
export function setRenderer(fn: (() => void) | null): void {
    renderer = fn;
}

/** Is `fn` the currently-published renderer? Lets the panel clear its slot only
 *  when it still owns it (guards a mount/unmount race). */
export function isRenderer(fn: (() => void) | null): boolean {
    return renderer === fn;
}

/** Schedule a panel repaint. A no-op before the panel mounts (the old
 *  `forceRender?.()`), so engine code can call it unconditionally. */
export function requestRender(): void {
    renderer?.();
}

// --- live-controller slots --------------------------------------------------
// A small string-keyed registry of the per-viewer imperative controllers. The
// historical slots were `pdfControls` / `imgControls` / `codeCtrl` / `csvCtrl` /
// `treeCtrl`; here they are generic so a viewer publishes/reads its own by name
// and the engine never has to name a concrete controller type.

const controllers = new Map<string, unknown>();

/** A viewer Body publishes its imperative controller on mount. */
export function setLiveController(name: string, ctrl: unknown): void {
    controllers.set(name, ctrl);
}

/** Read a viewer's published controller (the header/keyboard reach for it). */
export function getLiveController<T = unknown>(name: string): T | null {
    return (controllers.get(name) as T) ?? null;
}

/** Clear a slot ONLY if `ctrl` still owns it — the unmount guard. A bare
 *  `clearLiveController(name)` would clobber a controller a racing remount has
 *  already published, so always pass the controller you registered. */
export function clearLiveController(name: string, ctrl: unknown): void {
    if (controllers.get(name) === ctrl) controllers.delete(name);
}
