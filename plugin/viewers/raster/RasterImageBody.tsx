/*
 * The MULTI-PAGE TIFF body — the existing inline IMAGE surface wrapped with a page
 * controller. Only mounted for a TIFF with 2+ pages (a single-image raster file retypes
 * to "image" and renders through the plain image viewer); this is the raster analogue of
 * how XlsxBody wraps the csv grid with a sheet switcher.
 *
 * The pixels are rendered by the very same ImageBody the image viewer uses (fit / wheel-
 * zoom / drag-pan / fullscreen lightbox / rotate) — content.url holds the CURRENT page's
 * decoded blob, so ImageBody just shows it. This wrapper adds nothing visual of its own;
 * it publishes a "raster" live controller (prev / next / goToPage) that the header's page
 * nav + the keyboard drive. Switching a page re-blobs the chosen IFD from the TIFF bytes
 * cached on the entry (blobForTiffPage — no re-fetch), re-points content.url, resets the
 * zoom to fit, and parks the new page in the view-state (persisted on the cache entry).
 *
 * The page nav lives in the header (RasterHeaderControls), like the PDF/pptx page nav —
 * the body owns the controller + the keyboard, the header owns the chrome.
 *
 * No module-top React.createElement / no module-top webpack access — the element tree is
 * built inside the component; the active window is read at call time.
 */

import { React } from "@vencord/types/webpack/common";

import { dockHasFocus, isTextEntryFocused } from "../../engine/dockKeyboard";
import { getActiveCacheEntry, getWindowCacheState } from "../../engine/cache";
import { clearLiveController, getLiveController, requestRender, setLiveController } from "../../engine/forceRender";
import { dvFetch } from "../../engine/fetch";
import { getActiveWindow } from "../../engine/window";
import type { DockWindow, RasterViewState, ViewerContext } from "../../engine/types";
import { ImageBody, resetImgView } from "../image/ImageBody";
import { blobForTiffPage } from "./RasterImageViewer";

// The live-controller slot name + the per-window view-state key.
export const RASTER_CONTROLLER = "rasterimage";

/** The window's raster view-state slice (current page + total), created on demand.
 *  Mirrors the other viewers' init-order back-fill: the very first window can be built
 *  before this viewer registers, so it may lack the slice. */
export function rasterState(win: DockWindow = getActiveWindow()): RasterViewState {
    let vs = win.viewStates[RASTER_CONTROLLER] as RasterViewState | undefined;
    if (!vs) {
        vs = { page: 1, total: 1 };
        win.viewStates[RASTER_CONTROLLER] = vs;
    }
    return vs;
}

/** Reset the raster view to its fresh-open default (page 1, single page until counted). */
export function resetRasterView(win: DockWindow = getActiveWindow()): void {
    const vs = rasterState(win);
    vs.page = 1;
    vs.total = 1;
}

/** The live raster controller, driven by the header page nav + the keyboard. */
export interface RasterController {
    goToPage: (n: number) => void; // 1-based
    prevPage: () => void;
    nextPage: () => void;
}

/** Read the live raster controller (header / keyboard reach for it). */
export function rasterController(): RasterController | null {
    return getLiveController<RasterController>(RASTER_CONTROLLER);
}

/** A minimal ViewerContext for the page-switch re-blob (it only needs window/content +
 *  the real fetch path, though blobForTiffPage re-decodes from the cached bytes and
 *  never actually fetches). requestRender repaints the host. */
function pageCtx(win: DockWindow): ViewerContext {
    return { window: win, content: win.content, requestRender, fetch: dvFetch };
}

/** Switch to a 1-based page: re-blob the chosen IFD (cached per page on the entry),
 *  re-point content.url, reset zoom to fit, park the page, and repaint. A no-op when
 *  already on that page or out of range. */
function goToPage(n: number): void {
    const win = getActiveWindow();
    if (win.content.type !== "rasterimage") return;
    const vs = rasterState(win);
    const total = vs.total || 1;
    const target = Math.min(Math.max(1, n), total);
    if (target === vs.page) return;
    const entry = getActiveCacheEntry(win) ?? null;
    if (!entry || !entry.rasterTiff) return;
    blobForTiffPage(entry, pageCtx(win), target - 1)
        .then(url => {
            // Guard against a file switch mid-decode: only apply if still this TIFF.
            const w = getActiveWindow();
            if (w.content.type !== "rasterimage" || w.activeCacheEntry !== entry) return;
            const e = w.activeCacheEntry;
            if (!e) return;
            const v = rasterState(w);
            const state = getWindowCacheState(w, e.key)!;
            v.page = target;
            state.renderUrl = url;
            w.content.url = url;
            resetImgView(w); // a fresh page opens at fit (a new picture, like switching files)
            w.content.seq += 1; // remount the <img> so it re-derives natW/natH for the new page
            requestRender();
        })
        .catch(() => { /* a page decode failure leaves the current page shown */ });
}

/** The multi-page TIFF body: render the image surface (ImageBody reads content.url) and
 *  publish the page controller + bind the page-nav keyboard. */
export function RasterImageBody() {
    const { useEffect } = React;
    const win = getActiveWindow();
    const seq = win.content.seq;

    // Publish / clear the live controller so the header page nav + the keyboard can drive
    // page selection. Keyed on the file identity (the cache key) so a new TIFF re-publishes
    // a controller bound to the right window.
    useEffect(() => {
        const ctrl: RasterController = {
            goToPage: (n: number) => goToPage(n),
            prevPage: () => goToPage((rasterState().page || 1) - 1),
            nextPage: () => goToPage((rasterState().page || 1) + 1)
        };
        setLiveController(RASTER_CONTROLLER, ctrl);

        // ←/→ (and PageUp/PageDown) step pages through the SAME controller verbs the
        // prev/next chevrons drive, behind the shared dock-focus gate. Skipped while a
        // text field is focused (the page-jump input). Mirrors the pdf/pptx pattern.
        // NOTE: ImageBody also binds ←/→ for channel-image gallery stepping, but the
        // raster surface opts OUT of the gallery (no gallery capability), so its gallery
        // step is inert here and these page keys are the live ←/→ behaviour.
        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.altKey || e.metaKey) return;
            if (!dockHasFocus() || isTextEntryFocused()) return;
            if (e.key === "ArrowLeft" || e.key === "PageUp") {
                e.preventDefault(); ctrl.prevPage();
            } else if (e.key === "ArrowRight" || e.key === "PageDown") {
                e.preventDefault(); ctrl.nextPage();
            }
        };
        window.addEventListener("keydown", onKey, true);

        return () => {
            window.removeEventListener("keydown", onKey, true);
            // UNMOUNT GUARD: only clear the slot if it's still ours.
            clearLiveController(RASTER_CONTROLLER, ctrl);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [win.activeCacheKey]);

    // The pixels: the SAME ImageBody the image viewer uses, keyed on seq so a page switch
    // (which bumps seq) remounts it fresh against the new page's blob url.
    return React.createElement(ImageBody, { key: seq });
}
