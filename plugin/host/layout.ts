/*
 * Dock layout — width state (PARTIAL: Phase 1 covers only the width primitive;
 * the DOM geometry of applyDockLayout is Phase 2 host work).
 *
 * The dock width is a DOCK-LEVEL (global) property, NOT per-window: every tab is
 * the same dock chrome, so they all share ONE width. It lives in this single
 * module singleton (persisted to LS_WIDTH), and every window's `state.width` is a
 * getter/setter proxy onto it (see makeWindow) — so switching tabs can NEVER
 * change the width (the old per-window seed-from-LS drifted: a window created
 * before a resize kept a stale width and made the dock jump on switch). All
 * reads/writes funnel through this one value. It is SEEDED from LS in
 * makeWindow's first call (which runs after the persist mirror exists — reading
 * LS at module-init would hit the mirror's TDZ and throw, killing the plugin) and
 * corrected by the host's loadPersistedState handling at startup.
 */

import { LS_WIDTH, lsGet } from "../engine/persist";

export const MIN_WIDTH = 360;
export const DEFAULT_WIDTH = 420;
export const MAX_WIDTH_FRAC = 0.6; // of window width

// ---------------------------------------------------------------------------
// TWO-MODE width behaviour (mirrors Discord's native thread panel). The dock has
// a DOCKED (push) mode and a FLOATING (overlay) mode, auto-switched by how much
// width the dock+chat share — so a wide persisted dock can never crush the chat
// on a narrow window. The decision + clamp live in ONE place: applyDockLayout().
//
//   - CHAT_MIN_WIDTH: the chat's protected minimum. The docked dock is never
//     applied wider than (content − this), so the message area keeps its min;
//     when even DOCK_MIN_WIDTH can't fit beside it, the dock goes floating.
//   - DOCK_MIN_WIDTH: the dock's own minimum while docked (the smallest push).
//   - FLOAT_CHAT_SLIVER: while floating, leave at least this much chat visible/
//     clickable behind the overlay (native floats a panel that doesn't quite
//     cover the chat). The float width is capped to (content − this).
// All tune-able: change here, nothing else.
export const CHAT_MIN_WIDTH = 420;
export const DOCK_MIN_WIDTH = 280;
export const FLOAT_CHAT_SLIVER = 48;

let dockWidth = DEFAULT_WIDTH;
export function getDockWidth(): number { return dockWidth; }
export function setDockWidth(w: number): void { dockWidth = w; }

// `seeded` makes the LS read happen exactly once (the first makeWindow call), so a
// later makeWindow (a new tab) doesn't re-clobber a width the user has since set.
let dockWidthSeeded = false;
export function seedDockWidthFromLS(): void {
    if (dockWidthSeeded) return;
    dockWidthSeeded = true;
    dockWidth = clampWidthRaw(parseInt(lsGet(LS_WIDTH) || "", 10) || DEFAULT_WIDTH);
}

/** Clamp a width to [MIN_WIDTH, MAX_WIDTH_FRAC·windowWidth]. The public clamp. */
export function clampWidthRaw(w: number): number {
    const max = Math.max(MIN_WIDTH, Math.floor((window.innerWidth || 1280) * MAX_WIDTH_FRAC));
    return Math.min(max, Math.max(MIN_WIDTH, w));
}

/** Alias kept for the call sites that used the public name `clampWidth`. */
export function clampWidth(w: number): number {
    return clampWidthRaw(w);
}

// TODO(P2): applyDockLayout — the docked/floating DOM geometry (innerWidth-driven
// mode switch, the push/overlay positioning, the resize-drag clamp leaving the
// chat its CHAT_MIN_WIDTH / FLOAT_CHAT_SLIVER). This is host DOM work; it stays a
// stub here and lands with the rest of host/ in Phase 2.
export function applyDockLayout(): void {
    // TODO(P2): port the docked/floating geometry from panel.tsx.
}
