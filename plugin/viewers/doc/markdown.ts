/*
 * The markdown rendering engine — marked + KaTeX math + code highlighting.
 *
 * Shared by the markdown viewer (the whole file) and the ipynb viewer (per
 * markdown cell), so the helpers live here, not on a single viewer:
 *
 *   - markdownToHtml(md) — marked.parse with the inline/display math extension,
 *     tracking whether any real math was emitted (so the doc wrapper knows whether
 *     to pay for the heavy KaTeX CSS/font payload).
 *   - highlightMarkdownCode(html) — post-process marked's <pre><code> fences with
 *     highlight.js (the same hljs path the code viewer's highlighter uses).
 *   - renderMarkdownDoc(md) — the full md → dark sandboxed-doc pipeline.
 *
 * LAZY MATH REGISTRATION: marked.use({ extensions }) is registered the first time
 * a render runs (ensureMathExtension), NOT at module top. marked + katex are eager
 * bundled imports so a module-top call would be technically safe, but keeping it
 * inside the render path avoids any eval-order surprise during the registry↔viewer
 * import cycle and matches the lazy-init discipline the rest of the plugin follows.
 *
 * No module-top executable work: only imports, a couple of mutable flags, and
 * function decls. marked/katex are eager imports (not @webpack proxies) so they're
 * safe to import at module top — they're only CALLED inside the functions below.
 */

import { marked } from "marked";
import katex from "katex";

import { escapeHtml } from "../../engine/html";
import { getHighlighter, highlightCode } from "../text/highlighter";

// `_mdHasMath` is set by the math renderer whenever it emits real math, so the doc
// wrapper knows whether to inject the (heavy) KaTeX CSS+font payload. Reset per
// markdownToHtml() call and read straight after.
let _mdHasMath = false;

// marked.use() is registered once, lazily, on the first render (see the LAZY MATH
// REGISTRATION note above).
let _mathReady = false;

/** Render one TeX span to self-contained KaTeX HTML. `throwOnError:false` makes a
 *  bad expression degrade to the raw source text styled red instead of throwing —
 *  a single broken `$\frac{$` can't break the whole document. */
function renderMath(tex: string, displayMode: boolean): string {
    try {
        return katex.renderToString(tex, {
            displayMode,
            throwOnError: false,
            output: "html",
            // Render a parse error as the raw source (red) instead of throwing,
            // so one bad expression never takes down the rest of the doc.
            errorColor: "#f85149",
            strict: "ignore",
            trust: false
        });
    } catch {
        // Belt-and-braces: even with throwOnError:false KaTeX can throw on a
        // few pathological inputs. Fall back to the literal delimited source.
        const d = displayMode ? "$$" : "$";
        return `<code class="md-math-fallback">${escapeHtml(d + tex + d)}</code>`;
    }
}

/** Register the inline/display math extension on `marked` exactly once. Called on
 *  the first render rather than at module top (see the LAZY MATH REGISTRATION note).
 *  marked, katex and escapeHtml are plain bundled imports (NOT lazy @webpack
 *  proxies), so this is safe to defer to the first call. */
