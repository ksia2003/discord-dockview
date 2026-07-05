/*
 * The tab strip (pin-driven multi-window). Renders one tab per REAL window — a
 * content tab or a pinned tab (isRealTab). A content-less transient (the F9-opened
 * empty shell) gets NO tab, so the strip is empty and the shell shows the empty-state
 * body. The tabs ARE the header's icon/name slot.
 *
 * "header = tab" model (browser-tab grammar): the ONLY inline control on a tab is its
 * ✕ (close THAT window via closeTab — closing the LAST real tab auto-hides the dock;
 * the far-right DOCK X, owned by DockPanel, closes the whole dock). There is NO inline
 * ⋯ on any tab — a tab's secondary actions (pin/unpin, etc.) are reached by RIGHT-CLICK
 * (onContextMenu → DockMoreMenu for THAT window, in place, never setActiveWindow → no
 * tab switch). Tabs are FLAT (icon + name); the active tab gets a subtle underline +
 * brighter text (CSS), not a pill.
 *
 * The ✕ follows browser-tab visibility: the ACTIVE tab shows its ✕ at rest; an INACTIVE
 * tab hides its ✕ at rest and reveals it only on HOVER (absolutely positioned at the
 * tab's right edge over a small gradient so it stays legible, and so it never reflows
 * the strip — pure CSS, see style.css). A shrunk inactive tab at rest is just icon + …name.
 *
 * PINNED tabs are treated IDENTICALLY to regular tabs (same icon + name, same
 * flex/width/shrink rules, same ✕ grammar). The ONLY distinction is (a) they render
 * FIRST (leftmost — pinned-first ordering, owned by getWindows()) and (b) a small pin
 * BADGE overlaid at the corner of their icon (a muted pushpin glyph, no bg/border fill).
 * A pinned tab's ✕ CLOSES it (closeTab does the global removal for a pinned window);
 * UNPIN is reached via right-click → DockMoreMenu ("Unpin tab"). On overflow the ACTIVE
 * tab keeps its full length while inactive tabs shrink + ellipsise (pure CSS flex).
 *
 * FLIP REORDER ANIMATION: whenever a tab changes position in the strip (pin → slides
 * left into the pinned group, unpin → slides back, drag-reorder), it animates SLIDING
 * smoothly to its new slot. The mechanism is self-contained (no per-action wiring): a
 * useLayoutEffect records each tab's left offset every render; on the next render it
 * compares, and for any tab whose position moved it applies the INVERSE translate
 * immediately, then (next frame) transitions it back to identity (~180ms ease). The
 * `prefers-reduced-motion` media query short-circuits the animation (positions snap).
 */

import { ContextMenuApi, React } from "@webpack/common";

import { requestRender } from "../engine/forceRender";
import { closeTab, switchToWindow } from "../engine/tabs";
import { getActiveWindowId, getWindows, isRealTab, reorderTab } from "../engine/window";
import { STRINGS } from "../strings";
import type { ContentType } from "../engine/types";
import { DockMoreMenu } from "./DockMoreMenu";
import { iconPaths } from "./toolbar";

const TAB_CLOSE_PATH = "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z";

// A tiny pushpin glyph for the pin BADGE overlaid at a pinned tab's icon corner —
// the ONLY visual mark that distinguishes a pinned tab (that + its left position).
// Drawn in a small standalone SVG on its own 24-box so it scales cleanly to ~10px;
// coloured via CSS (muted --text-muted), never a background/border fill on the tab.
const PIN_BADGE_PATH = "M19.38 11.38a3 3 0 0 0 0-4.24l-2.52-2.52a3 3 0 0 0-4.24 0l-1.06 1.06a1 1 0 0 0 0 1.42l.7.7-4.6 4.6a1 1 0 0 0 0 1.41l.36.36-2.83 2.83a2 2 0 0 0-.44.68l-1 2.5a1 1 0 0 0 1.3 1.3l2.5-1a2 2 0 0 0 .68-.44l2.83-2.83.36.36a1 1 0 0 0 1.41 0l4.6-4.6.7.7a1 1 0 0 0 1.42 0l1.06-1.06Z";

