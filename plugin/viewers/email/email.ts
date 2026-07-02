/*
 * The .eml → HTML transform.
 *
 * Turns a postal-mime-parsed Email into ONE body-HTML fragment for the shared dark
 * doc iframe: a header card (Subject / From / To / Cc / Date) + the message body (the
 * sender's HTML, sanitised, or the plaintext fallback) + an attachment list.
 *
 * SECURITY — this fragment renders inside the doc viewer's null-origin
 * `sandbox="allow-scripts"` iframe (no allow-same-origin), so a script in a hostile
 * email can't reach the host DOM. But the sandbox does NOT block network image loads,
 * and an email's <img src="http://tracker/…"> is a classic tracking pixel, so we
 * NEUTRALISE remote content here before it ever reaches the iframe:
 *   - every <img> with a remote (http/https/protocol-relative) src is stripped of its
 *     src and replaced with a "remote image blocked" pill (no request is ever made);
 *   - <script>/<iframe>/<object>/<embed>/<link rel=stylesheet>/<style> and inline
 *     event handlers are removed (the body is inert content, not an app);
 *   - cid: images (inline attachments) and data: images are KEPT — they carry no
 *     network request. We rewrite cid: refs to the matching inline attachment's data:
 *     URL so legitimately-inlined images still show.
 * The sanitiser walks a detached DOMParser document (never attached to the live DOM),
 * so nothing in the email executes or fetches during parsing either.
 *
 * NO module-top executable work — only imports + function decls. Called from load().
 */

import { escapeAttr, escapeHtml } from "../../engine/html";

/** The subset of postal-mime's Email we read. Kept structural so this module never
 *  imports postal-mime's types (the loader passes the parsed object straight in). */
interface ParsedAddress {
    name?: string;
    address?: string;
    group?: ParsedAddress[];
}
interface ParsedAttachment {
    filename?: string | null;
    mimeType?: string;
    disposition?: string | null;
    contentId?: string;
    content?: ArrayBuffer | Uint8Array | string;
    encoding?: string;
}
export interface ParsedEmail {
    subject?: string;
    from?: ParsedAddress;
    to?: ParsedAddress[];
    cc?: ParsedAddress[];
    date?: string;
    html?: string;
    text?: string;
    attachments?: ParsedAttachment[];
}

/** Render one address as "Name <email>" (or just the email / name when only one is
 *  present), HTML-escaped, with the email greyed via a span. A group expands to its
 *  members. */
function renderAddress(a: ParsedAddress): string {
    if (a.group && a.group.length) {
        return (a.name ? escapeHtml(a.name) + ": " : "") +
            a.group.map(renderAddress).join(", ");
    }
    const name = a.name ? a.name.trim() : "";
    const email = a.address ? a.address.trim() : "";
    if (name && email) {
        return `<span class="dv-eml-addr">${escapeHtml(name)}</span> ` +
            `<span class="dv-eml-email">&lt;${escapeHtml(email)}&gt;</span>`;
    }
    if (email) return `<span class="dv-eml-email">${escapeHtml(email)}</span>`;
    return `<span class="dv-eml-addr">${escapeHtml(name)}</span>`;
}

/** Render a list of addresses (To/Cc) into one comma-joined HTML string, or "" when
 *  the list is empty/absent. */
function renderAddressList(list: ParsedAttachment[] | ParsedAddress[] | undefined): string {
    if (!list || !list.length) return "";
    return (list as ParsedAddress[]).map(renderAddress).join(", ");
}

/** Format the message date in the viewer's locale, falling back to the raw string when
 *  it isn't a parseable date. */
function renderDate(raw: string | undefined): string {
    if (!raw) return "";
    const d = new Date(raw);
    if (isNaN(d.getTime())) return escapeHtml(raw);
    try {
        return escapeHtml(d.toLocaleString(undefined, {
            year: "numeric", month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit"
        }));
    } catch {
        return escapeHtml(raw);
    }
}

