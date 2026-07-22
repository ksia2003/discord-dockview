/*
 * Image row-2 controls: a small metadata readout (dims · size · format) + prev/next
 * channel-image nav + the shared zoom group + reset-to-fit + rotate + a fullscreen
 * toggle.
 *
 * The prev/next pair cycles through the channel's images IN ORDER (oldest→newest),
 * like Discord's native lightbox; at a true end (no more to fetch) or while a
 * load-more is in flight the button DIMS rather than vanishing (grammar rule 9).
 * Zoom / reset / rotate / fullscreen drive the live "image" controller the ImageBody
 * publishes (so the toolbar and the keyboard share the exact same zoom/rotation math).
 *
 * The metadata span (IMG-4) is the leftmost, lowest-priority item — informational
 * text in the SAME style the code viewer uses for its detected-language label
 * (.dockview-tool-lang), not a new chrome band. It reads the natural dimensions off
 * the image view-state (filled on <img> onLoad), the byte size off a cheap one-shot
 * blob fetch (cached per url), and the format off the file name / mime. Size is
 * omitted gracefully when it can't be read.
 *
 * No module-top React.createElement — the glyph strings are plain path-data; the
 * element tree is built inside the component.
 */

import { React } from "@vencord/types/webpack/common";

import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";
import { toolBtn, zoomGroup } from "../../ui/toolbar";
import { galleryCanStep, galleryStep } from "./gallery";
import { imgController, imgState } from "./ImageBody";
// imgController is read at click time (the controller is published by the live
// ImageBody) so the toolbar shares the body's exact zoom math.

// Chevron glyphs for the prev/next image stepper (Discord-style ghost icons).
const IMG_PREV_PATH = "M15.3 18.7a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 1 1 1.4 1.4L10 12l5.3 5.3a1 1 0 0 1 0 1.4Z";
const IMG_NEXT_PATH = "M8.7 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 1 1-1.4-1.4L14 12 8.7 6.7a1 1 0 0 1 0-1.4Z";
// Reset-to-fit glyph (a refresh arrow), the rotate-clockwise glyph (shared verbatim
// with the PDF header), and the fullscreen expand glyph.
const RESET_PATH = "M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5 1 1 0 1 0-2 0 7 7 0 1 0 7-7Z";
const ROTATE_PATH = "M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z";
const FULLSCREEN_PATH = "M5 5h5a1 1 0 0 1 0 2H7v3a1 1 0 1 1-2 0V5Zm9 0h5v5a1 1 0 1 1-2 0V7h-3a1 1 0 1 1 0-2ZM6 14a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2H5v-5a1 1 0 0 1 1-1Zm12 0a1 1 0 0 1 1 1v5h-5a1 1 0 1 1 0-2h3v-3a1 1 0 0 1 1-1Z";

// --- metadata helpers --------------------------------------------------------

// Per-url byte-size cache so the blob fetch runs once per image (a re-render or a
// cache return doesn't re-fetch). null = looked up and unavailable; a number = bytes.
const sizeCache = new Map<string, number | null>();
// urls currently being measured (so concurrent renders don't double-fetch).
const sizeInflight = new Set<string>();

/** Human byte size: "812 KB", "2.3 MB", "1.0 GB". Mirrors a plain SI-ish 1024 step
 *  with one decimal place from MB up (KB stays whole). */
