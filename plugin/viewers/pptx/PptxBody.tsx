/*
 * The PowerPoint body — a scrollable list of slides rendered by @aiden0z/pptx-renderer
 * into a live container, with prev/next slide navigation + a slide counter (driven
 * from the header controls).
 *
 * The parsed presentation (a PresentationData model) is produced by PptxViewer.load
 * and lives on the cache entry; this body only READS content.pptx.presentation and
 * mounts a renderer over it. The effect (keyed on renderToken + seq, like PdfBody /
 * Model3DBody) builds the viewer once the deck is ready, renders the slide list with
 * the dock body as the IntersectionObserver scroll root (windowed mounting so a big
 * deck doesn't paint every slide at once), tracks the visible slide back into the
 * view-state, and publishes the "pptx" live controller (prev / next / goToSlide) that
 * the header toolbar + keyboard read.
 *
 * TEARDOWN (load-bearing): the renderer holds blob: URLs for embedded media, an
 * IntersectionObserver, and a chunk of DOM. So the cleanup calls viewer.destroy()
 * (which revokes the blob: URLs + disconnects observers + clears the DOM) and clears
 * the live-controller slot (UNMOUNT GUARD: only if we still own it). The parsed model
 * itself is NOT freed here — it's owned by the cache entry and re-used on a re-open.
 *
 * The renderer is loaded lazily (the lib + the DOM-free parse happen in the loader,
 * behind the "Loading presentation viewer…" dock state; by the time this body mounts
 * content.loading is false and the module is cached). We STILL import it dynamically
 * here — never a static import — so this module adds nothing to startup.
 */

import { React } from "@vencord/types/webpack/common";

import { dockHasFocus, isTextEntryFocused } from "../../engine/dockKeyboard";
import { clearLiveController, getLiveController, requestRender, setLiveController } from "../../engine/forceRender";
import { loadLib } from "../../engine/lazyLib";
import { getActiveWindow } from "../../engine/window";
import type { DockWindow, PptxViewState } from "../../engine/types";
import { PPTX_LIB_KEY } from "./PptxViewer";

// The live-controller slot name + the per-window view-state key.
export const PPTX_CONTROLLER = "pptx";

/** The window's pptx view-state slice (slide + total), created on demand. Mirrors
 *  pdfState's init-order back-fill: the very first window is built before this viewer
 *  registers, so it can lack the slice. */
export function pptxState(win: DockWindow = getActiveWindow()): PptxViewState {
    let vs = win.viewStates[PPTX_CONTROLLER] as PptxViewState | undefined;
    if (!vs) {
        vs = { slide: 1, total: 0 };
        win.viewStates[PPTX_CONTROLLER] = vs;
    }
    return vs;
}

/** Reset the pptx view to its fresh-open default (slide 1, unknown total). */
export function resetPptxView(win: DockWindow = getActiveWindow()): void {
    const vs = pptxState(win);
    vs.slide = 1;
    vs.total = 0;
}

/** The live pptx controller, driven by the header toolbar + keyboard. */
export interface PptxController {
    goToSlide: (n: number) => void; // 1-based
    prevSlide: () => void;
    nextSlide: () => void;
}

/** Read the live pptx controller (header / keyboard reach for it). */
export function pptxController(): PptxController | null {
    return getLiveController<PptxController>(PPTX_CONTROLLER);
}

/** The pptx body. Keyed on content.seq by the dispatcher; the effect builds the
 *  renderer once the parsed deck is ready, renders the slide list, tracks the visible
 *  slide, and tears the viewer down on unmount. */