/** A file-type glyph for a tab, optionally carrying the pin badge overlay. SIZE
 *  PARITY with the single-window header's leading glyph (20px) — a tab must never
 *  shrink any element vs the pre-tab header. When `pinned`, a small pushpin badge is
 *  drawn at the icon's corner (a sibling absolutely-positioned SVG, so it never resizes
 *  or reflows the icon itself). */
function tabIcon(type: ContentType, pinned: boolean) {
    const glyph = React.createElement(
        "svg",
        { key: "glyph", className: "dockview-tab-icon", width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
        ...iconPaths(type)
    );
    if (!pinned) return glyph;
    return React.createElement(
        "span",
        { className: "dockview-tab-iconwrap" },
        glyph,
        React.createElement(
            "svg",
            { key: "pin", className: "dockview-tab-pinbadge", width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: PIN_BADGE_PATH })
        )
    );
}

/** A per-tab ghost icon control (the ✕) — flat, borderless, at a tab's right edge.
 *  Distinct from the tab body so its click never bubbles into a tab switch. SIZE
 *  PARITY with the single-window header's controls (20px). */
function tabCtrlBtn(opts: { key: string; cls: string; label: string; path: string; onClick: (e: any) => void; }) {
    return React.createElement(
        "button",
        {
            key: opts.key,
            type: "button",
            className: "dockview-tab-ctrl " + opts.cls,
            "aria-label": opts.label,
            title: opts.label,
            onClick: opts.onClick
        },
        React.createElement(
            "svg",
            { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: opts.path })
        )
    );
}

// The id of the tab currently being dragged (module-scoped: one strip is visible at a
// time, and HTML5 dnd is a single active gesture). Cleared on drop / dragend.
let dragId: string | null = null;

// FLIP duration (ms) — a smooth-but-brief browser-tab-style slide.
const FLIP_MS = 180;

/** Run one FLIP pass against the strip's live DOM. `prev` maps a tab id to its last
 *  measured left offset (within the strip); we read each tab's CURRENT left, and for
 *  any tab that moved we set an inverse translateX with NO transition (so it visually
 *  stays where it was), then on the next frame clear the transform WITH a transition so
 *  it slides to its real slot. Returns the fresh offsets to store for the next render.
 *  Honours prefers-reduced-motion (no animation — just records the new offsets). */
function runFlip(strip: HTMLElement, prev: Map<string, number>): Map<string, number> {
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]"));
    const next = new Map<string, number>();
    const stripLeft = strip.getBoundingClientRect().left;
    for (const el of tabs) next.set(el.dataset.tabId as string, el.getBoundingClientRect().left - stripLeft);

    const reduce = typeof window !== "undefined" && typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || prev.size === 0) return next;

    const moved: HTMLElement[] = [];
    for (const el of tabs) {
        const id = el.dataset.tabId as string;
        const before = prev.get(id);
        const after = next.get(id);
        if (before == null || after == null) continue;
        const delta = before - after;
        if (Math.abs(delta) < 1) continue;
        // INVERT: place the tab back at its old position instantly (no transition).
        el.style.transition = "none";
        el.style.transform = `translateX(${delta}px)`;
        moved.push(el);
    }
    if (moved.length) {
        // PLAY: next frame, clear the inverse with a transition → slide to identity.
        requestAnimationFrame(() => {
            for (const el of moved) {
                el.style.transition = `transform ${FLIP_MS}ms ease`;
                el.style.transform = "";
            }
            // Drop the inline transition once the slide is done so it never lingers.
            window.setTimeout(() => {
                for (const el of moved) el.style.transition = "";
            }, FLIP_MS + 40);
        });
    }
    return next;
}

