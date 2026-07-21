/*
 * The DXF viewer — type "dxf".
 *
 * .dxf is an AutoCAD Drawing Interchange File: a TEXT format describing a 2D (some-
 * times 3D) engineering drawing as a list of ENTITIES (lines, arcs, circles, poly-
 * lines, ellipses, splines, text) plus reusable BLOCKS placed via INSERT. There is no
 * browser-native renderer, so — exactly like the raster decoders (tiff/psd/heic) and
 * the xlsx→csv retype — this loader FETCHES the text, PARSES it to an entity AST with
 * dxf-parser, DRAWS the entities to an offscreen <canvas> at high resolution with a
 * hand-rolled 2D pass, exports a same-origin `blob:` PNG url, and RETYPES the file to
 * "image" so the existing image viewer surface (fit-width, wheel-zoom, drag-pan,
 * fullscreen lightbox) gives the drawing the pan/zoom UX engineering drawings need —
 * for free, with no second surface to maintain.
 *
 * WHY A HAND-ROLLED 2D PASS (not three-dxf-loader): DXF drawings are overwhelmingly
 * 2D; a flat canvas pass over the entities is far simpler than spinning up a WebGL
 * scene + orthographic camera, produces crisp vector-quality lines, and lands straight
 * in the image pipeline. three is already a chunk but pulling it in for a 2D drawing
 * would be heavier and fuzzier. dxf-parser is small (~26 KB, text→AST, no node
 * builtins), so it ships INLINE — dynamic-imported off Vesktop startup behind the
 * "Loading DXF viewer…" dock state, never eager.
 *
 * RENDERING NOTES (the load-bearing correctness bits):
 *   - DXF Y axis points UP (math convention); the canvas Y axis points DOWN. We flip Y
 *     in the world→pixel transform so the drawing isn't upside-down.
 *   - We compute the drawing's bounding box over ALL drawn geometry (INSERTs expanded),
 *     then fit it into the canvas with uniform scale + margin so any unit system reads.
 *   - ARC/CIRCLE angles from dxf-parser are RADIANS; arcs sweep CCW start→end.
 *   - INSERT places a named BLOCK with translate/scale/rotate; we expand one level of
 *     block reference (nested INSERTs are expanded recursively, depth-capped) so block-
 *     based drawings aren't blank.
 *   - Colours are THEME-AWARE: the stroke is resolved from a semantic CSS var at render
 *     time (white-ish on the dock's dark theme) so lines are visible; no hard-coded hex.
 *
 * Single drawing in / single image out: this viewer ALWAYS retypes to "image" (there is
 * no multi-page DXF surface), so its Body never actually mounts — the dispatcher routes
 * to the image viewer once content.type flips. We still supply a placeholder Body to
 * satisfy the Viewer contract, and a dispose() that revokes the blob: url we created.
 *
 * Cache contract (mirrors the single-image raster path): the entry KEY stays
 * "dxf|<cdn-url>" (set by detectType at open time); we retype entry.type to "image" and
 * park the blob on entry.url so a restore re-points the <img>. The restore descriptor
 * derives its type from the file NAME (".dxf"), so routing type stays "dxf" and the key
 * still matches; dispose revokes the blob on eviction.
 */

import { STRINGS } from "../../strings";
import type { CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext } from "../../engine/types";
import { extOf } from "../../engine/detectType";
import { withLibLoading } from "../../engine/lazyLib";
import { resetImgView } from "../image/ImageBody";
import { DxfPlaceholderBody } from "./DxfBody";

/** The longest side of the rendered canvas, in pixels. Big enough that a zoomed-in
 *  detail of a complex drawing stays crisp in the image viewer's wheel-zoom, capped so
 *  a pathological drawing can't allocate a huge bitmap. */
const RENDER_MAX_PX = 2000;
/** Inner margin (fraction of the canvas) so the drawing doesn't touch the edges. */
const MARGIN_FRAC = 0.04;
/** INSERT recursion cap so a self-referential block can't loop forever. */
const MAX_INSERT_DEPTH = 12;

/** Axis-aligned bounding box accumulator over world coordinates. */
interface Bounds { minX: number; minY: number; maxX: number; maxY: number; any: boolean; }
function newBounds(): Bounds { return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, any: false }; }
function grow(b: Bounds, x: number, y: number): void {
    if (!isFinite(x) || !isFinite(y)) return;
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
    b.any = true;
}

/** A 2D affine transform applied to a block's entities at an INSERT (translate, uniform-
 *  ish scale per axis, rotation in radians). Composes for nested INSERTs. */