/** A human byte size ("12.3 KB"). */
function humanSize(bytes: number): string {
    if (!bytes || bytes < 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let n = bytes, u = 0;
    while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
    return `${u === 0 ? n : n.toFixed(1)} ${units[u]}`;
}

/** Byte length of an attachment's decoded content (best-effort; a base64/utf8 string
 *  counts its character length, an ArrayBuffer/Uint8Array its byteLength). */
function attachmentSize(att: ParsedAttachment): number {
    const c = att.content;
    if (!c) return 0;
    if (typeof c === "string") return c.length;
    if (c instanceof ArrayBuffer) return c.byteLength;
    if ((c as Uint8Array).byteLength != null) return (c as Uint8Array).byteLength;
    return 0;
}

/** Build a `data:` URL for an INLINE image attachment (cid: reference), so a
 *  legitimately-embedded image renders with no network request. Returns null when the
 *  content can't be turned into a data URL. */
function inlineDataUrl(att: ParsedAttachment): string | null {
    const c = att.content;
    if (c == null) return null;
    const mime = att.mimeType || "application/octet-stream";
    try {
        if (typeof c === "string") {
            // postal-mime hands base64 (its default) or utf8; treat the common base64.
            if (att.encoding === "utf8") {
                return `data:${mime};utf8,${encodeURIComponent(c)}`;
            }
            return `data:${mime};base64,${c}`;
        }
        const bytes = c instanceof ArrayBuffer ? new Uint8Array(c) : (c as Uint8Array);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return `data:${mime};base64,${btoa(bin)}`;
    } catch {
        return null;
    }
}

/** Map of `cid:` content-id → inline data URL, built from the email's inline image
 *  attachments so the body sanitiser can rewrite <img src="cid:…"> to a safe data URL. */
function buildCidMap(attachments: ParsedAttachment[] | undefined): Map<string, string> {
    const map = new Map<string, string>();
    if (!attachments) return map;
    for (const att of attachments) {
        if (!att.contentId) continue;
        if (!(att.mimeType || "").startsWith("image/")) continue;
        const url = inlineDataUrl(att);
        if (!url) continue;
        // contentId may be wrapped in <…>; the body references it as cid:<id-without-brackets>.
        const id = att.contentId.replace(/^<|>$/g, "");
        map.set(id, url);
    }
    return map;
}

/**
 * Sanitise the sender's HTML body for the null-origin sandbox: remove active/network
 * elements, neutralise remote images (replace with a "blocked" pill), keep cid:/data:
 * images (cid: rewritten to the inline data URL). Walks a DETACHED DOMParser document
 * so nothing executes or fetches; returns the cleaned innerHTML.
 *
 * `allowRemote` (the Privacy page's "load remote images" switch, threaded down by the
 * loader) leaves remote <img>/CSS background-image intact instead of blocking them, so a
 * user who opts in sees the sender's remote images — at the cost of the sender learning
 * the message was opened. Scripts/iframes/handlers are ALWAYS stripped regardless.
 */
function sanitizeHtmlBody(html: string, cidMap: Map<string, string>, allowRemote: boolean): string {
    let doc: Document;
    try {
        doc = new DOMParser().parseFromString(html, "text/html");
    } catch {
        // Parser unavailable / threw — fall back to escaping the raw HTML as text.
        return `<div class="dv-eml-body-text">${escapeHtml(html)}</div>`;
    }
    const root = doc.body || doc.documentElement;
    if (!root) return "";

    // Drop elements that execute, fetch, or restyle the page.
    root.querySelectorAll("script, iframe, object, embed, link, style, base, meta, form")
        .forEach(el => el.remove());

    // Strip inline event handlers + javascript: URLs on every remaining element.
    root.querySelectorAll("*").forEach(el => {
        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith("on")) { el.removeAttribute(attr.name); continue; }
            if ((name === "href" || name === "src" || name === "xlink:href") &&
                /^\s*javascript:/i.test(attr.value)) {
                el.removeAttribute(attr.name);
            }
        }
    });

    // Neutralise images: cid: → inline data URL (safe), data: kept, remote → blocked pill
    // (or kept when the user opted into remote images).
    root.querySelectorAll("img").forEach(img => {
        const src = (img.getAttribute("src") || "").trim();
        if (/^cid:/i.test(src)) {
            const id = src.slice(4).replace(/^<|>$/g, "");
            const data = cidMap.get(id);
            if (data) { img.setAttribute("src", data); return; }
            replaceWithBlockedPill(doc, img, "inline image missing");
            return;
        }
        if (/^data:/i.test(src)) return; // inline data image — no network, keep it
        if (!src) { img.remove(); return; }
        // anything else (http/https/protocol-relative/relative) is a remote fetch.
        if (allowRemote) return; // user opted in — leave the remote <img> to load
        replaceWithBlockedPill(doc, img, "remote image blocked");
    });

    // Also strip CSS background-image: url(remote) in inline styles (another fetch
    // vector) — unless the user opted into remote images.
    if (!allowRemote) {
        root.querySelectorAll<HTMLElement>("[style]").forEach(el => {
            const style = el.getAttribute("style") || "";
            if (/url\(\s*['"]?\s*(?:https?:)?\/\//i.test(style)) {
                el.setAttribute("style", style.replace(/background(-image)?\s*:[^;]*url\([^)]*\)[^;]*;?/gi, ""));
            }
        });
    }

    return root.innerHTML;
}

