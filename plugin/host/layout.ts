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
import { findPageInnerForHost as findHostPageInner, selectDockHost } from "./hostSelection";

export { findPageInnerForHost } from "./hostSelection";

// Follow Discord's live native member-list width instead of freezing today's value.
// The current client resolves this custom property to 264px, but Discord can change it
// by build or experiment. The fallback is used only before/without that property.
export const COMPACT_WIDTH_FALLBACK = 264;
export const MIN_DOCK_WIDTH = 200;
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
let dockPresets = [COMPACT_WIDTH_FALLBACK, DEFAULT_EXPANDED_WIDTH];
let activePresetIndex = 0;
export function getDockWidth(): number {
    return dockWidth;
}
export function getDockWidthPresets(): number[] { return [...dockPresets]; }
export function getActiveDockPresetIndex(): number { return activePresetIndex; }
export function getExpandedDockWidth(): number { return dockPresets[dockPresets.length - 1] ?? DEFAULT_EXPANDED_WIDTH; }
export function isCompactDockWidth(): boolean { return Math.abs(dockWidth - getCompactDockWidth()) <= 1; }
export function setDockWidth(w: number): void {
    dockWidth = clampWidthRaw(w);
    const exact = dockPresets.findIndex(value => value === dockWidth);
    if (exact >= 0) activePresetIndex = exact;
}

/** Remember the wide-side preset without forcing a compact rail open. The General
 * settings slider uses this so "Expanded dock width" remains a preset, not a second
 * live-width state that unexpectedly widens the current channel. */
export function setExpandedDockWidth(w: number): number {
    const next = [...dockPresets];
    next[Math.max(0, next.length - 1)] = w;
    setDockWidthPresets(next);
    return getExpandedDockWidth();
}

/** Normalise and install the ordered non-zero F9 presets. Values stay in their authored
 * order; at least one preset always survives. Editing the active row changes
 * the live width, while editing another row does not jump the rail to that row. */
export function setDockWidthPresets(values: readonly number[]): number[] {
    const max = Math.max(200, Math.floor((window.innerWidth || 1280) * MAX_WIDTH_FRAC));
    const normalised: number[] = [];
    for (const raw of values) {
        const value = Math.min(max, Math.max(200, Math.round(Number(raw))));
        // Keep duplicate values during editing. Deleting a row merely because its slider
        // crossed another preset would make the settings UI jump underneath the pointer.
        if (Number.isFinite(value)) normalised.push(value);
    }
    if (normalised.length === 0) normalised.push(getCompactDockWidth());
    const priorIndex = Math.min(activePresetIndex, normalised.length - 1);
    dockPresets = normalised;
    activePresetIndex = priorIndex;
    dockWidth = dockPresets[activePresetIndex];
    return [...dockPresets];
}

export function parseDockWidthPresets(raw: unknown): number[] {
    const values = typeof raw === "string"
        ? raw.split(",").map(value => Number(value.trim()))
        : [];
    return setDockWidthPresets(values.filter(Number.isFinite));
}

export function selectDockWidthPreset(index: number): number {
    activePresetIndex = Math.max(0, Math.min(dockPresets.length - 1, Math.trunc(index)));
    dockWidth = dockPresets[activePresetIndex];
    return dockWidth;
}

/** Compatibility verb retained for the debug surface: switch between the first and last
 * configured non-zero presets. Product F9 uses selectDockWidthPreset + the hidden state. */
export function toggleDockWidthMode(): number {
    return selectDockWidthPreset(activePresetIndex === 0 ? dockPresets.length - 1 : 0);
}

// `seeded` makes the LS read happen exactly once (the first makeWindow call), so a
// later makeWindow (a new tab) doesn't re-clobber a width the user has since set.
let dockWidthSeeded = false;
export function seedDockWidthFromLS(): void {
    if (dockWidthSeeded) return;
    dockWidthSeeded = true;
    const migratedExpanded = clampWidthRaw(
        parseInt(lsGet(LS_WIDTH) || "", 10) || DEFAULT_EXPANDED_WIDTH
    );
    dockPresets = [getCompactDockWidth(), migratedExpanded]
        .filter((value, index, all) => all.indexOf(value) === index);
    activePresetIndex = 0;
    dockWidth = dockPresets[0];
}

/** Clamp a user preset to the supported non-zero range. */
export function clampWidthRaw(w: number): number {
    const min = MIN_DOCK_WIDTH;
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
function findPageInnerGlobally(): HTMLElement | null {
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

/** Find the inner belonging to `host`; only a missing host uses the legacy global scan. */
export function findPageInner(host: HTMLElement | null = selectDockHost()): HTMLElement | null {
    return host ? findHostPageInner(host) : findPageInnerGlobally();
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

// ---------------------------------------------------------------------------
// applyDockLayout — the docked/floating DOM geometry.
// ---------------------------------------------------------------------------

/** Responsive geometry: decide docked (push) vs floating (overlay) from the shared
 *  content width and apply the host's width/flex/position accordingly. This is the
 *  SINGLE place the mode + clamp live; every entry point (open, channel switch,
 *  window resize, preset switch) calls it.
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
export function applyDockLayout(host: HTMLElement | null = selectDockHost()): void {
    if (!host) return;

    const inner = findPageInner(host);
    const avail = availableContentWidth(inner);
    const want = getActiveWindow().state.width; // the user's intended (persisted) width
    const dockMinWidth = MIN_DOCK_WIDTH;

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

/** Write only the host's geometry from state.width. Preset switches and settings edits
 * use this cheap layout pass without rebuilding native portals. */
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
