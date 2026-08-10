/*
 * Pure sizing/math gate for the DockView image viewer (plugin/viewers/image/
 * size.ts). Pins the contract:
 *   - fit (scale 1) shows the WHOLE image contain-fitted (never upscaled);
 *   - 100% (double-click) maps one source pixel to one CSS pixel — the <img>
 *     layout box equals the natural dimensions, so the compositor rasters the
 *     decode at the final display size instead of upscaling a fit-sized layer;
 *   - rotation swaps the box and the pan clamp measures the ROTATED footprint.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Imported as a whole module then destructured: the tsx loader here compiles
// .ts to CJS, where Node's named-import lexer does not see esbuild's __export
// helper; the default (module.exports) interop is stable on every loader.
import size from "../plugin/viewers/image/size.ts";

const {
    fitScale,
    imgBox,
    LIGHTBOX_FIT_PAD,
    panClamp,
    rotatedDims,
    visualFootprint,
    zoomCap,
    zoomForHundred
} = size;

const NAT_W = 2560;
const NAT_H = 1440;

// The style contract that makes the pure math hold in the real DOM: the wrap
// surfaces are display:flex, so the image must never flex-shrink the explicit
// final-size box back toward the container (that would defeat the 1:1
// contract), and the sharpness rules must stay free of transform scale, max
// constraints and permanent will-change.
const css = readFileSync(new URL("../plugin/style.css", import.meta.url), "utf-8");

test("LIGHTBOX_FIT_PAD matches the CSS 96px edge margin", () => {
    assert.equal(LIGHTBOX_FIT_PAD, 96);
});

test("image elements never flex-shrink the explicit final-size box (source contract)", () => {
    const inlineRule = css.match(/\.dockview-img\s*\{[^}]*\}/s)?.[0] ?? "";
    const lightboxRule = css.match(/\.dockview-lightbox-img\s*\{[^}]*\}/s)?.[0] ?? "";
    assert.ok(inlineRule.length > 0, "inline .dockview-img rule found");
    assert.ok(lightboxRule.length > 0, "lightbox .dockview-lightbox-img rule found");
    assert.match(inlineRule, /flex:\s*none/);
    assert.match(lightboxRule, /flex:\s*none/);
    assert.doesNotMatch(inlineRule, /will-change|max-width|max-height/);
    assert.doesNotMatch(lightboxRule, /will-change|max-width|max-height/);
});

test("rotatedDims swaps natural dims only at 90/270", () => {
    assert.deepEqual(rotatedDims(NAT_W, NAT_H, 0), [NAT_W, NAT_H]);
    assert.deepEqual(rotatedDims(NAT_W, NAT_H, 180), [NAT_W, NAT_H]);
    assert.deepEqual(rotatedDims(NAT_W, NAT_H, 90), [NAT_H, NAT_W]);
    assert.deepEqual(rotatedDims(NAT_W, NAT_H, 270), [NAT_H, NAT_W]);
});

test("fitScale contain-fits and never upscales", () => {
    // width-bound
    assert.equal(fitScale(380, 280, NAT_W, NAT_H), 380 / NAT_W);
    // height-bound
    assert.equal(fitScale(600, 200, NAT_W, NAT_H), 200 / NAT_H);
    // smaller image than the box stays at 1 (fit never enlarges)
    assert.equal(fitScale(800, 600, 200, 100), 1);
    // degenerate box/image stays at 1 (fit)
    assert.equal(fitScale(0, 280, NAT_W, NAT_H), 1);
    assert.equal(fitScale(380, 0, NAT_W, NAT_H), 1);
    assert.equal(fitScale(380, 280, 0, 1440), 1);
});

test("imgBox at scale 1 equals the contain fit", () => {
    const box = imgBox(NAT_W, NAT_H, 0, 1, 380, 280);
    assert.equal(box.w, 380);
    assert.ok(Math.abs(box.h - NAT_H * (380 / NAT_W)) < 1e-9);
});

test("portrait images fit by height and 100% still maps 1:1", () => {
    const P_W = 1440;
    const P_H = 2560;
    const fit = imgBox(P_W, P_H, 0, 1, 380, 280);
    assert.equal(fit.h, 280);
    assert.ok(Math.abs(fit.w - P_W * (280 / P_H)) < 1e-9);
    const zoom = zoomForHundred(380, 280, P_W, P_H);
    const box = imgBox(P_W, P_H, 0, zoom, 380, 280);
    assert.ok(Math.abs(box.w - P_W) < 1e-9);
    assert.ok(Math.abs(box.h - P_H) < 1e-9);
    // rotated 90 keeps the natural footprint at 100%
    const rZoom = zoomForHundred(380, 280, P_W, P_H, 90);
    const rBox = imgBox(P_W, P_H, 90, rZoom, 380, 280);
    const [rvw, rvh] = visualFootprint(rBox.w, rBox.h, 90);
    assert.ok(Math.abs(rvw - P_H) < 1e-9);
    assert.ok(Math.abs(rvh - P_W) < 1e-9);
});

test("100% zoom sizes the box to the natural dimensions (1 source px = 1 CSS px)", () => {
    const zoom = zoomForHundred(380, 280, NAT_W, NAT_H);
    assert.ok(Math.abs(zoom - (1 / (380 / NAT_W))) < 1e-9);
    const box = imgBox(NAT_W, NAT_H, 0, zoom, 380, 280);
    assert.ok(Math.abs(box.w - NAT_W) < 1e-9);
    assert.ok(Math.abs(box.h - NAT_H) < 1e-9);
});

test("the lightbox 96px margin still lands 100% at natural size", () => {
    const fitW = 1000 - LIGHTBOX_FIT_PAD;
    const fitH = 800 - LIGHTBOX_FIT_PAD;
    const zoom = zoomForHundred(fitW, fitH, NAT_W, NAT_H);
    const box = imgBox(NAT_W, NAT_H, 0, zoom, fitW, fitH);
    assert.ok(Math.abs(box.w - NAT_W) < 1e-9);
    assert.ok(Math.abs(box.h - NAT_H) < 1e-9);
});

test("a 90/270 image keeps its aspect, fits, and 100% maps the rotated natural size", () => {
    // the element box uses the UNROTATED dims — same aspect as the decode, so
    // the rotate() transform swaps exactly once and nothing distorts
    const fit = imgBox(NAT_W, NAT_H, 90, 1, 380, 280);
    assert.ok(Math.abs(fit.w / fit.h - NAT_W / NAT_H) < 1e-9);
    const [fw, fh] = visualFootprint(fit.w, fit.h, 90);
    assert.ok(fw <= 380 + 1e-9 && fh <= 280 + 1e-9);
    // 100% at 90° = the rotated natural footprint (natH × natW), 1:1
    const zoom = zoomForHundred(380, 280, NAT_W, NAT_H, 90);
    const box = imgBox(NAT_W, NAT_H, 90, zoom, 380, 280);
    const [vw, vh] = visualFootprint(box.w, box.h, 90);
    assert.ok(Math.abs(vw - NAT_H) < 1e-9);
    assert.ok(Math.abs(vh - NAT_W) < 1e-9);
    assert.ok(Math.abs(box.w - NAT_W) < 1e-9);
    assert.ok(Math.abs(box.h - NAT_H) < 1e-9);
});

test("a 4K screenshot in a narrow dock can reach exact 100% (cap ≥ 100% zoom)", () => {
    const fitW = 229; // narrow dock panel
    const fitH = 150;
    const zoom = zoomForHundred(fitW, fitH, 3840, 2160);
    assert.ok(zoom > 8); // a fixed 8× floor would have blocked true 100%
    assert.equal(zoomCap(fitW, fitH, 3840, 2160, 0, 8), zoom);
    const box = imgBox(3840, 2160, 0, zoom, fitW, fitH);
    assert.ok(Math.abs(box.w - 3840) < 1e-9);
    assert.ok(Math.abs(box.h - 2160) < 1e-9);
    // where 100% is below the floor, the floor stays as the cap
    assert.equal(zoomCap(380, 280, NAT_W, NAT_H, 0, 8), 8);
});

test("visualFootprint swaps box dims at 90/270", () => {
    assert.deepEqual(visualFootprint(380, 214, 0), [380, 214]);
    assert.deepEqual(visualFootprint(380, 214, 180), [380, 214]);
    assert.deepEqual(visualFootprint(380, 214, 90), [214, 380]);
    assert.deepEqual(visualFootprint(380, 214, 270), [214, 380]);
});

test("panClamp bounds pan by half the overflow of the ROTATED footprint", () => {
    // fits exactly -> no pan
    assert.deepEqual(panClamp(100, 100, 380, 213, 0, 380, 280), { tx: 0, ty: 0 });
    // zoomed -> clamped to half the overflow
    assert.deepEqual(panClamp(5000, 5000, NAT_W, NAT_H, 0, 380, 280),
        { tx: (NAT_W - 380) / 2, ty: (NAT_H - 280) / 2 });
    assert.deepEqual(panClamp(-9999, -9999, NAT_W, NAT_H, 0, 380, 280),
        { tx: -(NAT_W - 380) / 2, ty: -(NAT_H - 280) / 2 });
    // 90/270 measures the swapped footprint (visual width = box height)
    assert.deepEqual(panClamp(9999, 9999, 1000, 500, 90, 380, 280),
        { tx: (500 - 380) / 2, ty: (1000 - 280) / 2 });
    // a rotated image that still fits cannot be panned off-centre
    assert.deepEqual(panClamp(40, 40, 157.5, 280, 90, 380, 280), { tx: 0, ty: 0 });
});