interface Xform { tx: number; ty: number; sx: number; sy: number; rot: number; }
const IDENTITY: Xform = { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 };
/** Apply an Xform to a local point → world point (scale, then rotate, then translate). */
function apply(t: Xform, x: number, y: number): [number, number] {
    const sxv = x * t.sx;
    const syv = y * t.sy;
    const c = Math.cos(t.rot), s = Math.sin(t.rot);
    return [t.tx + sxv * c - syv * s, t.ty + sxv * s + syv * c];
}
/** Compose two Xforms (apply `inner` in the frame already transformed by `outer`). */
function compose(outer: Xform, inner: Xform): Xform {
    const [tx, ty] = apply(outer, inner.tx, inner.ty);
    return {
        tx, ty,
        sx: outer.sx * inner.sx,
        sy: outer.sy * inner.sy,
        rot: outer.rot + inner.rot
    };
}

/** Sample N points along an arc (CCW from a0→a1, radians) of a circle, transformed. */
function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, t: Xform, steps: number): Array<[number, number]> {
    let sweep = a1 - a0;
    while (sweep < 0) sweep += Math.PI * 2; // DXF arcs go CCW; normalise to a positive sweep
    if (sweep === 0) sweep = Math.PI * 2;
    const n = Math.max(2, Math.ceil(steps * (sweep / (Math.PI * 2))));
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= n; i++) {
        const a = a0 + (sweep * i) / n;
        pts.push(apply(t, cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
    return pts;
}

/** Sample an ellipse arc. dxf-parser gives center, a majorAxisEndPoint (relative to
 *  center) and an axisRatio (minor/major); start/endAngle are measured from the major
 *  axis. We rotate the parametric ellipse by the major-axis angle. */
function ellipsePoints(cx: number, cy: number, mx: number, my: number, ratio: number, a0: number, a1: number, t: Xform, steps: number): Array<[number, number]> {
    const major = Math.hypot(mx, my);
    const minor = major * ratio;
    const rot = Math.atan2(my, mx);
    let sweep = a1 - a0;
    while (sweep < 0) sweep += Math.PI * 2;
    if (sweep === 0) sweep = Math.PI * 2;
    const n = Math.max(2, Math.ceil(steps * (sweep / (Math.PI * 2))));
    const c = Math.cos(rot), s = Math.sin(rot);
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= n; i++) {
        const a = a0 + (sweep * i) / n;
        const ex = major * Math.cos(a);
        const ey = minor * Math.sin(a);
        pts.push(apply(t, cx + ex * c - ey * s, cy + ex * s + ey * c));
    }
    return pts;
}

/** A drawn primitive in WORLD coordinates: a polyline (open or closed) or a text label.
 *  The renderer collects these (so the bbox is exact) then strokes/fills them. */
type Prim =
    | { kind: "poly"; pts: Array<[number, number]>; closed: boolean }
    | { kind: "text"; x: number; y: number; h: number; rot: number; text: string };

/** Walk a list of entities under a transform, emitting world-space primitives and
 *  growing the bounds. `blocks` is the DXF block table (for INSERT expansion). */
function collect(entities: any[], blocks: Record<string, any>, t: Xform, depth: number, out: Prim[], b: Bounds): void {
    if (!entities) return;
    for (const e of entities) {
        switch (e.type) {
            case "LINE": {
                if (!e.vertices || e.vertices.length < 2) break;
                const pts = e.vertices.map((v: any) => apply(t, v.x, v.y));
                for (const [x, y] of pts) grow(b, x, y);
                out.push({ kind: "poly", pts, closed: false });
                break;
            }
            case "LWPOLYLINE":
            case "POLYLINE": {
                if (!e.vertices || !e.vertices.length) break;
                const pts = e.vertices.map((v: any) => apply(t, v.x, v.y));
                for (const [x, y] of pts) grow(b, x, y);
                out.push({ kind: "poly", pts, closed: !!e.shape });
                break;
            }
            case "CIRCLE": {
                if (!e.center || !(e.radius > 0)) break;
                const pts = arcPoints(e.center.x, e.center.y, e.radius, 0, Math.PI * 2, t, 96);
                for (const [x, y] of pts) grow(b, x, y);
                out.push({ kind: "poly", pts, closed: true });
                break;
            }
            case "ARC": {
                if (!e.center || !(e.radius > 0)) break;
                const a0 = e.startAngle ?? 0;
                const a1 = e.endAngle ?? Math.PI * 2;
                const pts = arcPoints(e.center.x, e.center.y, e.radius, a0, a1, t, 96);
                for (const [x, y] of pts) grow(b, x, y);
                out.push({ kind: "poly", pts, closed: false });
                break;
            }
            case "ELLIPSE": {
                if (!e.center || !e.majorAxisEndPoint) break;
                const a0 = e.startAngle ?? 0;
                const a1 = e.endAngle ?? Math.PI * 2;
                const pts = ellipsePoints(
                    e.center.x, e.center.y,
                    e.majorAxisEndPoint.x, e.majorAxisEndPoint.y,
                    e.axisRatio ?? 1, a0, a1, t, 96
                );
                for (const [x, y] of pts) grow(b, x, y);
                out.push({ kind: "poly", pts, closed: Math.abs((a1 - a0) - Math.PI * 2) < 1e-6 });
                break;
            }
            case "SPLINE": {
                // Approximate with the control/fit polygon — a faithful-enough outline
                // without a NURBS evaluator (real drawings rarely lean on splines for
                // legibility, and the control polygon already conveys the path).
                const cps = e.fitPoints?.length ? e.fitPoints : e.controlPoints;
                if (!cps || cps.length < 2) break;
                const pts = cps.map((v: any) => apply(t, v.x, v.y));
                for (const [x, y] of pts) grow(b, x, y);
                out.push({ kind: "poly", pts, closed: !!e.closed });
                break;
            }
            case "POINT": {
                if (!e.position) break;
                const [x, y] = apply(t, e.position.x, e.position.y);
                grow(b, x, y);
                // a tiny plus-mark so a bare point is visible
                out.push({ kind: "poly", pts: [[x - 0.5, y], [x + 0.5, y]], closed: false });
                out.push({ kind: "poly", pts: [[x, y - 0.5], [x, y + 0.5]], closed: false });
                break;
            }
            case "SOLID":
            case "3DFACE": {
                const ps = e.points;
                if (!ps || ps.length < 3) break;
                const pts = ps.map((v: any) => apply(t, v.x, v.y));
                for (const [x, y] of pts) grow(b, x, y);
                out.push({ kind: "poly", pts, closed: true });
                break;
            }
            case "TEXT":
            case "MTEXT": {
                const p = e.startPoint || e.position;
                const txt = (e.text || "").toString();
                if (!p || !txt) break;
                const [x, y] = apply(t, p.x, p.y);
                const h = (e.textHeight || e.height || 1) * Math.abs(t.sy || 1);
                grow(b, x, y);
                grow(b, x + txt.length * h * 0.6, y + h);
                out.push({ kind: "text", x, y, h, rot: (e.rotation || 0) * Math.PI / 180 + t.rot, text: txt });
                break;
            }
            case "INSERT": {
                if (depth >= MAX_INSERT_DEPTH) break;
                const block = e.name != null ? blocks[e.name] : null;
                if (!block || !block.entities) break;
                const pos = e.position || { x: 0, y: 0 };
                const local: Xform = {
                    tx: pos.x, ty: pos.y,
                    sx: e.xScale ?? 1, sy: e.yScale ?? 1,
                    rot: (e.rotation || 0) * Math.PI / 180
                };
                collect(block.entities, blocks, compose(t, local), depth + 1, out, b);
                break;
            }
            default:
                break;
        }
    }
}

/** Resolve the stroke colour from a semantic CSS var so lines stay visible on whatever
 *  theme the dock is in (white-ish on the default dark theme). Falls back to a light
 *  grey if the var can't be read (offscreen render before mount, etc.). Uses the global
 *  document — ctx.window is the engine's DockWindow STATE object, not the DOM window
 *  (the raster viewer's canvas helper uses the global document the same way). */
function strokeColor(): string {
    try {
        const probe = document.createElement("div");
        probe.style.color = "var(--text-default, var(--header-primary, #e3e5e8))";
        document.body.appendChild(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        if (c && c !== "rgba(0, 0, 0, 0)") return c;
    } catch { /* fall through */ }
    return "#e3e5e8";
}

/** Parse + render a DXF to a blob: PNG url. Returns the url (+ dims) or throws. */
async function dxfToBlobUrl(text: string, ctx: ViewerContext): Promise<string> {
    const DxfParser: any = await withLibLoading(ctx, STRINGS.loading.lib.dxf, "dxf-parser",
        async () => (await import("dxf-parser")).default ?? (await import("dxf-parser")));
    const parser = new DxfParser();
    const dxf = parser.parseSync ? parser.parseSync(text) : parser.parse(text);
    if (!dxf || !dxf.entities) throw new Error("Couldn't parse the DXF drawing");

    const prims: Prim[] = [];
    const bounds = newBounds();
    collect(dxf.entities, dxf.blocks || {}, IDENTITY, 0, prims, bounds);
    if (!prims.length || !bounds.any) throw new Error("The DXF drawing has no visible geometry");

    // World extents → uniform fit into the canvas, leaving a margin. Guard a zero-area
    // (single horizontal/vertical line, or a point) so the scale stays finite.
    const worldW = Math.max(bounds.maxX - bounds.minX, 1e-6);
    const worldH = Math.max(bounds.maxY - bounds.minY, 1e-6);
    const aspect = worldW / worldH;
    let canvasW: number, canvasH: number;
    if (aspect >= 1) { canvasW = RENDER_MAX_PX; canvasH = Math.max(1, Math.round(RENDER_MAX_PX / aspect)); }
    else { canvasH = RENDER_MAX_PX; canvasW = Math.max(1, Math.round(RENDER_MAX_PX * aspect)); }

    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const cx = canvas.getContext("2d");
    if (!cx) throw new Error("No 2D canvas context");

    const margin = Math.min(canvasW, canvasH) * MARGIN_FRAC;
    const sx = (canvasW - 2 * margin) / worldW;
    const sy = (canvasH - 2 * margin) / worldH;
    const scale = Math.min(sx, sy);
    // Centre the drawing within the canvas after the uniform scale.
    const drawW = worldW * scale, drawH = worldH * scale;
    const offX = (canvasW - drawW) / 2;
    const offY = (canvasH - drawH) / 2;
    // world (x,y) → pixel: flip Y (DXF up → canvas down).
    const px = (x: number) => offX + (x - bounds.minX) * scale;
    const py = (y: number) => canvasH - (offY + (y - bounds.minY) * scale);

    const stroke = strokeColor();
    cx.lineWidth = 1;
    cx.lineJoin = "round";
    cx.lineCap = "round";
    cx.strokeStyle = stroke;
    cx.fillStyle = stroke;
    cx.textBaseline = "bottom";

    for (const p of prims) {
        if (p.kind === "poly") {
            if (p.pts.length < 2) continue;
            cx.beginPath();
            cx.moveTo(px(p.pts[0][0]), py(p.pts[0][1]));
            for (let i = 1; i < p.pts.length; i++) cx.lineTo(px(p.pts[i][0]), py(p.pts[i][1]));
            if (p.closed) cx.closePath();
            cx.stroke();
        } else {
            const fontPx = Math.max(7, p.h * scale);
            cx.save();
            cx.translate(px(p.x), py(p.y));
            if (p.rot) cx.rotate(-p.rot); // canvas Y is flipped, so negate the rotation
            cx.font = `${fontPx}px sans-serif`;
            cx.fillText(p.text, 0, 0);
            cx.restore();
        }
    }

    const blob: Blob | null = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Canvas export failed");
    return URL.createObjectURL(blob);
}

/** DXF loader: fetch the drawing text → parse + render → blob → retype to "image". */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = STRINGS.error.noSource.title;
        return;
    }
    ctx.content.loading = true;
    const reqUrl = opts.url;
    const ext = extOf(opts.url) || extOf(opts.name);
    if (ext !== "dxf") {
        // routed here only for .dxf; defensive guard
        ctx.content.loading = false;
        ctx.content.error = STRINGS.unsupported.title;
        return;
    }

    ctx.fetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.text();
        })
        .then(text => dxfToBlobUrl(text, ctx))
        .then(blobUrl => {
            if (entry) {
                entry.type = "image";
                entry.url = blobUrl;
                entry.loading = false;
                entry.error = null;
            }
            if (!token.isCurrent()) return; // superseded — entry holds the blob; dispose revokes it
            ctx.content.type = "image";
            ctx.content.url = blobUrl;
            resetImgView(ctx.window);
            ctx.content.loading = false;
            ctx.content.loadingLabel = null;
            ctx.content.error = null;
            ctx.requestRender();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (!token.isCurrent()) return;
            ctx.content.loading = false;
            ctx.content.loadingLabel = null;
            ctx.content.error = String(e?.message || e);
            ctx.requestRender();
        });
}

function createState(): Record<string, never> { return {}; }
function resetState(): void { /* no view-state — DXF retypes to image */ }
function snapshot(): void { /* nothing to persist; the entry retypes to image */ }
function restore(): void { /* nothing to restore */ }

/** Revoke the blob: url this viewer created when the cache entry is evicted. Guarded on
 *  the blob: scheme so we only ever revoke urls WE created, never a CDN url. */
function dispose(entry: CacheEntry): void {
    const u = entry.url;
    if (u && u.startsWith("blob:")) {
        try { URL.revokeObjectURL(u); } catch { /* already gone */ }
    }
}

export const DxfViewer: Viewer<Record<string, never>> = {
    type: "dxf",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    dispose,
    // load() retypes content.type to "image" before the body renders, so the dispatcher
    // always routes to the image viewer's Body — this placeholder Body is never mounted.
    Body: DxfPlaceholderBody,
    capabilities: { openInWindow: true }
};
