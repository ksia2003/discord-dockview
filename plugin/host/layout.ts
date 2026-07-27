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

import { LS_WIDTH, lsGet, lsSet } from "../engine/persist";
import { getActiveWindow } from "../engine/window";

const HOST_ID = "dockview-root";

// Follow Discord's live native member-list width instead of freezing today's value.
// The current client resolves this custom property to 264px, but Discord can change it
// by build or experiment. The fallback is used only before/without that property.
export const COMPACT_WIDTH_FALLBACK = 264;
const COMPACT_WIDTH_PROPERTY = "--custom-member-list-width";
export const DEFAULT_EXPANDED_WIDTH = 560;
export const MAX_WIDTH_FRAC = 0.6; // of window width

/** Read the native member rail in CSS pixels. Keep a bounded fallback because a missing,
 * non-pixel, or experimental garbage value must not collapse/consume the whole page. */
export function getCompactDockWidth(): number {
    try {
        const raw = getComputedStyle(document.documentElement)
            .getPropertyValue(COMPACT_WIDTH_PROPERTY)
            .trim();
        const match = raw.match(/^(\d+(?:\.\d+)?)px$/);
        const width = match ? Number(match[1]) : NaN;
        if (Number.isFinite(width) && width >= 200 && width <= 480) return Math.round(width);
    } catch {
        // DOM/CSS unavailable during an early bootstrap: use the current Discord fallback.
    }
    return COMPACT_WIDTH_FALLBACK;
}

// ---------------------------------------------------------------------------
// TWO-MODE width behaviour (mirrors Discord's native thread panel). The dock has
// a DOCKED (push) mode and a FLOATING (overlay) mode, auto-switched by how much
// width the dock+chat share — so a wide persisted dock can never crush the chat
// on a narrow window. The decision + clamp live in ONE place: applyDockLayout().
//
//   - CHAT_MIN_WIDTH: the chat's protected minimum. The docked dock is never
//     applied wider than (content − this), so the message area keeps its min;
//     when even the native compact width can't fit beside it, the dock goes floating.
//   - Native compact width: the dock's own minimum while docked (the smallest push).
//   - FLOAT_CHAT_SLIVER: while floating, leave at least this much chat visible/
//     clickable behind the overlay (native floats a panel that doesn't quite
//     cover the chat). The float width is capped to (content − this).
// All tune-able: change here, nothing else.
export const CHAT_MIN_WIDTH = 420;
export const FLOAT_CHAT_SLIVER = 48;

let dockWidth = COMPACT_WIDTH_FALLBACK;
let expandedDockWidth = DEFAULT_EXPANDED_WIDTH;
let compactWidthMode = true;
export function getDockWidth(): number {
    return compactWidthMode ? getCompactDockWidth() : dockWidth;
}
export function getExpandedDockWidth(): number { return expandedDockWidth; }
export function isCompactDockWidth(): boolean { return compactWidthMode; }
export function setDockWidth(w: number): void {
    const compactWidth = getCompactDockWidth();
    dockWidth = clampWidthRaw(w);
    compactWidthMode = dockWidth <= compactWidth;
    if (!compactWidthMode) expandedDockWidth = dockWidth;
}

/** Remember the wide-side preset without forcing a compact rail open. The General
 * settings slider uses this so "Expanded dock width" remains a preset, not a second
 * live-width state that unexpectedly widens the current channel. */
export function setExpandedDockWidth(w: number): number {
    expandedDockWidth = clampWidthRaw(w);
    if (!compactWidthMode) dockWidth = expandedDockWidth;
    return expandedDockWidth;
}

/** F9 width switch. The dock itself never hides and every tab/view remains mounted;
 * only the one global rail width changes between compact and the remembered preset. */
