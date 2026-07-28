/*
 * Synchronous visibility state for DockView-owned document.body portals.
 *
 * Thread and voice-chat roots stay mounted while F9 temporarily hides the dock so their
 * drafts and scroll positions survive. Each owned portal registers its node here and
 * carries its own visibility attribute; no document-wide selector or html marker is needed
 * to hide body-level roots in the same turn as the dock host.
 */

export const OWNED_PORTAL_HIDDEN_ATTRIBUTE = "data-dockview-temporarily-hidden";

const ownedPortals = new Set<HTMLElement>();
let temporarilyHidden = false;

function reflectTemporaryHidden(node: HTMLElement): void {
    if (temporarilyHidden) node.setAttribute(OWNED_PORTAL_HIDDEN_ATTRIBUTE, "true");
    else node.removeAttribute(OWNED_PORTAL_HIDDEN_ATTRIBUTE);
}

/** Register a DockView-owned body portal and immediately inherit the current F9 state. */
export function registerOwnedPortal(node: HTMLElement): void {
    ownedPortals.add(node);
    reflectTemporaryHidden(node);
}

/** Stop tracking a portal before its root/node is destroyed. */
export function unregisterOwnedPortal(node: HTMLElement): void {
    ownedPortals.delete(node);
}

/** Reflect F9 temporary-hidden state on every live owned portal synchronously. */
export function setOwnedPortalsTemporarilyHidden(hidden: boolean): void {
    temporarilyHidden = hidden;
    for (const node of ownedPortals) reflectTemporaryHidden(node);
}
