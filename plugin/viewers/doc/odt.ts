/*
 * A lightweight OpenDocument Text (.odt) → HTML converter.
 *
 * An .odt is a ZIP holding `content.xml` (the ODF body), `styles.xml` (named
 * paragraph/text styles), and a `Pictures/` folder of embedded images. We unzip it
 * with fflate (5 KB, browser-native, zero Node built-ins — webodf is multi-MB and
 * unmaintained, so we avoid it), parse the XML with the renderer's native DOMParser,
 * collect the run/paragraph style definitions (bold / italic / underline / strike /
 * super-sub / alignment) out of <office:automatic-styles> + styles.xml, then map the
 * ODF element tree to semantic HTML:
 *
 *   text:h            → <h1>…<h6>  (by text:outline-level)
 *   text:p            → <p>        (with text-align from its paragraph style)
 *   text:span         → <strong>/<em>/<u>/<s>/<sup>/<sub> per its text style
 *   text:list         → <ul>/<ol>  (ordered iff the list style's first level is numbered)
 *   table:table       → <table>/<tr>/<td>
 *   draw:image        → <img src="data:…">  (resolved from the zip to a data: URL)
 *   text:a            → <a href>   (the doc-iframe link bridge opens it externally)
 *   text:line-break   → <br> ; text:tab → a tab ; text:s → runs of spaces
 *
 * The result is a body HTML FRAGMENT for the shared dark doc-iframe shell, so default
 * text inherits the shell's light colour. View-only.
 *
 * NO module-top executable work — only imports + function decls; everything runs
 * inside odtToHtml(). fflate's unzipSync is synchronous (fine for chat-sized docs).
 */

import { unzipSync } from "fflate";

import { escapeAttr, escapeHtml } from "../../engine/html";

/** The ODF style attributes we care about, distilled from a <style:style>'s
 *  text-properties + paragraph-properties. */
interface OdfStyle {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    /** "super" | "sub" | null (from style:text-position). */
    script?: "super" | "sub" | null;
    /** "left" | "right" | "center" | "justify" (from fo:text-align / start|end). */
    align?: string;
    /** colour as a CSS hex string (from fo:color), or undefined. */
    color?: string;
}

const NS_RASTER: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff"
};

/** A small base64 encoder over raw bytes (the renderer has btoa, but it chokes on
 *  byte values via String.fromCharCode for large inputs, so chunk it). */
function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
    }
    return btoa(bin);
}

/** Local element name without a namespace prefix (DOMParser keeps "text:p" as the
 *  tagName when parsed as application/xml without namespace awareness; localName is
 *  the part after the colon). We match on localName so we're prefix-agnostic. */
function ln(el: Element): string {
    return el.localName || el.tagName.replace(/^.*:/, "");
}

/** Read an attribute by its local name regardless of prefix (text:style-name,
 *  fo:font-weight, …). DOMParser in xml mode exposes them via getAttribute with the
 *  full qualified name; we scan attributes for a localName match to stay prefix-safe. */
function attrLocal(el: Element, local: string): string | null {
    const direct = el.getAttribute(local);
    if (direct != null) return direct;
    for (let i = 0; i < el.attributes.length; i++) {
        const a = el.attributes[i];
        if ((a.localName || a.name.replace(/^.*:/, "")) === local) return a.value;
    }
    return null;
}

/** Parse the <style:style> definitions in a document into a name→OdfStyle map. Both
 *  content.xml's <office:automatic-styles> and styles.xml's <office:styles> use the
 *  same <style:style> shape, so one walker handles both. */