function ensureMathExtension(): void {
    if (_mathReady) return;
    _mathReady = true;
    marked.use({
        extensions: [
            {
                // Display math: $$ ... $$  (may span multiple lines). Block-level so
                // it sits on its own line like a paragraph.
                name: "mathBlock",
                level: "block",
                start(src: string) {
                    const i = src.indexOf("$$");
                    return i < 0 ? undefined : i;
                },
                tokenizer(src: string) {
                    // Require the opener at position 0 and a closing $$. Content is
                    // non-empty (reject "$$$$"). `[\s\S]` so it can span newlines.
                    const m = /^\$\$([\s\S]+?)\$\$/.exec(src);
                    if (!m) return undefined;
                    return { type: "mathBlock", raw: m[0], text: m[1] };
                },
                renderer(token: any) {
                    _mdHasMath = true;
                    return renderMath(token.text, true) + "\n";
                }
            },
            {
                // Inline math: $ ... $  on a single line. Guarded against prose that
                // merely contains dollar signs (prices, shell vars) the same way the
                // chat renderer is: no whitespace hugging the delimiters, and a span
                // that is nothing but a number/currency amount is left as text.
                name: "mathInline",
                level: "inline",
                start(src: string) {
                    // Point the inline lexer at the next single `$` that is not part
                    // of a `$$` (display handled at block level) so it gives us a
                    // chance to tokenize there.
                    const m = /(?<!\$)\$(?!\$)/.exec(src);
                    return m ? m.index : undefined;
                },
                tokenizer(src: string) {
                    if (src[0] !== "$" || src[1] === "$") return undefined;
                    // Closing single `$` that is not itself escaped or doubled.
                    const m = /^\$((?:\\.|[^$\\])+?)\$(?!\$)/.exec(src);
                    if (!m) return undefined;
                    const inner = m[1];
                    // (1) no whitespace immediately inside the delimiters: "$ x$".
                    if (/^\s/.test(inner) || /\s$/.test(inner)) return undefined;
                    // (2) a digit right after the closing $ means the next "$" was a
                    //     price ("$5 and $10") — reject this span.
                    const after = src.charAt(m[0].length);
                    if (/\d/.test(after)) return undefined;
                    // (3) pure number / currency-ish amount with no letters or TeX
                    //     command: "$3.50", "$1,000" — leave as text.
                    if (!/[a-zA-Z\\]/.test(inner) && /^[\d.,\s+\-*/()]+$/.test(inner)) return undefined;
                    return { type: "mathInline", raw: m[0], text: inner };
                },
                renderer(token: any) {
                    _mdHasMath = true;
                    return renderMath(token.text, false);
                }
            }
        ]
    });
}

/** Decode the small set of entities marked emits for code text. */
function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}

/** Render markdown source to body HTML, tracking whether it emitted any math.
 *  `_mdHasMath` is reset per call and read straight after, so the doc wrapper
 *  can decide whether to pay for the KaTeX CSS/font payload. */
export function markdownToHtml(md: string): { html: string; hasMath: boolean } {
    ensureMathExtension();
    _mdHasMath = false;
    let html: string;
    try {
        html = marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
    } catch (e) {
        return { html: "<pre>" + escapeHtml(String(e)) + "</pre>", hasMath: false };
    }
    return { html, hasMath: _mdHasMath };
}

/** One heading in the document outline: its text, depth (h1..h6) and the id the
 *  TOC entry links to. */
export interface TocEntry {
    id: string;
    text: string;
    level: number;
}

/** Split a leading YAML frontmatter block off the source. A frontmatter block is a
 *  `---` line at the very top, its body, and a closing `---` (or `...`) line. Returns
 *  the raw block body (without the fences) and the markdown that follows. Marked would
 *  otherwise turn the opening `---` into a horizontal rule and render the keys as a
 *  loose paragraph, so we peel it off before parsing and render it as a card instead. */
export function splitFrontmatter(md: string): { frontmatter: string | null; body: string } {
    // The opener must be the very first line (allow a leading BOM). The close is a
    // line that is exactly --- or ... . Require at least one body line between them.
    const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(md);
    if (!m) return { frontmatter: null, body: md };
    return { frontmatter: m[1], body: md.slice(m[0].length) };
}

/** Parse the (simple) key: value lines of a YAML frontmatter block into ordered
 *  pairs for the card. This is intentionally shallow — enough for the common
 *  `title: …`, `date: …`, `tags: [a, b]` front matter, not a full YAML engine.
 *  Nested maps / block scalars are shown as their raw line so nothing is dropped;
 *  a value that is a `[..]` / `- ` list is flattened to a comma-joined string. */
