/*
 * The viewer registry — the one place every file format is listed.
 *
 * As each viewer module is ported it adds itself here. The dock engine looks a
 * viewer up by ContentType and never imports a concrete viewer directly, so
 * adding a format touches exactly: the new viewers/<fmt>/ module, one entry
 * here, one extension mapping in engine/detectType.ts, and one in embed.ts.
 *
 * The MCP viewer is registered conditionally (see maybeRegisterMcp) so the
 * parked bridge stays dormant unless its setting is on.
 */

import type { ContentType, Viewer } from "../engine/types";

const VIEWERS = new Map<ContentType, Viewer>();

/** Register a viewer. Called once per format as its module is set up. */
export function registerViewer(viewer: Viewer): void {
    VIEWERS.set(viewer.type, viewer);
}

/** The viewer for a content type, or undefined if none is registered yet. */
export function getViewer(type: ContentType): Viewer | undefined {
    return VIEWERS.get(type);
}

/** Every registered viewer. makeWindow iterates these to build the per-window
 *  view-state map (one viewer.createState() slice per type); zero registered =
 *  an empty map, which the engine tolerates. */
export function allViewers(): Viewer[] {
    return [...VIEWERS.values()];
}

// Viewers are wired up here as they are ported (P3 onward). Kept as explicit
// registration calls rather than module-top imports so a viewer with an
// accidental top-level side effect can't take the whole registry down on load.
//
//   import { CodeViewer } from "./text/CodeViewer";
//   registerViewer(CodeViewer);
