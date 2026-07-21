/*
 * A lightweight OpenDocument Presentation (.odp) → HTML converter.
 *
 * An .odp is the SAME ODF package shape as an .odt — a ZIP holding `content.xml`,
 * `styles.xml` and a `Pictures/` folder — just with a PRESENTATION body instead of a
 * text body. So this reuses the proven ODF→HTML core from odt.ts (style collection,
 * the inline/block renderers, embedded-picture resolution) rather than a heavy, abandoned
 * library: WebODF is unmaintained and its npm package is an empty stub (no code), and a
 * full slide-geometry renderer is overkill for a legible PREVIEW. The bar is a readable
 * slide outline, which the ODF block renderer already produces.
 *
 * The content tree is:
 *   office:body / office:presentation
 *     draw:page                       → one SLIDE  (we render each as a card)
 *       draw:frame / draw:text-box     → a text placeholder (title / body / bullets)
 *         text:p / text:list / table   → the very blocks odt.ts already maps to HTML
 *       draw:frame / draw:image        → an embedded picture (resolved to a data: URL)
 *
 * For each draw:page we walk its frames in document order and render the text-boxes'
 * blocks (headings/paragraphs/lists/tables) + any framed images through the shared ODF
 * renderers, wrapping the slide in a numbered card. The result is a body HTML FRAGMENT for
 * the shared dark doc-iframe shell (the same shell odt/docx/rtf use). View-only.
 *
 * Quality note: this is a flowed-outline render, NOT a pixel-faithful slide layout (no
 * absolute frame positioning, master-slide graphics, or theme colours). That is the
 * accepted bar for a preview — legible slide content beats a blank download gap.
 *
 * NO module-top executable work — only imports + function decls; everything runs inside
 * odpToHtml(). fflate's unzipSync is synchronous (fine for chat-sized decks).
 */

import { unzipSync } from "fflate";

import { escapeAttr, escapeHtml } from "../../engine/html";
import {
    buildOdfImageMap, collectStyles, ln, type OdfStyle, renderBlocks
} from "./odt";

/** Read an attribute by local name regardless of prefix (draw:master-page-name, …).
 *  DOMParser in xml mode keeps the qualified name, so scan for a localName match. */
function attrLocal(el: Element, local: string): string | null {
    const direct = el.getAttribute(local);
    if (direct != null) return direct;
    for (let i = 0; i < el.attributes.length; i++) {
        const a = el.attributes[i];
        if ((a.localName || a.name.replace(/^.*:/, "")) === local) return a.value;
    }
    return null;
}

/** Resolve a draw:image/draw:frame's xlink:href to the data: URL built at unzip time. */
function frameImage(frame: Element, images: Record<string, string>): string {
    let href = attrLocal(frame, "href");
    if (!href) {
        const imgs = frame.getElementsByTagName("*");
        for (let i = 0; i < imgs.length; i++) {
            if (ln(imgs[i]) === "image") { href = attrLocal(imgs[i], "href"); break; }
        }
    }
    if (!href) return "";
    const path = href.replace(/^\.\//, "");
    const url = images[path] || images[path.replace(/^Pictures\//, "")] || "";
    return url ? `<img class="odp-img" src="${escapeAttr(url)}" alt="">` : "";
}

/** Render ONE draw:page (slide) to the inner HTML of a slide card. Walks the page's
 *  frames in order: a text-box's blocks go through the shared ODF block renderer; an
 *  image frame resolves to an <img>. Empty/structural frames contribute nothing. */
function renderSlide(page: Element, styles: Record<string, OdfStyle>, images: Record<string, string>): string {
    let html = "";
    const kids = page.getElementsByTagName("*");
    for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        if (ln(el) !== "frame") continue;
        // a frame holds either a text-box (text content) or an image.
        let handled = false;
        for (let j = 0; j < el.childNodes.length; j++) {
            const c = el.childNodes[j];
            if (c.nodeType !== 1) continue;
            const ce = c as Element;
            const cn = ln(ce);
            if (cn === "text-box") {
                const inner = renderBlocks(ce, styles, images);
                if (inner) html += `<div class="odp-box">${inner}</div>`;
                handled = true;
            } else if (cn === "image") {
                const img = frameImage(el, images);
                if (img) html += `<div class="odp-box">${img}</div>`;
                handled = true;
            }
        }
        // a frame that directly carries an href (some producers) and no child we handled.
        if (!handled) {
            const img = frameImage(el, images);
            if (img) html += `<div class="odp-box">${img}</div>`;
        }
    }
    return html;
}

/**
 * Convert .odp bytes to a body HTML FRAGMENT for the dark doc-iframe shell. Unzips with
 * fflate, resolves embedded pictures to data: URLs, collects ODF styles, then renders
 * each draw:page as a numbered slide card. Throws on a malformed package (no content.xml
 * or no presentation body) so the dock shows an honest error rather than a blank frame.
 */
export function odpToHtml(bytes: Uint8Array): string {
    const files = unzipSync(bytes);
    const dec = new TextDecoder("utf-8");

    const images = buildOdfImageMap(files);

    const parser = new DOMParser();
    const styles: Record<string, OdfStyle> = {};

    // styles.xml: named (non-automatic) styles. Optional — a minimal odp may omit it.
    if (files["styles.xml"]) {
        const sdoc = parser.parseFromString(dec.decode(files["styles.xml"]), "application/xml");
        collectStyles(sdoc, styles);
    }

    const contentBytes = files["content.xml"];
    if (!contentBytes) throw new Error("content.xml missing — not a valid .odp");
    const cdoc = parser.parseFromString(dec.decode(contentBytes), "application/xml");
    collectStyles(cdoc, styles); // content's automatic-styles override/add to the named ones

    // find the office:presentation body.
    let presEl: Element | null = null;
    const all = cdoc.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
        if (ln(all[i]) === "presentation" && all[i].parentElement && ln(all[i].parentElement!) === "body") {
            presEl = all[i];
            break;
        }
    }
    if (!presEl) throw new Error("No <office:presentation> body in .odp");

    // each direct draw:page child is a slide.
    const slides: string[] = [];
    for (let i = 0; i < presEl.childNodes.length; i++) {
        const c = presEl.childNodes[i];
        if (c.nodeType !== 1) continue;
        const el = c as Element;
        if (ln(el) !== "page") continue;
        const n = slides.length + 1;
        const inner = renderSlide(el, styles, images);
        slides.push(
            `<section class="odp-slide">` +
            `<div class="odp-slide-num">${escapeHtml("Slide " + n)}</div>` +
            (inner || `<p class="odp-empty">${escapeHtml("(no text on this slide)")}</p>`) +
            `</section>`
        );
    }

    if (slides.length === 0) throw new Error("No slides found in .odp");
    return `<div class="odp-doc">${slides.join("")}</div>`;
}
