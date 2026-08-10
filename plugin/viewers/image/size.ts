/*
 * PURE image display-sizing math, shared by the inline body and the fullscreen
 * lightbox.
 *
 * The <img> is sized to its FINAL rendered dimensions (an explicit width/height
 * style) and the transform carries only pan (translate) + rotation — NEVER
 * scale. Sizing the element itself forces the compositor to rasterize the
 * decoded image at the displayed size, so 100% (one source pixel per CSS pixel)
 * is crisp. Enlarging a fit-sized layer with transform: scale() instead
 * upscales a low-resolution raster and goes soft. All functions are pure — no
 * DOM, no React, no webpack — so the math is unit-testable in isolation.
 */

/** The fullscreen lightbox keeps a margin around the fitted image so it never
 *  bleeds to the screen edge under the close button (matches Discord's
 *  lightbox). The inline body fits to the whole wrap, so its pad is 0. Kept in
 *  one place so the JS sizing and the CSS pre-load fallback cannot drift. */
export const LIGHTBOX_FIT_PAD = 96;

/** A 90/270° rotation swaps the natural width/height ("rotated dimensions").
 *  The fit-to-contain math and the sizing run on these, because the rotation
 *  transform turns the box into that footprint. */
export function rotatedDims(natW: number, natH: number, rotation: number): [number, number] {
    return rotation % 180 === 0 ? [natW, natH] : [natH, natW];
}

/** The contain-fit factor for an image of natW×natH inside a fitW×fitH box.
 *  Never upscales (fit caps at 1); a degenerate box/image stays at 1 (fit). */
export function fitScale(fitW: number, fitH: number, natW: number, natH: number): number {
    if (fitW <= 0 || fitH <= 0 || natW <= 0 || natH <= 0) return 1;
    return Math.min(fitW / natW, fitH / natH, 1);
}

/** The <img> layout box at a zoom `scale` (1 = fit). The fit factor is computed
 *  from the ROTATED footprint (so a 90/270 image fits the container), but the
 *  element box itself uses the UNROTATED natural dimensions: the <img> draws
 *  the un-rotated decode (object-fit fills the box exactly — same aspect), and
 *  the rotate() transform swaps it exactly once into the final footprint. */
export function imgBox(
    natW: number,
    natH: number,
    rotation: number,
    scale: number,
    fitW: number,
    fitH: number
): { w: number; h: number } {
    const [rw, rh] = rotatedDims(natW, natH, rotation);
    const f = fitScale(fitW, fitH, rw, rh);
    return { w: natW * f * scale, h: natH * f * scale };
}

/** The on-screen footprint of a W×H layout box after the rotation transform:
 *  90/270 swaps the box dims, 0/180 keeps them. The pan clamp runs on this. */
export function visualFootprint(boxW: number, boxH: number, rotation: number): [number, number] {
    return rotation % 180 === 0 ? [boxW, boxH] : [boxH, boxW];
}

/** Clamp the pan so the rotated image can't be dragged entirely out of the
 *  window: the displacement is bounded by half the overflow on each axis. */
export function panClamp(
    tx: number,
    ty: number,
    boxW: number,
    boxH: number,
    rotation: number,
    winW: number,
    winH: number
): { tx: number; ty: number } {
    const [vw, vh] = visualFootprint(boxW, boxH, rotation);
    const maxX = Math.max(0, (vw - winW) / 2);
    const maxY = Math.max(0, (vh - winH) / 2);
    return { tx: Math.max(-maxX, Math.min(maxX, tx)), ty: Math.max(-maxY, Math.min(maxY, ty)) };
}

/** The zoom that displays the image at natural size ("100%"): one source pixel
 *  per CSS pixel — the inverse of the (rotation-aware) contain-fit factor. */
export function zoomForHundred(
    fitW: number,
    fitH: number,
    natW: number,
    natH: number,
    rotation = 0
): number {
    const [rw, rh] = rotatedDims(natW, natH, rotation);
    const f = fitScale(fitW, fitH, rw, rh);
    return f > 0 ? 1 / f : 1;
}

/** The maximum permitted zoom: at least the given `floor` AND at least the
 *  surface's 100% zoom. A 2K/4K screenshot in a narrow dock has a tiny
 *  contain-fit factor, so 1/fit exceeds a fixed 8× floor and double-click
 *  would otherwise never reach one source pixel per CSS pixel. */
export function zoomCap(
    fitW: number,
    fitH: number,
    natW: number,
    natH: number,
    rotation = 0,
    floor = 8
): number {
    return Math.max(floor, zoomForHundred(fitW, fitH, natW, natH, rotation));
}