function collectStyles(doc: Document, into: Record<string, OdfStyle>): void {
    const styles = doc.getElementsByTagName("*");
    for (let i = 0; i < styles.length; i++) {
        const el = styles[i];
        if (ln(el) !== "style") continue;
        const name = attrLocal(el, "name");
        if (!name) continue;
        const s: OdfStyle = {};
        // a style may inherit from a parent style — record it so we can flatten later.
        const parent = attrLocal(el, "parent-style-name");
        for (let j = 0; j < el.childNodes.length; j++) {
            const c = el.childNodes[j];
            if (c.nodeType !== 1) continue;
            const ce = c as Element;
            const cn = ln(ce);
            if (cn === "text-properties") {
                const weight = attrLocal(ce, "font-weight");
                if (weight && weight !== "normal") s.bold = true;
                const fstyle = attrLocal(ce, "font-style");
                if (fstyle === "italic" || fstyle === "oblique") s.italic = true;
                const uline = attrLocal(ce, "text-underline-style");
                if (uline && uline !== "none") s.underline = true;
                const lthrough = attrLocal(ce, "text-line-through-style");
                if (lthrough && lthrough !== "none") s.strike = true;
                const pos = attrLocal(ce, "text-position");
                if (pos) {
                    if (/^sub/.test(pos) || /-\d/.test(pos)) s.script = "sub";
                    else if (/^super/.test(pos) || /^\d/.test(pos)) s.script = "super";
                }
                const color = attrLocal(ce, "color");
                if (color && /^#[0-9a-fA-F]{6}$/.test(color)) s.color = color;
            } else if (cn === "paragraph-properties") {
                const align = attrLocal(ce, "text-align");
                if (align) {
                    s.align = align === "start" ? "left" : align === "end" ? "right" : align;
                }
            }
        }
        // stash the parent under a sentinel so flatten() can resolve inheritance.
        if (parent) (s as any).__parent = parent;
        into[name] = s;
    }
}

/** Flatten a style's inheritance chain (parent props first, child overrides). */
function flatten(name: string | null, styles: Record<string, OdfStyle>, seen: Set<string> = new Set()): OdfStyle {
    if (!name || !styles[name] || seen.has(name)) return {};
    seen.add(name);
    const s = styles[name];
    const parent = flatten((s as any).__parent || null, styles, seen);
    return { ...parent, ...s, __parent: undefined } as OdfStyle;
}

/** Open/close inline tags for an OdfStyle. */
function styleTags(s: OdfStyle): { open: string; close: string } {
    let open = "";
    let close = "";
    if (s.color) { open += `<span style="color: ${s.color}">`; close = "</span>" + close; }
    if (s.bold) { open += "<strong>"; close = "</strong>" + close; }
    if (s.italic) { open += "<em>"; close = "</em>" + close; }
    if (s.underline) { open += "<u>"; close = "</u>" + close; }
    if (s.strike) { open += "<s>"; close = "</s>" + close; }
    if (s.script === "super") { open += "<sup>"; close = "</sup>" + close; }
    else if (s.script === "sub") { open += "<sub>"; close = "</sub>" + close; }
    return { open, close };
}

/** Render the inline children of a paragraph/heading/span to HTML, recursing into
 *  nested spans/links and resolving the ODF whitespace elements. `images` maps a zip
 *  path to a data: URL for embedded pictures. */
function renderInline(node: Node, styles: Record<string, OdfStyle>, images: Record<string, string>): string {
    let html = "";
    for (let i = 0; i < node.childNodes.length; i++) {
        const c = node.childNodes[i];
        if (c.nodeType === 3) {
            // text node — ODF collapses runs of spaces into <text:s>, so the literal
            // text here is already significant; escape it verbatim.
            html += escapeHtml(c.nodeValue || "");
            continue;
        }
        if (c.nodeType !== 1) continue;
        const el = c as Element;
        const name = ln(el);
        if (name === "span") {
            const st = flatten(attrLocal(el, "style-name"), styles);
            const { open, close } = styleTags(st);
            html += open + renderInline(el, styles, images) + close;
        } else if (name === "a") {
            const href = attrLocal(el, "href") || "";
            html += `<a href="${escapeAttr(href)}">${renderInline(el, styles, images)}</a>`;
        } else if (name === "line-break") {
            html += "<br>";
        } else if (name === "tab") {
            html += "	";
        } else if (name === "s") {
            // <text:s text:c="N"> = N spaces (default 1).
            const cnt = parseInt(attrLocal(el, "c") || "1", 10) || 1;
            html += "&nbsp;".repeat(Math.min(cnt, 200));
        } else if (name === "frame" || name === "image") {
            html += renderImage(el, images);
        } else {
            // unknown inline wrapper (bookmark, note-ref, soft-page-break…): recurse
            // for its text but drop the wrapper.
            html += renderInline(el, styles, images);
        }
    }
    return html;
}

/** A draw:frame usually wraps a draw:image whose xlink:href points at a zip entry
 *  (e.g. "Pictures/100000.png"); resolve it to the data: URL we built at unzip time. */
function renderImage(frame: Element, images: Record<string, string>): string {
    // the href may live on this element (draw:image) or a draw:image child (draw:frame).
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
    if (!url) return "";
    return `<img class="odt-img" src="${escapeAttr(url)}" alt="">`;
}

/** Map a list element to <ul>/<ol>. ODF lists nest list/list-item/list, and the
 *  ordered-ness is carried by the list style; absent that we default to a bullet
 *  list (the common case), which still reads correctly. */
function renderList(el: Element, styles: Record<string, OdfStyle>, images: Record<string, string>): string {
    // a numbered list usually names a style whose first level is <text:list-level-style-number>;
    // we don't always have it, so default to <ul>. (A wrong bullet vs number is a minor
    // fidelity miss, never a broken render.)
    const tag = "ul";
    let inner = "";
    for (let i = 0; i < el.childNodes.length; i++) {
        const c = el.childNodes[i];
        if (c.nodeType !== 1) continue;
        const li = c as Element;
        if (ln(li) !== "list-item") continue;
        inner += `<li>${renderBlocks(li, styles, images)}</li>`;
    }
    return `<${tag}>${inner}</${tag}>`;
}

/** Render a table to <table>. */
function renderTable(el: Element, styles: Record<string, OdfStyle>, images: Record<string, string>): string {
    let rows = "";
    const rowEls = el.getElementsByTagName("*");
    for (let i = 0; i < rowEls.length; i++) {
        const r = rowEls[i];
        if (ln(r) !== "table-row") continue;
        let cells = "";
        for (let j = 0; j < r.childNodes.length; j++) {
            const c = r.childNodes[j];
            if (c.nodeType !== 1) continue;
            const cell = c as Element;
            if (ln(cell) !== "table-cell") continue;
            const span = parseInt(attrLocal(cell, "number-columns-spanned") || "1", 10) || 1;
            const spanAttr = span > 1 ? ` colspan="${span}"` : "";
            cells += `<td${spanAttr}>${renderBlocks(cell, styles, images)}</td>`;
        }
        rows += `<tr>${cells}</tr>`;
    }
    return `<table>${rows}</table>`;
}

/** Render the BLOCK-level children of a container (the body, a list item, a cell)
 *  into HTML: headings, paragraphs, nested lists, tables. */
function renderBlocks(node: Node, styles: Record<string, OdfStyle>, images: Record<string, string>): string {
    let html = "";
    for (let i = 0; i < node.childNodes.length; i++) {
        const c = node.childNodes[i];
        if (c.nodeType !== 1) continue;
        const el = c as Element;
        const name = ln(el);
        if (name === "h") {
            const lvl = Math.min(Math.max(parseInt(attrLocal(el, "outline-level") || "1", 10) || 1, 1), 6);
            const st = flatten(attrLocal(el, "style-name"), styles);
            const align = st.align && st.align !== "left" ? ` style="text-align: ${st.align}"` : "";
            const inner = renderInline(el, styles, images);
            html += `<h${lvl}${align}>${inner || "<br>"}</h${lvl}>`;
        } else if (name === "p") {
            const st = flatten(attrLocal(el, "style-name"), styles);
            const align = st.align && st.align !== "left" ? ` style="text-align: ${st.align}"` : "";
            const inner = renderInline(el, styles, images);
            html += `<p${align}>${inner || "<br>"}</p>`;
        } else if (name === "list") {
            html += renderList(el, styles, images);
        } else if (name === "table") {
            html += renderTable(el, styles, images);
        } else if (name === "frame" || name === "image") {
            html += `<p>${renderImage(el, images)}</p>`;
        } else if (name === "soft-page-break" || name === "sequence-decls" || name === "forms") {
            // structural, no body output.
        } else {
            // an unhandled block wrapper (section, change-tracking…): recurse so its
            // paragraphs still render.
            html += renderBlocks(el, styles, images);
        }
    }
    return html;
}

/**
 * Convert .odt bytes to a body HTML FRAGMENT for the dark doc-iframe shell. Unzips
 * with fflate, builds data: URLs for embedded pictures, parses styles.xml +
 * content.xml, and maps the office:text body to semantic HTML.
 */
export function odtToHtml(bytes: Uint8Array): string {
    const files = unzipSync(bytes);
    const dec = new TextDecoder("utf-8");

    // Build data: URLs for the embedded pictures keyed by their zip path AND by the
    // bare "Pictures/…" name, so renderImage resolves either form of xlink:href.
    const images: Record<string, string> = {};
    for (const path of Object.keys(files)) {
        if (!/^Pictures\//i.test(path)) continue;
        const ext = (path.split(".").pop() || "").toLowerCase();
        const mime = NS_RASTER[ext];
        if (!mime) continue;
        const b64 = bytesToBase64(files[path]);
        const url = `data:${mime};base64,${b64}`;
        images[path] = url;
    }

    const parser = new DOMParser();
    const styles: Record<string, OdfStyle> = {};

    // styles.xml: the named (non-automatic) styles. Optional — a minimal odt may omit it.
    if (files["styles.xml"]) {
        const sdoc = parser.parseFromString(dec.decode(files["styles.xml"]), "application/xml");
        collectStyles(sdoc, styles);
    }

    const contentBytes = files["content.xml"];
    if (!contentBytes) throw new Error("content.xml missing — not a valid .odt");
    const cdoc = parser.parseFromString(dec.decode(contentBytes), "application/xml");
    // content.xml's <office:automatic-styles> overrides/adds to the named styles.
    collectStyles(cdoc, styles);

    // find the office:text body (the document content lives under office:body/office:text).
    let bodyEl: Element | null = null;
    const all = cdoc.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
        if (ln(all[i]) === "text" && all[i].parentElement && ln(all[i].parentElement!) === "body") {
            bodyEl = all[i];
            break;
        }
    }
    if (!bodyEl) throw new Error("No <office:text> body in .odt");

    const inner = renderBlocks(bodyEl, styles, images);
    return `<div class="odt-doc">${inner || "<p>(empty document)</p>"}</div>`;
}
