/*
 * The monotonic load-token race guard.
 *
 * Every load captures a token; an async loader compares it against the live
 * sequence and bails its content-write once a newer load has superseded it. This
 * replaces the old `content.url !== reqUrl` string compare, which couldn't
 * distinguish a re-click of the SAME url or two rapid switches to the same file
 * (the last click always wins now).
 *
 * `nextToken()` bumps the sequence and hands back a LoadToken whose isCurrent()
 * is true only until the next bump. `bump()` is the supersede-only path (a tab
 * switch / clear that must invalidate any in-flight loader without starting one).
 */

import type { LoadToken } from "./types";

let loadSeq = 0;

/** Bump the sequence and return the token for this load. The token is current
 *  until the next nextToken()/bump() supersedes it. */
export function nextToken(): LoadToken {
    const mine = ++loadSeq;
    return { isCurrent: () => mine === loadSeq };
}

/** Supersede any in-flight loader without starting a new one (tab switch, close,
 *  clear). Every captured token's isCurrent() goes false. */
export function bump(): void {
    loadSeq += 1;
}
