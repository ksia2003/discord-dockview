/*
 * The engine→host seam.
 *
 * The engine drives the dock's logical state (which window is active, what's
 * loaded, open/closed). The actual DOM consequences of "open" — mounting the
 * host node, pushing/floating the layout, collapsing Discord's native sidebars —
 * are host/ work that lands in Phase 2. To keep the engine free of host imports
 * (and free of DOM at all), it calls host actions through these nullable slots.
 * Phase 2's host module registers real implementations at startup; until then
 * every call is a graceful no-op, so the engine compiles and runs (logical state
 * only) with no host wired.
 *
 * This is the inverse of forceRender's render slot: there React publishes its
 * repaint; here the host publishes its DOM effects.
 */

export interface HostActions {
    /** Ensure the dock host node exists / is mounted. */
    ensureHost(): void;
    /** Reflect the active window into the DOM (mount + apply the always-open layout, which
     *  hide-marks any native right-slot Discord renders by default). */
    applyOpenState(): void;
    /** Apply the persisted/active dock width to the host node. */
    applyHostWidth(): void;
    /** Reveal a dock hidden by the optional F9 temporary-hide mode. Explicit new-tab
     *  actions call this; passive channel/layout updates deliberately do not. */
    revealDock(): void;
    /** Synchronously hide the mounted context body (member list / profile). The DockPanel
     *  swaps the body via a React re-render, which lands on a later commit; when the active
     *  view flips from the context tab to a heavier view (a thread portal), that commit can
     *  spill past a paint and the stale member list flashes in the dock for a frame. The
     *  view-switch call sites invoke this to hide the outgoing context body in the SAME
     *  synchronous turn the state flips, so the transition is visually atomic; React then
     *  unmounts the node on its own commit. No-op when no context body is mounted. */
    hideContextBody(): void;
    /** Leave the server-scoped native Search surface without destroying its query/results.
     * Explicit Channel info, voice chat, file and thread selections call this so Search
     * behaves like a fixed tab rather than a per-channel context enum. */
    deactivateSearchView(): void;
    isSearchViewActive(): boolean;
    activateSearchView(): void;
}

const noop = () => { };

let host: HostActions = {
    ensureHost: noop,
    applyOpenState: noop,
    applyHostWidth: noop,
    revealDock: noop,
    hideContextBody: noop,
    deactivateSearchView: noop,
    isSearchViewActive: () => false,
    activateSearchView: noop
};

/** Phase 2 host registers its real DOM actions here. */
export function registerHostActions(actions: Partial<HostActions>): void {
    host = { ...host, ...actions };
}

/** The host actions the engine calls (no-ops until the host registers). */
export function hostActions(): HostActions {
    return host;
}
