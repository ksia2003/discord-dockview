/*
 * The per-window load-token race guard.
 *
 * Every load captures a token; an async loader compares it against the live
 * sequence for its DockWindow and bails its content-write once a newer load has
 * superseded it. A module-global sequence would let an unrelated tab/channel
 * switch strand another window's in-flight loader.
 */

import type { DockWindow, LoadToken } from "./types";

const loadSeq = new WeakMap<DockWindow, number>();

function currentSeq(win: DockWindow): number {
    return loadSeq.get(win) ?? 0;
}

/** Bump this window's sequence and return the token for its load. */
export function nextToken(win: DockWindow): LoadToken {
    const mine = currentSeq(win) + 1;
    loadSeq.set(win, mine);
    return { isCurrent: () => mine === currentSeq(win) };
}

/** Supersede any in-flight loader belonging to this window without starting one. */
export function bump(win: DockWindow): void {
    loadSeq.set(win, currentSeq(win) + 1);
}
