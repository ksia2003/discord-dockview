/*
 * The INLINE IMAGE body — a centered, fit(contain) <img> with zoom + pan.
 *
 * Modelled on Discord's lightbox / a browser image viewer:
 *   - scale 1 = fit. The <img> is sized to its FINAL rendered dimensions (fit ×
 *     zoom) and the transform carries only pan + rotation — never scale — so
 *     100% (one source pixel per CSS pixel) is crisp, not an upscaled
 *     fit-sized layer.
 *   - wheel = zoom toward the cursor; double-click = toggle fit <-> 100% (real
 *     pixels); drag = pan when zoomed past fit. The header toolbar +/-/reset/
 *     fullscreen and the keyboard (+/-/0, f, ←/→) drive the same state via the
 *     live "image" controller.
 *
 * The body publishes its imperative controller into the forceRender "image" live-
 * controller slot (zoom / reset / fullscreen toggle); the header toolbar + the
 * keyboard read it back. UNMOUNT GUARD (load-bearing): on teardown we only clear
 * the slot if we still own it — a remount can register a new controller before the
 * old body's effect cleanup runs, and a bare clear would null the LIVE controller
 * the new body just published.
 *
 * The shared interaction hook (useImageInteraction) is reused VERBATIM by the
 * fullscreen lightbox so the picture keeps its exact zoom/pan across the inline ↔
 * fullscreen transition (one shared ImgViewState). The lightbox passes
 * registerControls=false so it never touches the inline body's controller slot.
 *
 * No module-top React.createElement / no module-top webpack member access — the
 * React proxy is only invoked inside the component bodies below.
 */

import { ContextMenuApi, React } from "@vencord/types/webpack/common";

import { dockHasFocus } from "../../engine/dockKeyboard";
import { clearLiveController, getLiveController, requestRender, setLiveController } from "../../engine/forceRender";
import { getActiveWindow } from "../../engine/window";
import type { DockWindow, ImgViewState } from "../../engine/types";
import { galleryCanStep, galleryStep } from "./gallery";
import { ImageLightbox } from "./ImageLightbox";
import { ImageContextMenu } from "./ImageContextMenu";
import { imgBox as sizeImgBox, panClamp, zoomCap, zoomForHundred } from "./size";

// The live-controller slot name (the old `imgControls` module singleton).
export const IMAGE_CONTROLLER = "image";

// scale === 1 means "fit" (contain). Bumping scale zooms; tx/ty pan when zoomed
// past fit. `fullscreen` flips the image into a self-rendered lightbox overlay
// (IMG-2) and lives ON the view-state (not React state) so the SAME zoom/pan
// (scale/tx/ty) carries over verbatim when entering/leaving fullscreen — the
// inline body and the overlay drive one shared view-state, so the picture stays
// exactly where the user left it across the transition.
const IMG_MIN_SCALE = 1; // never below fit
// A fixed 8× floor, raised per-surface to the 100% zoom when a narrow dock
// would need more (zoomCap in size.ts) so double-click always lands at one
// source pixel per CSS pixel.
const IMG_MAX_SCALE = 8;

/** The window's image view-state slice, created on demand. The VERY FIRST window
 *  is built at engine init BEFORE this viewer registers (the registry import that
 *  loads viewers transitively evaluates window.ts, whose initial makeWindow runs
 *  with an empty viewer set), so that one window can lack the slice. Every window
 *  made at runtime already has it; this back-fills the init-order edge. */
export function imgState(win: DockWindow = getActiveWindow()): ImgViewState {
    let iv = win.viewStates[IMAGE_CONTROLLER] as ImgViewState | undefined;
    if (!iv) {
        iv = { scale: 1, tx: 0, ty: 0, natW: 0, natH: 0, rotation: 0, fullscreen: false };
        win.viewStates[IMAGE_CONTROLLER] = iv;
    }
    return iv;
}

/** Reset the image to fit (scale 1, centred). Keeps natW/natH (the loaded image
 *  dimensions), the rotation and the fullscreen flag — only the zoom/pan is reset. */
export function resetImgView(win: DockWindow = getActiveWindow()): void {
    const iv = imgState(win);
    iv.scale = 1;
    iv.tx = 0;
    iv.ty = 0;
}

/** The live image controller, driven by the header toolbar + the keyboard. */
export interface ImgController {
    zoomIn: () => void;
    zoomOut: () => void;
    reset: () => void;
    getScale: () => number;
    rotate: () => void; // bump rotation 90° clockwise (0→90→180→270→0)
    toggleFullscreen: () => void;
}