/** Tabs row (browser-tab grammar). A tab carries a ✕ acting on THAT window (closeTab —
 *  active or not; closing the last tab closes the dock; a pinned window's close is a
 *  global removal). The active tab shows its ✕ at rest; inactive tabs reveal it on hover
 *  (CSS). A tab's secondary actions (pin/UNPIN, etc.) are reached by right-click
 *  (onContextMenu → DockMoreMenu), not an inline ⋯. A content-less window yields NO tab
 *  (empty strip + the empty-state body) — the tab-less empty shell is only ever the
 *  F9-open path.
 *
 *  PINNED tabs render IDENTICALLY to regular tabs (icon + name, same flex/width/shrink,
 *  same ✕) — distinguished ONLY by the pin badge on their icon + their left position
 *  (pinned-first, owned by getWindows()). Their ✕ closes; right-click → "Unpin tab".
 *
 *  DRAG-TO-REORDER: each tab is draggable; dropping it onto another tab reorders it
 *  (via reorderTab) within its partition (pinned among pinned, channel among channel)
 *  so pinned-first is preserved, and the new order persists in the channel/pinned store.
 *
 *  FLIP: any reorder (pin / unpin / drag) animates the moved tabs sliding to their new
 *  slots — a useLayoutEffect measures offsets each render and inverts+plays on change. */
export function DockTabs() {
    const { useRef, useLayoutEffect } = React;
    const stripRef = useRef(null as HTMLElement | null);
    const offsetsRef = useRef(new Map<string, number>());
    useLayoutEffect(() => {
        if (stripRef.current) offsetsRef.current = runFlip(stripRef.current, offsetsRef.current);
    });

    const activeId = getActiveWindowId();
    return React.createElement(
        "div",
        { className: "dockview-tabs", role: "tablist", ref: stripRef },
        ...getWindows().filter(isRealTab).map(w => {
            const isActive = w.id === activeId;
            // An empty window (no file yet — the open-but-empty dock) shows the short
            // product name, not the long empty-card sentence.
            const label = (w.content.name as string | null) || STRINGS.tabs.untitled;
            const isPinned = w.pinned;
            // Right-click any tab → THAT window's menu in place (pin/unpin, etc.) — the
            // route to a tab's secondary actions now that no tab carries an inline ⋯.
            const onContextMenu = (e: any) => {
                e.preventDefault();
                e.stopPropagation();
                ContextMenuApi.openContextMenu(e, () => React.createElement(DockMoreMenu, { win: w }));
            };
            return React.createElement(
                "div",
                {
                    key: w.id,
                    "data-tab-id": w.id,
                    className: "dockview-tab"
                        + (isActive ? " dockview-tab-active" : "")
                        + (isPinned ? " dockview-tab-pinned" : ""),
                    role: "tab",
                    "aria-selected": isActive,
                    title: label,
                    draggable: true,
                    onClick: () => switchToWindow(w.id),
                    onContextMenu,
                    onDragStart: (e: any) => {
                        dragId = w.id;
                        try { e.dataTransfer.effectAllowed = "move"; } catch { /* */ }
                    },
                    onDragOver: (e: any) => {
                        if (dragId && dragId !== w.id) { e.preventDefault(); try { e.dataTransfer.dropEffect = "move"; } catch { /* */ } }
                    },
                    onDrop: (e: any) => {
                        e.preventDefault();
                        if (dragId && dragId !== w.id && reorderTab(dragId, w.id)) requestRender();
                        dragId = null;
                    },
                    onDragEnd: () => { dragId = null; }
                },
                // Pinned tabs get the SAME icon + name + ✕ as a regular tab; the ONLY
                // mark is the pin badge on the icon (tabIcon) and the left position.
                tabIcon(w.content.type, isPinned),
                React.createElement("span", { key: "name", className: "dockview-tab-name" }, label),
                tabCtrlBtn({
                    key: "close",
                    cls: "dockview-tab-close",
                    label: STRINGS.tabs.close,
                    path: TAB_CLOSE_PATH,
                    onClick: (e: any) => {
                        e.stopPropagation();
                        closeTab(w.id);
                    }
                })
            );
        })
    );
}