function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const kb = n / 1024;
    if (kb < 1024) return `${Math.round(kb)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
}

/** Derive a short format label (PNG / JPG / GIF …) from the file name extension,
 *  falling back to the blob/mime subtype. Upper-cased for the readout. */
function formatLabel(name: string | null, url: string | null): string {
    const ext = (name || url || "").split("?")[0].split("#")[0].split(".").pop() || "";
    if (ext && ext.length <= 5 && /^[a-z0-9]+$/i.test(ext)) {
        const e = ext.toLowerCase();
        return (e === "jpeg" ? "jpg" : e).toUpperCase();
    }
    return "";
}

/** Image header controls: metadata readout + prev/next nav + zoom + reset + rotate
 *  + fullscreen. */
export function ImageHeaderControls() {
    const { useEffect, useState } = React;
    const [, bump] = useState(0);
    const win = getActiveWindow();
    const iv = imgState(win);
    const idle = win.content.loading || win.content.error || !win.content.url;
    // `url` is "" while idle so the effect's hook is ALWAYS called (Rules of Hooks)
    // but no-ops until there's a real source.
    const url = win.content.url || "";

    // One-shot byte-size lookup for the current url. Blob: URLs resolve from memory
    // (cheap); a CDN url is a network fetch but cached after the first read. Failures
    // (CORS / a source that genuinely has no length) cache null so we just omit size.
    // Called unconditionally (before the idle early-return) so the hook count is stable.
    useEffect(() => {
        if (!url || sizeCache.has(url) || sizeInflight.has(url)) return;
        sizeInflight.add(url);
        fetch(url)
            .then(r => r.blob())
            .then(b => { sizeCache.set(url, b.size); })
            .catch(() => { sizeCache.set(url, null); })
            .finally(() => { sizeInflight.delete(url); bump(n => n + 1); });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url]);

    if (idle) return null;
    const pct = Math.round(iv.scale * 100);

    // Assemble the readout: dims (once the image has loaded) · size (if known) ·
    // FORMAT. Each part is omitted gracefully when unavailable, so a still-loading
    // image shows just the format, and a source with no readable size shows dims +
    // format. The whole span is hidden if there's nothing at all to say.
    const parts: string[] = [];
    if (iv.natW && iv.natH) parts.push(`${iv.natW}×${iv.natH}`);
    const size = sizeCache.get(url);
    if (typeof size === "number") parts.push(formatBytes(size));
    const fmt = formatLabel(win.content.name, url);
    if (fmt) parts.push(fmt);
    const meta = parts.join(" · ");

    return React.createElement(
        React.Fragment,
        null,
        // metadata readout (IMG-4) — informational, lowest priority (collapses first
        // at narrow width, like the code language label). Same .dockview-tool-lang
        // style; mid-dot separators between dims · size · format.
        meta
            ? React.createElement("span", {
                className: "dockview-tool-lang dockview-tool-meta dockview-collapse-low",
                title: STRINGS.image.metadata
            }, meta)
            : null,
        // prev/next image stepper — highest priority (it's the headline image
        // action), so it never collapses. Dim at a true end / while loading.
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            toolBtn("img-prev", STRINGS.image.prevImage, IMG_PREV_PATH,
                () => galleryStep(-1), false, !galleryCanStep(-1)),
            toolBtn("img-next", STRINGS.image.nextImage, IMG_NEXT_PATH,
                () => galleryStep(1), false, !galleryCanStep(1))
        ),
        zoomGroup("img", pct, () => imgController()?.zoomOut(), () => imgController()?.zoomIn()),
        React.createElement(
            "div",
            { className: "dockview-tool-group" },
            toolBtn("zoom-reset", STRINGS.zoom.reset, RESET_PATH, () => imgController()?.reset()),
            // Rotate (IMG-3): one click = 90° clockwise (0→90→180→270→0). A plain
            // action button (not a state toggle); the rotation is persisted in the
            // image view-state so a cache return reopens at the same angle.
            toolBtn("img-rotate", STRINGS.image.rotate, ROTATE_PATH, () => imgController()?.rotate()),
            // Fullscreen toggle (IMG-2): the active state reflects whether the
            // lightbox is currently open, so the button reads as a toggle.
            toolBtn("img-fullscreen",
                iv.fullscreen ? STRINGS.image.exitFullscreen : STRINGS.image.enterFullscreen,
                FULLSCREEN_PATH,
                () => imgController()?.toggleFullscreen(),
                iv.fullscreen)
        )
    );
}
