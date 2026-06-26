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