/** Read the live image controller (header + keyboard reach for it). */
export function imgController(): ImgController | null {
    return getLiveController<ImgController>(IMAGE_CONTROLLER);
}

/**
 * The shared zoom/pan interaction, used by BOTH the inline body and the
 * fullscreen lightbox. Wheel zoom (cursor-focal), drag-to-pan (when zoomed past
 * fit), double-click fit↔100%. The view-state (scale/tx/ty/natW/natH) is the
 * window's ImgViewState, so whichever surface is mounted drives the SAME numbers —
 * which is exactly why the picture keeps its zoom/pan when switching between inline
 * and fullscreen. `rerender` repaints the host so the toolbar's % readout follows.
 * Returns the props the surface spreads onto its wrap element plus the <img>
 * onLoad.
 */
export function useImageInteraction(
    wrapRef: { current: HTMLDivElement | null },
    imgRef: { current: HTMLImageElement | null },
    rerender: () => void,
    // Only the INLINE body owns the shared "image" controller slot (the header
    // toolbar + keyboard drive it). The lightbox must NOT register: the inline body
    // never unmounts when the lightbox opens, so if the lightbox also wrote the
    // controller its unmount-cleanup would null the slot the still-mounted inline
    // body needs — leaving the toolbar/keyboard dead after the first fullscreen
    // round-trip.
    registerControls = true,
    // The margin subtracted from the wrap when fitting (the lightbox keeps a
    // 96px edge margin; the inline body fits the whole wrap → 0).
    fitPad = 0
) {
    const { useRef, useEffect } = React;
    const iv = imgState(getActiveWindow());

    // The box the image fits into: the wrap minus the lightbox edge margin
    // (inline pad = 0). Mirrors the CSS max-width/max-height fallback.
    const fitBox = (): { w: number; h: number } => {
        const wrap = wrapRef.current;
        return {
            w: Math.max(0, (wrap?.clientWidth ?? 0) - fitPad),
            h: Math.max(0, (wrap?.clientHeight ?? 0) - fitPad)
        };
    };

    // The <img>'s explicit layout box for THIS render — null until the image and
    // the wrap are measured, when the component falls back to the CSS fit sizing.
    const imgBoxForRender = (() => {
        if (!iv.natW || !iv.natH) return null;
        const { w: fw, h: fh } = fitBox();
        if (!fw || !fh) return null;
        return sizeImgBox(iv.natW, iv.natH, iv.rotation, iv.scale, fw, fh);
    })();

    // Clamp pan so the (zoomed) image can't be dragged entirely out of view.
    // The clamp measures the ROTATED footprint of the explicit box, so a 90/270
    // image pans correctly.
    const clampPan = () => {
        const wrap = wrapRef.current;
        if (!wrap || !iv.natW || !iv.natH) return;
        const cw = wrap.clientWidth;
        const ch = wrap.clientHeight;
        if (!cw || !ch) return;
        const { w: fw, h: fh } = fitBox();
        const box = sizeImgBox(iv.natW, iv.natH, iv.rotation, iv.scale, fw, fh);
        const clamped = panClamp(iv.tx, iv.ty, box.w, box.h, iv.rotation, cw, ch);
        iv.tx = clamped.tx;
        iv.ty = clamped.ty;
    };

    const applyScale = (next: number, originX?: number, originY?: number) => {
        const wrap = wrapRef.current;
        const prev = iv.scale;
        const { w: fw, h: fh } = fitBox();
        const maxScale = zoomCap(fw, fh, iv.natW, iv.natH, iv.rotation, IMG_MAX_SCALE);
        next = Math.max(IMG_MIN_SCALE, Math.min(maxScale, next));
        if (next === prev) return;
        // Zoom toward a focal point (cursor) so the pixel under the cursor stays
        // put. Origin is relative to the wrap centre.
        if (wrap && originX != null && originY != null) {
            const cw = wrap.clientWidth;
            const ch = wrap.clientHeight;
            const ox = originX - cw / 2;
            const oy = originY - ch / 2;
            const ratio = next / prev;
            iv.tx = ox - (ox - iv.tx) * ratio;
            iv.ty = oy - (oy - iv.ty) * ratio;
        }
        iv.scale = next;
        if (next === 1) {
            iv.tx = 0;
            iv.ty = 0;
        }
        clampPan();
        rerender();
    };

    // Re-clamp + repaint after the surface resizes (e.g. entering fullscreen
    // changes the wrap size, so the pan limits change). Cheap and idempotent.
    const reflow = () => { clampPan(); rerender(); };

    // Expose controls to the toolbar + keyboard while the INLINE body is mounted.
    // Fullscreen toggle lives here so the header button, keyboard ('f') and the
    // overlay's own close all flip the same flag and force a host repaint. The
    // lightbox passes registerControls=false (see note on the param).
    useEffect(() => {
        if (!registerControls) return;
        const ctrls: ImgController = {
            zoomIn: () => applyScale(iv.scale * 1.3),
            zoomOut: () => applyScale(iv.scale / 1.3),
            reset: () => { resetImgView(); rerender(); },
            getScale: () => iv.scale,
            // Rotate 90° clockwise (IMG-3). Snap back to fit (scale 1, centred) so the
            // rotated picture re-fits the panel cleanly — the rotated bounding box has
            // a different aspect, so holding an old zoom/pan would strand it off-centre.
            // requestRender repaints both the inline body and the lightbox (shared iv).
            rotate: () => {
                iv.rotation = (iv.rotation + 90) % 360;
                resetImgView();
                clampPan();
                requestRender();
            },
            toggleFullscreen: () => { iv.fullscreen = !iv.fullscreen; requestRender(); }
        };
        setLiveController(IMAGE_CONTROLLER, ctrls);
        // UNMOUNT GUARD: only clear the slot if it's still ours (a remount may have
        // already published a new controller — don't null the live one).
        return () => clearLiveController(IMAGE_CONTROLLER, ctrls);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Wheel zoom (cursor-focal). Bound natively (non-passive) so preventDefault
    // works and the panel body doesn't also scroll.
    useEffect(() => {
        const wrap = wrapRef.current;
        if (!wrap) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = wrap.getBoundingClientRect();
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            applyScale(iv.scale * factor, e.clientX - rect.left, e.clientY - rect.top);
        };
        wrap.addEventListener("wheel", onWheel, { passive: false });
        return () => wrap.removeEventListener("wheel", onWheel);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Re-measure + repaint when the surface resizes (dock drag, fullscreen
    // toggle): the explicit <img> size depends on the wrap, so a resize must
    // recompute it. Event-driven — no polling loop.
    useEffect(() => {
        const wrap = wrapRef.current;
        if (!wrap || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => reflow());
        ro.observe(wrap);
        return () => ro.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Drag to pan (only meaningful when zoomed past fit).
    const drag = useRef({ on: false, x: 0, y: 0, tx: 0, ty: 0 });
    const onPointerDown = (e: any) => {
        if (iv.scale <= 1) return;
        if (e.button != null && e.button !== 0) return;
        drag.current = { on: true, x: e.clientX, y: e.clientY, tx: iv.tx, ty: iv.ty };
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    };
    const onPointerMove = (e: any) => {
        if (!drag.current.on) return;
        iv.tx = drag.current.tx + (e.clientX - drag.current.x);
        iv.ty = drag.current.ty + (e.clientY - drag.current.y);
        clampPan();
        rerender();
    };
    const endDrag = (e: any) => {
        if (!drag.current.on) return;
        drag.current.on = false;
        try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    };

    // Double-click toggles fit <-> 100% (real pixels) at the cursor.
    const onDoubleClick = (e: any) => {
        const wrap = wrapRef.current;
        if (iv.scale === 1) {
            // go to 100% real pixels: one source pixel per CSS pixel.
            if (wrap && iv.natW && iv.natH) {
                const cw = wrap.clientWidth;
                const ch = wrap.clientHeight;
                const target = zoomForHundred(cw - fitPad, ch - fitPad, iv.natW, iv.natH, iv.rotation);
                const rect = wrap.getBoundingClientRect();
                applyScale(target, e.clientX - rect.left, e.clientY - rect.top);
            } else {
                applyScale(2);
            }
        } else {
            resetImgView();
            rerender();
        }
    };

    const onImgLoad = () => {
        const img = imgRef.current;
        if (img) {
            iv.natW = img.naturalWidth;
            iv.natH = img.naturalHeight;
        }
        clampPan();
        rerender();
    };

    return {
        applyScale,
        reflow,
        imgBox: imgBoxForRender,
        wrapProps: {
            onPointerDown,
            onPointerMove,
            onPointerUp: endDrag,
            onPointerLeave: endDrag,
            onDoubleClick
        },
        onImgLoad
    };
}

/** The INLINE IMAGE body. Keyed on content.seq by the dispatcher; spreads the
 *  shared interaction onto its wrap and renders the lightbox overlay when the
 *  fullscreen flag is set. Binds the inline single-key shortcuts (+/-/0, f, ←/→)
 *  while it is mounted — the lightbox binds its own ←/→ at capture and stops
 *  propagation, so these act inline-only. */
export function ImageBody() {
    const { useRef, useState, useEffect } = React;
    const wrapRef = useRef(null as HTMLDivElement | null);
    const imgRef = useRef(null as HTMLImageElement | null);
    const [, bump] = useState(0);
    // Re-render the WHOLE panel (not just this body) so the header toolbar's zoom %
    // readout stays in sync. requestRender bumps DockPanel's state; React reconciles
    // ImageBody by type (key=content.seq unchanged) so our refs + view-state survive.
    const rerender = () => { requestRender(); bump((n: number) => n + 1); };

    const { wrapProps, onImgLoad, imgBox } = useImageInteraction(wrapRef, imgRef, rerender);

    const win = getActiveWindow();
    const iv = imgState(win);

    // Inline single-key shortcuts: +/- zoom, 0 reset, f fullscreen, ←/→ gallery
    // step. Gated on the panel holding focus (the wrap is focusable) so they don't
    // fire while typing in the chat. Bound while the inline body is mounted; the
    // lightbox handles its own ←/→ at capture and stops propagation, so the gallery
    // keys here only act on the inline body. (Zoom keys read the live controller so
    // they share the exact zoom math the toolbar drives.)
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.altKey || e.metaKey) return;
            // Only act when the dock panel actually has focus — never while a chat
            // input / message box is focused. (Shared gate, reused by every viewer.)
            if (!dockHasFocus()) return;
            const ctrl = imgController();
            if (e.key === "+" || e.key === "=") {
                e.preventDefault(); ctrl?.zoomIn();
            } else if (e.key === "-" || e.key === "_") {
                e.preventDefault(); ctrl?.zoomOut();
            } else if (e.key === "0") {
                e.preventDefault(); ctrl?.reset();
            } else if (e.key === "f" || e.key === "F") {
                e.preventDefault(); ctrl?.toggleFullscreen();
            } else if (e.key === "ArrowLeft") {
                if (galleryCanStep(-1)) { e.preventDefault(); galleryStep(-1); }
            } else if (e.key === "ArrowRight") {
                if (galleryCanStep(1)) { e.preventDefault(); galleryStep(1); }
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const zoomed = iv.scale > 1;
    return React.createElement(
        React.Fragment,
        null,
        React.createElement(
            "div",
            {
                key: win.content.seq,
                ref: wrapRef,
                className: "dockview-img-wrap" + (zoomed ? " dockview-img-zoomed" : ""),
                tabIndex: 0,
                onContextMenu: (event: any) => {
                    const url = win.content.url;
                    if (!url) return;
                    event.preventDefault();
                    event.stopPropagation();
                    // If this image still has a mounted Discord source message, ask that
                    // exact React surface to open its permission-aware native menu at the
                    // Dock click position. A removed/virtualized source returns false and
                    // falls through to the honest Copy/Save-only menu below.
                    if (win.sourceImageContext?.({
                        clientX: event.clientX,
                        clientY: event.clientY
                    })) return;
                    ContextMenuApi.openContextMenu(event, () => React.createElement(ImageContextMenu, {
                        url,
                        name: win.content.name
                    }));
                },
                ...wrapProps
            },
            React.createElement("img", {
                ref: imgRef,
                className: "dockview-img",
                src: win.content.url || "",
                alt: win.content.name || "image",
                draggable: false,
                onLoad: onImgLoad,
                style: {
                    // The <img> is sized to its FINAL rendered dimensions (fit ×
                    // zoom) and the transform carries only pan + rotation — no
                    // scale — so the compositor rasters the decode at the size it
                    // is displayed (100% = one source px per CSS px, crisp).
                    ...(imgBox ? {
                        width: imgBox.w + "px",
                        height: imgBox.h + "px",
                        maxWidth: "none",
                        maxHeight: "none"
                    } : {
                        // PRE-LOAD fallback (naturalWidth/Height not known yet):
                        // keep the whole image visible until the JS sizes it.
                        maxWidth: "100%",
                        maxHeight: "100%"
                    }),
                    transform: `translate(${iv.tx}px, ${iv.ty}px) rotate(${iv.rotation}deg)`
                }
            })
        ),
        // The fullscreen overlay renders only when the flag is set. ImageBody and
        // ImageLightbox import each other (the lightbox reuses useImageInteraction
        // from here); the cycle is harmless because both files only declare
        // functions at module top — nothing executes during the import.
        iv.fullscreen ? React.createElement(ImageLightbox, null) : null
    );
}