export function toggleDockWidthMode(): number {
    if (compactWidthMode) {
        // Keep the configured intent intact when the window is temporarily narrow.
        // applyDockLayout() clamps only the painted width and restores the full preset
        // automatically once there is room again.
        dockWidth = expandedDockWidth;
        compactWidthMode = false;
    } else {
        const compactWidth = getCompactDockWidth();
        if (dockWidth > compactWidth) expandedDockWidth = dockWidth;
        dockWidth = compactWidth;
        compactWidthMode = true;
    }
    return dockWidth;
}

// `seeded` makes the LS read happen exactly once (the first makeWindow call), so a
// later makeWindow (a new tab) doesn't re-clobber a width the user has since set.
let dockWidthSeeded = false;
export function seedDockWidthFromLS(): void {
    if (dockWidthSeeded) return;
    dockWidthSeeded = true;
    expandedDockWidth = clampWidthRaw(
        parseInt(lsGet(LS_WIDTH) || "", 10) || DEFAULT_EXPANDED_WIDTH
    );
    dockWidth = getCompactDockWidth();
    compactWidthMode = true;
}

/** Clamp a width to [native member width, MAX_WIDTH_FRAC·windowWidth]. */
export function clampWidthRaw(w: number): number {
    const min = getCompactDockWidth();
    const max = Math.max(min, Math.floor((window.innerWidth || 1280) * MAX_WIDTH_FRAC));
    return Math.min(max, Math.max(min, w));
}

/** Alias kept for the call sites that used the public name `clampWidth`. */
export function clampWidth(w: number): number {
    return clampWidthRaw(w);
}

// ---------------------------------------------------------------------------
// Page topology — finding the flex container the dock + chat share.
// ---------------------------------------------------------------------------

/** The PAGE INNER div = the page__'s child that directly contains chat_. The dock
 *  host mounts here as the last flex child (a sibling of chat_), so it pushes the
 *  chat exactly like a native thread sidebar. */
export function findPageInner(): HTMLElement | null {
    const page = document.querySelector<HTMLElement>('div[class*="page_"]');
    if (!page) return null;
    for (const child of Array.from(page.children)) {
        const el = child as HTMLElement;
        if (el.querySelector(':scope > div[class*="chat_"]')) return el;
    }
    const chat = page.querySelector<HTMLElement>('div[class*="chat_"]');
    if (chat) {
        let el: HTMLElement | null = chat;
        while (el && el.parentElement !== page) el = el.parentElement;
        if (el) return el;
    }
    return null;
}

/** The chat_ element (our in-flow sibling) inside the page inner div. */
export function findChat(inner: HTMLElement): HTMLElement | null {
    return inner.querySelector<HTMLElement>(':scope > div[class*="chat_"]');
}

/** Width the message area shares with the dock = the page-inner flex container's
 *  inner width (chat + host are its flex children). Robust to the server rail /
 *  channel sidebar being shown or hidden (those sit OUTSIDE the page-inner div).
 *  Falls back to a window-derived estimate before the inner div exists. */
export function availableContentWidth(inner: HTMLElement | null): number {
    const cw = inner?.clientWidth || 0;
    if (cw > 0) return cw;
    return Math.max(0, (window.innerWidth || 1280));
}

/** Clamp a width chosen by the LEFT-edge resize DRAG. Native clamps the drag so the
 *  chat keeps its minimum (you can't drag a docked panel so wide the chat
 *  collapses) — floating is reserved for a too-narrow WINDOW, not for dragging. So:
 *  on top of the base clamp, cap the dragged width to leave the chat ≥ CHAT_MIN_WIDTH
 *  while there's room to dock at all. */
export function clampDockDrag(w: number): number {
    let v = clampWidthRaw(w);
    const inner = findPageInner();
    const avail = availableContentWidth(inner);
    const dockMinWidth = getCompactDockWidth();
    if (avail > 0) {
        const maxDocked = avail - CHAT_MIN_WIDTH;
        if (maxDocked >= dockMinWidth) v = Math.min(v, maxDocked);
    }
    return v;
}