/** Swap a blocked <img> for a small inline "blocked" pill carrying its alt text. */
function replaceWithBlockedPill(doc: Document, img: Element, label: string): void {
    const pill = doc.createElement("span");
    pill.className = "dv-eml-blocked";
    const alt = (img.getAttribute("alt") || "").trim();
    pill.textContent = alt ? `${label}: ${alt}` : label;
    img.replaceWith(pill);
}

/** Build the message-body section: the sanitised HTML body if present, else the
 *  plaintext body in a pre-wrapped block, else an empty-state line. */
function renderBody(email: ParsedEmail, cidMap: Map<string, string>, allowRemote: boolean): string {
    if (email.html && email.html.trim()) {
        return `<div class="dv-eml-body">${sanitizeHtmlBody(email.html, cidMap, allowRemote)}</div>`;
    }
    if (email.text && email.text.trim()) {
        return `<div class="dv-eml-body dv-eml-body-text">${escapeHtml(email.text)}</div>`;
    }
    return `<div class="dv-eml-body dv-eml-empty">This message has no body.</div>`;
}

/** Build the attachment list (real attachments only — inline cid: images that were
 *  shown in the body are still listed, which matches how mail clients show them). */
function renderAttachments(attachments: ParsedAttachment[] | undefined): string {
    if (!attachments || !attachments.length) return "";
    const items = attachments.map(att => {
        const name = (att.filename || "(unnamed attachment)").trim() || "(unnamed attachment)";
        const size = humanSize(attachmentSize(att));
        return `<li class="dv-eml-att-item">` +
            `<span class="dv-eml-att-icon">📎</span>` +
            `<span class="dv-eml-att-name" title="${escapeAttr(name)}">${escapeHtml(name)}</span>` +
            (size ? `<span class="dv-eml-att-size">${escapeHtml(size)}</span>` : "") +
            `</li>`;
    }).join("");
    const label = attachments.length === 1 ? "1 attachment" : `${attachments.length} attachments`;
    return `<div class="dv-eml-att">` +
        `<div class="dv-eml-att-title">${escapeHtml(label)}</div>` +
        `<ul class="dv-eml-att-list">${items}</ul></div>`;
}

/** One header row ("Label: value") — emitted only when the value is non-empty. */
function row(label: string, valueHtml: string): string {
    if (!valueHtml) return "";
    return `<div class="dv-eml-row">` +
        `<span class="dv-eml-label">${escapeHtml(label)}</span>` +
        `<span class="dv-eml-val">${valueHtml}</span></div>`;
}

/**
 * Build the full body-HTML fragment for an .eml: the header card, the (sanitised)
 * message body, and the attachment list. Wrapped by the loader in the shared dark doc
 * shell. `allowRemote` (the Privacy page's "load remote images" switch, read live by the
 * loader and passed in) decides whether remote <img> load or are replaced with a blocked
 * pill — the loader keeps the setting read out of this pure transform.
 */
export function emailToHtml(email: ParsedEmail, allowRemote = false): string {
    const cidMap = buildCidMap(email.attachments);
    const subject = email.subject && email.subject.trim()
        ? escapeHtml(email.subject)
        : "<span class=\"dv-eml-empty\">(no subject)</span>";

    const head =
        `<div class="dv-eml-head">` +
        `<div class="dv-eml-subject">${subject}</div>` +
        (email.from ? row("From", renderAddress(email.from)) : "") +
        row("To", renderAddressList(email.to)) +
        row("Cc", renderAddressList(email.cc)) +
        row("Date", renderDate(email.date)) +
        `</div>`;

    return head + renderBody(email, cidMap, allowRemote) + renderAttachments(email.attachments);
}
