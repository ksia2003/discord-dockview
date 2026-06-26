/*
 * The INLINE IMAGE body — a centered, fit(contain) <img> with zoom + pan.
 *
 * Modelled on Discord's lightbox / a browser image viewer:
 *   - scale 1 = fit (CSS object-fit:contain keeps the whole image visible).
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

import { React } from "@webpack/common";

import { clearLiveController, getLiveController, requestRender, setLiveController } from "../../engine/forceRender";
import { getActiveWindow } from "../../engine/window";
import type { DockWindow, ImgViewState } from "../../engine/types";
import { galleryCanStep, galleryStep } from "./gallery";
import { ImageLightbox } from "./ImageLightbox";

// The live-controller slot name (the old `imgControls` module singleton).
export const IMAGE_CONTROLLER = "image";

// scale === 1 means "fit" (contain). Bumping scale zooms; tx/ty pan when zoomed
// past fit. `fullscreen` flips the image into a self-rendered lightbox overlay
// (IMG-2) and lives ON the view-state (not React state) so the SAME zoom/pan
// (scale/tx/ty) carries over verbatim when entering/leaving fullscreen — the
// inline body and the overlay drive one shared view-state, so the picture stays
// exactly where the user left it across the transition.
const IMG_MIN_SCALE = 1; // never below fit
const IMG_MAX_SCALE = 8;

/** The window's image view-state slice, created on demand. The VERY FIRST window
 *  is built at engine init BEFORE this viewer registers (the registry import that
 *  loads viewers transitively evaluates window.ts, whose initial makeWindow runs
 *  with an empty viewer set), so that one window can lack the slice. Every window
 *  made at runtime already has it; this back-fills the init-order edge. */
export function imgState(win: DockWindow = getActiveWindow()): ImgViewState {
    let iv = win.viewStates[IMAGE_CONTROLLER] as ImgViewState | undefined;
    if (!iv) {
        iv = { scale: 1, tx: 0, ty: 0, natW: 0, natH: 0, fullscreen: false };
        win.viewStates[IMAGE_CONTROLLER] = iv;
    }
    return iv;
}

/** Reset the image to fit (scale 1, centred). Keeps natW/natH (the loaded image
 *  dimensions) and the fullscreen flag — only the zoom/pan is reset. */
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
    registerControls = true
) {
    const { useRef, useEffect } = React;
    const iv = imgState(getActiveWindow());

    // Clamp pan so the (scaled) image can't be dragged entirely out of view.
    const clampPan = () => {
        const wrap = wrapRef.current;
        if (!wrap || !iv.natW || !iv.natH) return;
        const cw = wrap.clientWidth;
        const ch = wrap.clientHeight;
        if (!cw || !ch) return;
        // fitted (scale 1) display size with object-fit: contain.
        const fitScale = Math.min(cw / iv.natW, ch / iv.natH, 1);
        const dispW = iv.natW * fitScale * iv.scale;
        const dispH = iv.natH * fitScale * iv.scale;
        const maxX = Math.max(0, (dispW - cw) / 2);
        const maxY = Math.max(0, (dispH - ch) / 2);
        iv.tx = Math.max(-maxX, Math.min(maxX, iv.tx));
        iv.ty = Math.max(-maxY, Math.min(maxY, iv.ty));
    };

    const applyScale = (next: number, originX?: number, originY?: number) => {
        const wrap = wrapRef.current;
        const prev = iv.scale;
        next = Math.max(IMG_MIN_SCALE, Math.min(IMG_MAX_SCALE, next));
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
            // go to 100% real pixels: scale relative to the current fit scale.
            if (wrap && iv.natW && iv.natH) {
                const cw = wrap.clientWidth;
                const ch = wrap.clientHeight;
                const fitScale = Math.min(cw / iv.natW, ch / iv.natH, 1);
                const target = fitScale > 0 ? 1 / fitScale : 1;
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

    const { wrapProps, onImgLoad } = useImageInteraction(wrapRef, imgRef, rerender);

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
            // input / message box is focused.
            const host = document.querySelector("#dockview-root");
            const ae = document.activeElement;
            if (!host || !ae || !host.contains(ae)) return;
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
                    transform: `translate(${iv.tx}px, ${iv.ty}px) scale(${iv.scale})`
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