export function parseFrontmatter(fm: string): { key: string; value: string }[] {
    const pairs: { key: string; value: string }[] = [];
    const lines = fm.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || /^\s*#/.test(line)) continue; // blank / comment
        // A block list under a key: `tags:` then `- a` lines beneath it.
        const keyOnly = /^([A-Za-z0-9_.\- ]+):\s*$/.exec(line);
        if (keyOnly && /^\s*-\s+/.test(lines[i + 1] || "")) {
            const items: string[] = [];
            while (/^\s*-\s+/.test(lines[i + 1] || "")) items.push(lines[++i].replace(/^\s*-\s+/, "").trim());
            pairs.push({ key: keyOnly[1].trim(), value: items.join(", ") });
            continue;
        }
        const kv = /^([A-Za-z0-9_.\- ]+):\s*(.*)$/.exec(line);
        if (kv) {
            let value = kv[2].trim();
            // Unwrap a quoted scalar and a flow list `[a, b]` for a tidy readout.
            value = value.replace(/^["'](.*)["']$/, "$1");
            const flow = /^\[(.*)\]$/.exec(value);
            if (flow) value = flow[1].split(",").map(s => s.trim().replace(/^["'](.*)["']$/, "$1")).join(", ");
            pairs.push({ key: kv[1].trim(), value });
        } else {
            // A line we don't model (nested map, block scalar) — keep it verbatim so
            // nothing silently vanishes from the card.
            pairs.push({ key: "", value: line.trim() });
        }
    }
    return pairs;
}

/** Render a frontmatter block as a tidy key/value card that sits above the body.
 *  Returns "" when there's nothing worth showing. Values keep their plain text
 *  (escaped); a value-only line (unmodelled YAML) spans the row. */
export function renderFrontmatterCard(fm: string): string {
    const pairs = parseFrontmatter(fm);
    if (pairs.length === 0) return "";
    const rows = pairs.map(p =>
        p.key
            ? `<div class="dv-fm-row"><div class="dv-fm-key">${escapeHtml(p.key)}</div><div class="dv-fm-val">${escapeHtml(p.value)}</div></div>`
            : `<div class="dv-fm-row dv-fm-raw"><div class="dv-fm-val">${escapeHtml(p.value)}</div></div>`
    ).join("");
    return `<div class="dv-fm">${rows}</div>`;
}

// Slugs already handed out this render, so two "Setup" headings get setup / setup-1.
let _slugTaken = new Set<string>();

/** Turn heading text into a url-safe id (github-ish: lowercase, spaces→dashes, drop
 *  punctuation), de-duplicated within the document. */
function slugify(text: string): string {
    const base = text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-") || "section";
    let slug = base;
    let n = 1;
    while (_slugTaken.has(slug)) slug = `${base}-${n++}`;
    _slugTaken.add(slug);
    return slug;
}

/** Give every rendered heading a stable id (so the TOC can jump to it) and collect
 *  the outline. marked doesn't emit heading ids in every version, and it never gives
 *  us the plain text, so we add both here from the rendered <h1..6> tags. A heading
 *  that already carries an id keeps it. */
export function addHeadingIds(html: string): { html: string; toc: TocEntry[] } {
    _slugTaken = new Set<string>();
    const toc: TocEntry[] = [];
    const out = html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (_full, lvl: string, attrs: string, inner: string) => {
        const level = Number(lvl);
        // The heading's plain text = its inner HTML with tags stripped, entities decoded.
        const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
        if (!text) return _full; // nothing to link to
        const existing = /\sid\s*=\s*"([^"]*)"/.exec(attrs);
        const id = existing ? existing[1] : slugify(text);
        toc.push({ id, text, level });
        const attrsWithId = existing ? attrs : `${attrs} id="${escapeHtml(id)}"`;
        return `<h${lvl}${attrsWithId}>${inner}</h${lvl}>`;
    });
    return { html: out, toc };
}

/** Re-highlight marked's emitted <pre><code> fences with highlight.js so code
 *  blocks in the rendered markdown get the same dark hljs theme the code viewer
 *  uses. marked leaves the fence text HTML-escaped; we decode, highlight, re-wrap. */
export function highlightMarkdownCode(html: string): string {
    return html.replace(
        /<pre><code(?:\s+class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g,
        (_full, fence: string | undefined, escaped: string) => {
            const raw = decodeEntities(escaped);
            const aliases: Record<string, string> = {
                js: "javascript", ts: "typescript", py: "python", rb: "ruby",
                sh: "bash", shell: "bash", yml: "yaml", "c++": "cpp", "c#": "csharp"
            };
            let language = fence ? (aliases[fence.toLowerCase()] || fence.toLowerCase()) : "plaintext";
            if (language !== "plaintext" && !getHighlighter().getLanguage(language)) language = "plaintext";
            const out = highlightCode(raw, language);
            return `<pre><code class="hljs language-${escapeHtml(language)}">${out}</code></pre>`;
        }
    );
}