export function PptxBody() {
    const { useRef, useEffect } = React;
    const containerRef = useRef(null as HTMLDivElement | null);

    const win = getActiveWindow();
    const seq = win.content.seq;
    const renderToken = win.content.pptx.renderToken;

    useEffect(() => {
        const host = containerRef.current;
        if (!host) return;
        const presentation = win.content.pptx.presentation;
        if (!presentation) return; // nothing parsed (error/empty) — the state card shows
        const vs = pptxState(win);

        // The scroll root for windowed list rendering + slide tracking is the dock
        // body scroller (.dockview-body), the same element every other viewer scrolls.
        const scroller = (host.closest(".dockview-body") as HTMLElement | null) || undefined;

        // Torn down by the cleanup; declared here so the cleanup closure can reach them
        // even if the async lib import resolves late.
        let disposed = false;
        let viewer: any = null;
        // hold the published controller so the unmount guard clears only ours.
        const controllerRef = { current: null as PptxController | null };

        // The 1-based slide the user left it on (cache restore / nav) — applied once
        // the deck has rendered. Clamp into range.
        const total = Array.isArray(presentation.slides) ? presentation.slides.length : 0;
        const startSlide = Math.min(Math.max(1, vs.slide || 1), Math.max(1, total));

        (async () => {
            // The lib is already cached (the loader awaited it through withLibLoading),
            // so this resolves from the lazy-lib cache instantly. Go through loadLib —
            // NOT a bare import("@aiden0z/pptx-renderer") — so the SAME path the loader
            // used is reused: for a chunked lib that's the on-disk chunk (the package
            // is external to the renderer bundle, so a bare import here would be a live
            // dangling specifier); for an inline lib it's the cached import().
            const lib: any = await loadLib(PPTX_LIB_KEY, () => import("@aiden0z/pptx-renderer"));
            if (disposed || !host.isConnected) return;

            const PptxViewer = lib.PptxViewer;
            const v = new PptxViewer(host, {
                // fit the slide to the container width (theme-agnostic; the slide's own
                // background paints, framed by the dock body).
                fitMode: "contain",
                scrollContainer: scroller,
                // windowed list rendering: only the slides near the viewport are
                // mounted, so a 100-slide deck doesn't paint all at once. Show a quiet
                // "Slide N" label under each slide for orientation.
                // Slide tracking: when the user scrolls, mirror the visible slide into
                // the view-state so the header counter follows (and a snapshot parks
                // the right slide). 0-based from the lib → 1-based in our state.
                onSlideChange: (index: number) => {
                    if (disposed) return;
                    const n = index + 1;
                    if (n !== vs.slide) { vs.slide = n; requestRender(); }
                }
            });
            viewer = v;

            // load the already-parsed model + render the slide list (windowed).
            v.load(presentation);
            await v.renderList({ windowed: true, initialSlides: 3, batchSize: 3, showSlideLabels: true });
            if (disposed) return;

            // make sure the header total is exact (the lib is the source of truth).
            const libCount = typeof v.slideCount === "number" ? v.slideCount : total;
            if (libCount && libCount !== vs.total) { vs.total = libCount; requestRender(); }

            // jump to the restored/last slide (no smooth scroll on first paint).
            if (startSlide > 1) {
                try { await v.goToSlide(startSlide - 1, { behavior: "instant" as ScrollBehavior }); } catch { /* clamp */ }
            }

            // Publish the controller now the viewer exists (prev / next / goToSlide).
            const ctrls: PptxController = {
                goToSlide: (n: number) => {
                    const cnt = (typeof v.slideCount === "number" && v.slideCount) || vs.total || total;
                    const idx = Math.min(Math.max(1, n), Math.max(1, cnt)) - 1;
                    vs.slide = idx + 1;
                    try { v.goToSlide(idx, { behavior: "smooth" }); } catch { /* ignore */ }
                    requestRender();
                },
                prevSlide: () => ctrls.goToSlide((vs.slide || 1) - 1),
                nextSlide: () => ctrls.goToSlide((vs.slide || 1) + 1)
            };
            setLiveController(PPTX_CONTROLLER, ctrls);
            // store on the closure so the cleanup can identity-clear the right one.
            controllerRef.current = ctrls;
            requestRender();
        })().catch(() => { /* a lib/render failure is already an errored content path */ });

        // --- keyboard shortcuts (the header tooltips advertise ←/→ slide nav) ---
        // ←/→ (and PageUp/PageDown) step slides through the SAME controller verbs the
        // prev/next chevrons drive, behind the shared dock-focus gate. Skipped while a
        // text field is focused (the slide-jump input in the header) so typing a slide
        // number isn't hijacked, and only single, unmodified keys act. Mirrors the
        // image/pdf window-keydown pattern.
        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.altKey || e.metaKey) return;
            if (!dockHasFocus() || isTextEntryFocused()) return;
            const ctrl = pptxController();
            if (!ctrl) return;
            if (e.key === "ArrowLeft" || e.key === "PageUp") {
                e.preventDefault(); ctrl.prevSlide();
            } else if (e.key === "ArrowRight" || e.key === "PageDown") {
                e.preventDefault(); ctrl.nextSlide();
            }
        };
        window.addEventListener("keydown", onKey);

        return () => {
            disposed = true;
            window.removeEventListener("keydown", onKey);
            if (viewer) {
                try { viewer.destroy(); } catch { /* ignore */ }
                viewer = null;
            }
            // UNMOUNT GUARD: only clear the slot if it's still ours (a remount may have
            // already published a new controller — don't null the live one).
            if (controllerRef.current) clearLiveController(PPTX_CONTROLLER, controllerRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [renderToken, seq]);

    return React.createElement("div", {
        key: seq,
        ref: containerRef,
        className: "dockview-pptx-container",
        // Focusable so a click into the body gives the panel keyboard focus, matching
        // the other interactive viewers (pdf/3D) — slide nav keys are gated on it.
        tabIndex: 0
    });
}