// ---------------------------------------------------------------------------
// applyDockLayout — the docked/floating DOM geometry.
// ---------------------------------------------------------------------------

/** TWO-MODE geometry: decide docked (push) vs floating (overlay) from the shared
 *  content width and apply the host's width/flex/position accordingly. This is the
 *  SINGLE place the mode + clamp live; every entry point (open, channel switch,
 *  window resize, resize-drag) calls it.
 *
 *  Native parity:
 *   - DOCKED: the host stays an in-flow flex spacer that pushes the chat. The
 *     APPLIED width is clamped to keep the chat ≥ CHAT_MIN_WIDTH (and the dock ≥
 *     native compact width) — we never overwrite the user's intended `dockWidth`, only
 *     what is painted, so the dock restores its full width when the window grows
 *     again (exactly like native).
 *   - FLOATING: triggered only when even the native compact width can't fit beside
 *     CHAT_MIN_WIDTH (the WINDOW is too narrow). The host is taken out of flow
 *     (position:absolute via .dockview-host--floating) so the chat reclaims FULL
 *     width underneath; the card overlays from the content's right edge at a width
 *     capped to leave a clickable chat sliver. No resize handle in this mode (CSS
 *     hides it under the floating class). */
export function applyDockLayout(): void {
    const host = document.getElementById(HOST_ID);
    if (!host) return;

    const inner = findPageInner();
    const avail = availableContentWidth(inner);
    const want = getActiveWindow().state.width; // the user's intended (persisted) width
    const dockMinWidth = getCompactDockWidth();

    // Compact is a fixed native-member-width mode, not a narrow resizable mode.
    // CSS uses this marker to remove the 8px resize handle entirely so the native
    // 264px member rail receives the full 264px instead of being squeezed to 256px.
    host.classList.toggle("dockview-host--compact", isCompactDockWidth());

    // Floating ⟺ even the dock's minimum can't sit beside the chat's minimum.
    const floating = avail > 0 && (avail - dockMinWidth) < CHAT_MIN_WIDTH;

    if (floating) {
        // Overlay: width fits the content and leaves a chat sliver clickable.
        const maxFloat = Math.max(dockMinWidth, avail - FLOAT_CHAT_SLIVER);
        const applied = Math.max(dockMinWidth, Math.min(want, maxFloat));
        host.classList.add("dockview-host--floating");
        // position:absolute (from the class) takes the host out of the flex row;
        // width is the overlay width. flex is reset so it contributes nothing.
        host.style.flex = "0 0 auto";
        host.style.width = `${applied}px`;
    } else {
        // Docked push + clamp: keep the chat ≥ its min while docked, but never below
        // the dock's own min. Only the APPLIED width is clamped.
        host.classList.remove("dockview-host--floating");
        let applied = want;
        if (avail > 0) {
            const maxDocked = avail - CHAT_MIN_WIDTH;
            applied = Math.min(want, maxDocked);
            applied = Math.max(applied, dockMinWidth);
        }
        host.style.flex = `0 0 ${applied}px`;
        host.style.width = `${applied}px`;
    }
}

/** Write ONLY the host's geometry from state.width, nothing else. Used in the
 *  resize drag's rAF loop so a width change is a single cheap layout pass (no React
 *  render, no document-class / page-inner work like applyOpenState). The mode/clamp
 *  recompute lives in applyDockLayout(), so a drag re-evaluates the mode live too. */
export function applyHostWidth(): void {
    applyDockLayout();
}

/** Set the remembered EXPANDED width, repaint it only when the rail is already expanded,
 *  and persist it. The compact width follows Discord; F9 switches between the two. */
export function setDockWidthPersisted(w: number): number {
    const clamped = setExpandedDockWidth(w);
    applyHostWidth();
    lsSet(LS_WIDTH, String(Math.round(clamped)));
    return clamped;
}
