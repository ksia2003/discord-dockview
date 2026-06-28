/*
 * The IMAGE viewer — the Viewer contract over a plain <img>.
 *
 * Images are the SIMPLEST loader: there is nothing to fetch or parse. The <img>
 * tag streams content.url itself (bypassing any byte fetch / decode), so load()
 * just validates the url, marks the entry resolved, and resets the zoom/pan for a
 * FRESH open. A cache RESTORE keeps the saved view (snapshot/restore park
 * scale/tx/ty on the entry), so we only reset on a genuine fresh load.
 *
 *  - load(): no fetch — clear loading, reset the view (fresh open lands at fit).
 *  - createState/resetState: the per-window ImgViewState (scale/tx/ty/natW/natH/
 *    fullscreen). fullscreen is the flag engine/showContent + engine/load read to
 *    close the lightbox when switching files (win.viewStates["image"].fullscreen).
 *  - snapshot/restore: park/restore the zoom/pan (scale/tx/ty) on the entry's view
 *    so reopening a cached image lands at the same zoom. natW/natH are re-derived
 *    on the <img> onLoad; fullscreen is intentionally NOT persisted (a cache return
 *    opens inline, never stranded in the overlay).
 *  - Body/HeaderControls: the inline <img> body + the row-2 controls.
 *  - capabilities: { gallery: true, openInWindow: true } — the channel image
 *    gallery rides over this viewer; external pop-out applies. No findModel, no
 *    dispose (nothing to release — the <img> is GC'd with its DOM).
 */

import type {
    CacheEntry, ImgViewState, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { ImageBody, resetImgView } from "./ImageBody";
import { ImageHeaderControls } from "./ImageHeaderControls";

/** IMAGE loader: nothing to fetch — the <img> renders content.url directly. A
 *  FRESH image opens at fit (scale 1); a cache RESTORE keeps the saved view
 *  (engine/viewState already restored the slice via restore()), so we only reset
 *  on a fresh load (this path). */
function load(opts: LoadOpts, _token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = "No image source";
        return;
    }
    // The <img> tag streams the url itself; no manual fetch/decode needed.
    if (entry) { entry.loading = false; entry.error = null; }
    resetImgView(ctx.window);
    ctx.content.loading = false;
    ctx.content.error = null;
}

function createState(): ImgViewState {
    return { scale: 1, tx: 0, ty: 0, natW: 0, natH: 0, rotation: 0, fullscreen: false };
}

function resetState(vs: ImgViewState): void {
    if (!vs) return;
    vs.scale = 1;
    vs.tx = 0;
    vs.ty = 0;
    vs.natW = 0;
    vs.natH = 0;
    vs.rotation = 0;
    vs.fullscreen = false;
}

/** Park the zoom/pan + rotation on the entry so a cache return reopens it exactly.
 *  The vs can be missing on the init-order edge window; treat that as fit. */
function snapshot(vs: ImgViewState, entry: CacheEntry): void {
    entry.view.imgScale = vs?.scale ?? 1;
    entry.view.imgTx = vs?.tx ?? 0;
    entry.view.imgTy = vs?.ty ?? 0;
    entry.view.imgRotation = vs?.rotation ?? 0;
}

/** Restore the zoom/pan + rotation from the entry on a cache return. natW/natH are
 *  re-derived on the <img> onLoad; fullscreen is NOT restored (always reopen inline). */
function restore(vs: ImgViewState, entry: CacheEntry): void {
    if (!vs) return; // missing slice (init-order edge) — back-filled on mount
    vs.scale = entry.view.imgScale ?? 1;
    vs.tx = entry.view.imgTx ?? 0;
    vs.ty = entry.view.imgTy ?? 0;
    vs.rotation = entry.view.imgRotation ?? 0;
}

export const ImageViewer: Viewer<ImgViewState> = {
    type: "image",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: ImageBody,
    HeaderControls: ImageHeaderControls,
    // No findModel (an image isn't findable). The image owns no inner scroller —
    // the <img> sits in .dockview-body, so the default scroller is correct.
    // No dispose: the <img> is GC'd with its DOM, nothing to release.
    capabilities: { gallery: true, openInWindow: true }
};
