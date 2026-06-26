/*
 * The FULLSCREEN image lightbox (IMG-2).
 *
 * A self-rendered overlay covering the whole renderer (not just the dock panel),
 * with a dimmed backdrop and the SAME zoom/pan engine as the inline body (shared
 * via the window's ImgViewState through useImageInteraction). We self-render
 * rather than reuse Discord's ImageModal because that component is NOT cleanly
 * resolvable from the isolated plugin context (findByProps("ImageModal") does not
 * return the component here) — a custom overlay has zero Discord-internal
 * dependencies and can't break on a client update.
 *   - Esc, the ✕ button, or clicking the dim backdrop closes it.
 *   - zoom/pan/double-click all work exactly as inline (shared interaction).
 *   - ←/→ step prev/next through the channel gallery (Discord-lightbox parity).
 *   - on enter/exit the view-state (scale/tx/ty) is untouched, so the picture
 *     stays exactly where it was. A portal would be ideal but the plugin avoids
 *     extra Discord deps; rendering inside the panel still paints full-viewport via
 *     position:fixed.
 *
 * No module-top React / webpack work — only function declarations + plain glyph
 * path-data strings. The element tree is built inside the component.
 */

import { React } from "@webpack/common";

import { requestRender } from "../../engine/forceRender";
import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import { galleryCanStep, galleryStep } from "./gallery";
import { imgState, useImageInteraction } from "./ImageBody";

// Chevron glyphs for the prev/next image stepper (Discord-style ghost icons).
const IMG_PREV_PATH = "M15.3 18.7a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 1 1 1.4 1.4L10 12l5.3 5.3a1 1 0 0 1 0 1.4Z";
const IMG_NEXT_PATH = "M8.7 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 1 1-1.4-1.4L14 12 8.7 6.7a1 1 0 0 1 0-1.4Z";
// The ✕ close glyph.
const CLOSE_PATH = "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z";

/** A round edge-anchored prev/next button for the fullscreen lightbox (matches
 *  the close button's affordance). `side` "prev"|"next" positions it left/right;
 *  `disabled` dims it (kept in place per grammar rule 9). */
function lightboxNavBtn(side: "prev" | "next", label: string, path: string, onClick: () => void, disabled: boolean) {
    return React.createElement(
        "button",
        {
            key: "lb-" + side,
            type: "button",
            className: "dockview-lightbox-nav dockview-lightbox-nav-" + side + (disabled ? " dockview-lightbox-nav-disabled" : ""),
            "aria-label": label,
            "aria-disabled": disabled || undefined,
            disabled,
            title: label,
            onClick: disabled ? undefined : onClick,
            // don't let a nav click reach the backdrop (which would close).
            onMouseDown: (e: any) => e.stopPropagation()
        },
        React.createElement(
            "svg",
            { width: 28, height: 28, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", { fill: "currentColor", d: path })
        )
    );
}

/** The fullscreen overlay. Shares the ImgViewState (scale/tx/ty) with the inline
 *  body so the picture keeps its exact zoom/pan across the transition. */
export function ImageLightbox() {
    const { useRef, useEffect, useState } = React;
    const wrapRef = useRef(null as HTMLDivElement | null);
    const imgRef = useRef(null as HTMLImageElement | null);
    const [, bump] = useState(0);
    const rerender = () => { requestRender(); bump((n: number) => n + 1); };

    const win = getActiveWindow();
    const iv = imgState(win);

    // registerControls=false: the inline body owns the "image" controller slot; the
    // lightbox must not touch that slot (see the param note in useImageInteraction).
    const { reflow, wrapProps, onImgLoad } = useImageInteraction(wrapRef, imgRef, rerender, false);

    const close = () => { iv.fullscreen = false; rerender(); };

    // Esc closes the lightbox; ←/→ step prev/next through the channel gallery
    // (Discord-lightbox parity). Bound at capture on window so it fires even
    // though the inline body's keydown handler is gated on panel focus — here we
    // always want these to act while the overlay is up. stopPropagation keeps Esc
    // from also hitting Discord's Esc handlers (close-modal, etc.) and keeps the
    // arrow keys from also firing the inline body's gallery step.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
            } else if (e.key === "ArrowLeft") {
                if (galleryCanStep(-1)) { e.preventDefault(); e.stopPropagation(); galleryStep(-1); }
            } else if (e.key === "ArrowRight") {
                if (galleryCanStep(1)) { e.preventDefault(); e.stopPropagation(); galleryStep(1); }
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The overlay wrap is a fresh, full-viewport surface; once it mounts the pan
    // limits differ from the inline body's, so re-clamp + repaint.
    useEffect(() => { reflow(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

    const zoomed = iv.scale > 1;
    return React.createElement(
        "div",
        {
            className: "dockview-lightbox",
            // clicking the backdrop (but not the image itself) closes.
            onMouseDown: (e: any) => { if (e.target === e.currentTarget) close(); }
        },
        React.createElement(
            "button",
            {
                type: "button",
                className: "dockview-lightbox-close",
                "aria-label": STRINGS.image.exitFullscreen,
                title: STRINGS.image.exitFullscreen,
                onClick: close
            },
            React.createElement(
                "svg",
                { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                React.createElement("path", { fill: "currentColor", d: CLOSE_PATH })
            )
        ),
        // prev/next channel-image steppers, on the left/right edges (Discord
        // lightbox grammar). Disabled (dimmed) at a true end / while loading.
        lightboxNavBtn("prev", STRINGS.image.prevImage, IMG_PREV_PATH, () => galleryStep(-1), !galleryCanStep(-1)),
        lightboxNavBtn("next", STRINGS.image.nextImage, IMG_NEXT_PATH, () => galleryStep(1), !galleryCanStep(1)),
        React.createElement(
            "div",
            {
                ref: wrapRef,
                className: "dockview-lightbox-stage" + (zoomed ? " dockview-img-zoomed" : ""),
                tabIndex: 0,
                ...wrapProps
            },
            React.createElement("img", {
                ref: imgRef,
                className: "dockview-lightbox-img",
                src: win.content.url || "",
                alt: win.content.name || "image",
                draggable: false,
                onLoad: onImgLoad,
                style: {
                    transform: `translate(${iv.tx}px, ${iv.ty}px) scale(${iv.scale})`
                }
            })
        )
    );
}
