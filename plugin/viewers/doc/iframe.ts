/*
 * The shared DOC-family iframe shell.
 *
 * Markdown, self-contained HTML artifacts, .docx, .xlsx-as-csv (no), mermaid,
 * graphviz and .ipynb all render into ONE dark, sandboxed <iframe>. This module
 * owns that shell so the per-format viewers only have to produce a frameHtml
 * string and hand it to the engine's nonce machinery:
 *
 *   - HtmlBody — the iframe body every doc viewer reuses as its `Body`. It mounts
 *     content.frameHtml in an iframe with `sandbox="allow-scripts"` ONLY (never
 *     allow-same-origin — see the hazard note on the element), and shows the shared
 *     loading card until the frame's first load fires (with an 8s watchdog → the
 *     shared error card).
 *   - wrapMarkdownDoc + MD_STYLE + MD_MATH_STYLE + MD_LINK_SCRIPT — the dark
 *     markdown document wrapper. The markdown / docx / mermaid / graphviz / ipynb
 *     loaders all wrap their body HTML with this so they sit on the same dark page
 *     with the same link routing. (The html viewer does NOT wrap — a self-contained
 *     artifact carries its own full document.)
 *
 * The MD_LINK_SCRIPT postMessages a clicked link's href up to the host, which opens
 * it in the user's external browser (index.tsx listens for __dockViewOpenLink and
 * calls openExternalLink). The sandbox has no allow-popups, so the frame can't
 * window.open itself — the bridge is how links escape to the browser.
 *
 * NO module-top work: only imports, string constants and function/component decls.
 * React is read inside HtmlBody (never destructured at module top); the KaTeX CSS
 * is only string-concatenated inside wrapMarkdownDoc, never evaluated.
 */

import { React } from "@webpack/common";

import { escapeHtml } from "../../engine/html";
import { getActiveWindow } from "../../engine/window";
import { KATEX_CSS } from "../../katex-css";
import { ARTIFACT_RENDER_FAILURE, LoadingBody, renderErrorBody } from "../../ui/StateCards";

// If the iframe's first `load` (or a DOM `error`) hasn't fired by this many ms we
// assume the render hung and fall back to the shared error card.
const IFRAME_LOAD_TIMEOUT = 8000;

// The dark document style for the markdown/docx/mermaid/graphviz/ipynb body. This
// is a sandboxed srcdoc iframe with its OWN document — it can neither reach our
// style.css nor see Discord's theme vars, so every colour it needs is inlined here.
export const MD_STYLE = `<style>
:root { color-scheme: dark; }
html, body { margin: 0; padding: 0; background: #1e1f22; }
/* Scrollbars: this is a sandboxed srcdoc iframe with its own document, so it can
   neither reach our style.css nor see Discord's --scrollbar-* theme vars. Paint the
   markdown body's vertical bar and any wide code-block / table horizontal bars in
   Discord's DARK thin-thumb colour so they read as dark-theme chrome, not the white
   UA default. #5f606a is exactly what --scrollbar-thin-thumb resolves to in the
   default dark theme. We do NOT copy Discord's 2px transparent padding-box border:
   that inset shrinks the visible thumb to ~half the bar, and the owner wants the
   thumb to FILL the full bar width like the old default scroller did. So: an 8px
   track, a rounded thumb painted edge-to-edge (no border, no padding-box clip),
   transparent track. Same fade-on-hover as Discord's .fade scrollers. Keep this in
   sync with the .dockview-body/.dockview-cm .cm-scroller rules in style.css. */
html::-webkit-scrollbar, body::-webkit-scrollbar,
pre::-webkit-scrollbar, table::-webkit-scrollbar { width: 8px; height: 8px; }
html::-webkit-scrollbar-track, body::-webkit-scrollbar-track,
pre::-webkit-scrollbar-track, table::-webkit-scrollbar-track { background-color: transparent; }
html::-webkit-scrollbar-thumb, body::-webkit-scrollbar-thumb,
pre::-webkit-scrollbar-thumb, table::-webkit-scrollbar-thumb {
  background-color: #5f606a;
  border-radius: 4px; min-height: 40px;
}
html::-webkit-scrollbar-corner, body::-webkit-scrollbar-corner,
pre::-webkit-scrollbar-corner, table::-webkit-scrollbar-corner { background-color: transparent; }
pre::-webkit-scrollbar-thumb, pre::-webkit-scrollbar-track,
table::-webkit-scrollbar-thumb, table::-webkit-scrollbar-track { visibility: hidden; }
pre:hover::-webkit-scrollbar-thumb, pre:hover::-webkit-scrollbar-track,
table:hover::-webkit-scrollbar-thumb, table:hover::-webkit-scrollbar-track { visibility: visible; }
/* MD-1: constrain the reading body to a comfortable measure (~70ch) and centre
   it as a column, so long-form markdown doesn't stretch edge-to-edge on a wide
   panel. At narrow widths the 70ch cap exceeds the panel so the column simply
   fills it (minus the side padding) — i.e. the constraint only bites once the
   panel is wide enough to harm readability. The cap is on the .md container;
   tables and code blocks inside still scroll horizontally within it when their
   own content is wider. */
.md {
  box-sizing: border-box;
  max-width: 70ch;
  margin: 0 auto;
  padding: 16px 20px 48px;
  color: #dbdee1;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji";
  font-size: 15px;
  line-height: 1.6;
  word-wrap: break-word;
}
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { color: #f2f3f5; font-weight: 600; line-height: 1.3; margin: 24px 0 12px; }
.md h1 { font-size: 1.9em; border-bottom: 1px solid #3f4147; padding-bottom: .3em; }
.md h2 { font-size: 1.5em; border-bottom: 1px solid #3f4147; padding-bottom: .3em; }
.md h3 { font-size: 1.25em; }
.md h4 { font-size: 1.05em; }
.md p { margin: 0 0 14px; }
.md a { color: #00a8fc; text-decoration: none; }
.md a:hover { text-decoration: underline; }
.md ul, .md ol { margin: 0 0 14px; padding-left: 2em; }
.md li { margin: 4px 0; }
.md li > p { margin: 0; }
.md blockquote { margin: 0 0 14px; padding: 0 1em; color: #b5bac1; border-left: 4px solid #4e5058; }
.md hr { height: 1px; border: 0; background: #3f4147; margin: 24px 0; }
.md img { max-width: 100%; }
.md code { font-family: Consolas, "Andale Mono WT", "Andale Mono", monospace; font-size: 85%; background: #2b2d31; padding: .2em .4em; border-radius: 4px; }
.md pre { background: #2b2d31; padding: 14px 16px; border-radius: 6px; overflow: auto; margin: 0 0 14px; border: 1px solid #1e1f22; }
.md pre code { background: none; padding: 0; font-size: 88%; line-height: 1.5; }
.md table { border-collapse: collapse; margin: 0 0 14px; display: block; overflow: auto; max-width: 100%; }
.md table th, .md table td { border: 1px solid #3f4147; padding: 6px 13px; }
.md table th { background: #2b2d31; font-weight: 600; }
.md table tr:nth-child(2n) { background: #26282c; }
.md input[type=checkbox] { margin-right: 6px; }
/* compact hljs dark theme (github-dark-dimmed-ish) */
.hljs { color: #dbdee1; }
.hljs-comment, .hljs-quote { color: #768390; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-doctag, .hljs-formula { color: #f47067; }
.hljs-string, .hljs-meta .hljs-string, .hljs-regexp, .hljs-addition { color: #96d0ff; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable, .hljs-tag .hljs-attr { color: #6cb6ff; }
.hljs-title, .hljs-section, .hljs-title.class_, .hljs-title.function_ { color: #dcbdfb; }
.hljs-built_in, .hljs-class .hljs-title, .hljs-type { color: #f69d50; }
.hljs-attribute, .hljs-attr, .hljs-name { color: #6cb6ff; }
.hljs-symbol, .hljs-bullet, .hljs-link { color: #f69d50; }
.hljs-meta, .hljs-selector-id, .hljs-selector-class { color: #6cb6ff; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
.hljs-deletion { color: #ff938a; }
/* .docx/.rtf/.odt affordance: a quiet "Converted from .docx" pill above the
   converted body so a user knows this is a rendering, not the literal file. The
   .rtf/.odt converters reuse this same note class. Muted, not loud. */
.dv-docx-note { color: #949ba4; font-size: 12px; margin: 0 0 14px; padding-bottom: 10px; border-bottom: 1px solid #3f4147; }
/* .rtf / .odt converted bodies sit inside the same .md article, so they inherit the
   markdown type scale. Embedded ODF pictures get the same max-width clamp as .md img
   and a light card so a transparent PNG reads on the dark page; empty paragraphs the
   converters emit keep their vertical rhythm. */
.rtf-doc p:empty, .odt-doc p:empty { min-height: 1em; }
.odt-img { max-width: 100%; height: auto; background: #fff; border-radius: 4px; }
/* .odp slide cards: each <draw:page> renders as a numbered card so a deck reads as a
   stack of legible slides (a flowed-outline preview, not a pixel-faithful layout). The
   first text-box on a slide is usually the title, so its first heading/paragraph reads
   larger. Cards use the same panel-surface + hairline border the docx/table chrome uses. */
.odp-doc { display: flex; flex-direction: column; gap: 16px; }
.odp-slide { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 16px 18px; }
.odp-slide-num { color: #949ba4; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 10px; }
.odp-box { margin: 0 0 10px; }
.odp-box:last-child { margin-bottom: 0; }
.odp-box > :first-child { margin-top: 0; }
.odp-box > :last-child { margin-bottom: 0; }
.odp-empty { color: #80848e; font-style: italic; margin: 0; }
.odp-img { max-width: 100%; height: auto; background: #fff; border-radius: 4px; }
/* mermaid: the rendered SVG sits centred on the dark page and may be wider/taller
   than the panel, so the body scrolls to it. The SVG keeps its own intrinsic size
   (no forced width) so a large diagram stays legible and pannable via scroll. */
.dv-mermaid { display: flex; justify-content: center; padding: 8px 0; }
.dv-mermaid svg { max-width: 100%; height: auto; }
.dv-mermaid-error { color: #f85149; white-space: pre-wrap; word-break: break-word; background: #2b2d31; padding: 12px 14px; border-radius: 6px; border: 1px solid #1e1f22; }
/* graphviz: the viz-js SVG reuses the mermaid layout (centred, scrollable, intrinsic
   size). Graphviz emits a white default background fill on the root <svg> polygon; we
   can't easily strip it, so we draw the SVG on a light card so its black text/edges
   stay legible on the dark page (a contained diagram, not edge-to-edge white). */
.dv-graphviz { display: flex; justify-content: center; padding: 8px 0; }
.dv-graphviz svg { max-width: 100%; height: auto; background: #f5f6f8; border-radius: 6px; }
/* ipynb: each cell is a block with a left rail + an "In [n]:" / "Out[n]:" prompt
   gutter, echoing the Jupyter layout. The markdown cell bodies reuse the .md rules. */
.dv-nb-cell { display: flex; gap: 10px; margin: 0 0 14px; }
.dv-nb-prompt { flex: 0 0 64px; text-align: right; color: #5e6772; font-family: Consolas, "Andale Mono", monospace; font-size: 12px; line-height: 1.5; padding-top: 14px; user-select: none; white-space: nowrap; }
.dv-nb-body { flex: 1 1 auto; min-width: 0; }
.dv-nb-md { padding-top: 2px; }
.dv-nb-code { border-left: 3px solid #4e5058; }
.dv-nb-code > pre { margin: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; }
.dv-nb-out { margin: 6px 0 0; }
.dv-nb-out pre { margin: 0; background: #232428; border: 1px solid #1e1f22; padding: 10px 12px; border-radius: 6px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: Consolas, "Andale Mono", monospace; font-size: 12.5px; line-height: 1.45; color: #c7ccd1; }
.dv-nb-out-html { background: #232428; border: 1px solid #1e1f22; padding: 10px 12px; border-radius: 6px; overflow: auto; }
.dv-nb-out-html table { border-collapse: collapse; }
.dv-nb-out-html th, .dv-nb-out-html td { border: 1px solid #3f4147; padding: 4px 8px; }
.dv-nb-out-err { color: #ff938a !important; background: #2b1d1d !important; border-color: #5a2626 !important; }
.dv-nb-img { max-width: 100%; background: #fff; border-radius: 6px; }
.dv-nb-sep { height: 1px; border: 0; background: #2b2d31; margin: 0 0 14px; }
/* email (.eml): a header card (From/To/Subject/Date) above the message body, plus an
   attachment list. The body — the sender's own HTML or a plaintext fallback — sits in
   a neutral wrapper; we strip remote image sources before render so nothing phones home
   (a "remote content blocked" pill marks where an image was). The card reuses the dark
   doc palette so it reads as chrome, not content. */
.dv-eml-head { margin: 0 0 18px; padding: 0 0 14px; border-bottom: 1px solid #3f4147; }
.dv-eml-subject { color: #f2f3f5; font-size: 1.35em; font-weight: 600; line-height: 1.3; margin: 0 0 10px; word-break: break-word; }
.dv-eml-row { display: flex; gap: 8px; font-size: 13px; line-height: 1.5; margin: 2px 0; }
.dv-eml-label { flex: 0 0 64px; color: #949ba4; text-align: right; user-select: none; }
.dv-eml-val { flex: 1 1 auto; min-width: 0; color: #dbdee1; word-break: break-word; }
.dv-eml-val .dv-eml-addr { color: #dbdee1; }
.dv-eml-val .dv-eml-email { color: #949ba4; }
.dv-eml-att { margin: 16px 0 0; padding: 12px 0 0; border-top: 1px solid #3f4147; }
.dv-eml-att-title { color: #949ba4; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; margin: 0 0 8px; }
.dv-eml-att-list { list-style: none; margin: 0; padding: 0; }
.dv-eml-att-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; margin: 4px 0; background: #2b2d31; border: 1px solid #1e1f22; border-radius: 6px; font-size: 13px; color: #dbdee1; }
.dv-eml-att-item .dv-eml-att-icon { flex: 0 0 auto; color: #949ba4; }
.dv-eml-att-item .dv-eml-att-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dv-eml-att-item .dv-eml-att-size { flex: 0 0 auto; color: #949ba4; font-size: 12px; }
.dv-eml-body { color: #dbdee1; line-height: 1.6; word-wrap: break-word; }
.dv-eml-body img { max-width: 100%; }
.dv-eml-body a { color: #00a8fc; text-decoration: none; }
.dv-eml-body a:hover { text-decoration: underline; }
.dv-eml-body blockquote { margin: 0 0 14px; padding: 0 1em; color: #b5bac1; border-left: 4px solid #4e5058; }
.dv-eml-body table { max-width: 100%; }
.dv-eml-body-text { white-space: pre-wrap; word-break: break-word; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
.dv-eml-blocked { display: inline-block; padding: 1px 8px; margin: 2px; background: #2b2d31; border: 1px dashed #4e5058; border-radius: 4px; color: #949ba4; font-size: 12px; }
.dv-eml-empty { color: #949ba4; font-style: italic; }
</style>`;

// Dark-theme overlay for KaTeX math, injected after KATEX_CSS only when a doc
// has math. KaTeX colours math via `currentColor`, so it inherits .md's light
// text on the dark background with no extra work. We only: (1) let very wide
// DISPLAY math scroll horizontally instead of overflowing the 70ch column, and
// (2) style the raw-text fallback for a TeX parse error so it reads as an inline
// error rather than silently vanishing.
export const MD_MATH_STYLE = `<style>
.md .katex { font-size: 1.05em; }
.md .katex-display { margin: 14px 0; overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
.md .katex-error { color: #f85149; }
.md .md-math-fallback { color: #f85149; background: #2b2d31; }
</style>`;

/** A tiny script injected into the markdown sandbox iframe so any link click is
 *  opened in the user's BROWSER (not navigated inside the sandbox). The iframe
 *  is sandboxed without allow-popups, so we can't window.open from inside; we
 *  postMessage the href up to the host, which opens it (VencordNative/window). */
export const MD_LINK_SCRIPT = `<script>(function(){
  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!href || href[0] === "#") return; // in-page anchor: let it scroll
    e.preventDefault();
    try { parent.postMessage({ __dockViewOpenLink: href }, "*"); } catch (_) {}
  }, true);
})();</script>`;

/** Wrap rendered markdown HTML in a full dark-themed document. Anchors get a
 *  default target so even if the click handler is bypassed they don't navigate
 *  the sandbox itself; the injected script routes clicks to the host browser.
 *
 *  When the doc contains math we additionally inject the inlined KaTeX stylesheet
 *  (CSS + base64 woff2 fonts) plus a small dark-theme overlay. The sandbox can't
 *  load external fonts, so without the inlined payload math glyphs would render
 *  as tofu boxes — hence we only pay for it when `hasMath` is true. */
export function wrapMarkdownDoc(bodyHtml: string, hasMath: boolean): string {
    const mathStyle = hasMath ? `<style>${KATEX_CSS}</style>${MD_MATH_STYLE}` : "";
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">${MD_STYLE}${mathStyle}</head><body><article class="md">${bodyHtml}</article>${MD_LINK_SCRIPT}</body></html>`;
}

// Extra dark-doc styles for the markdown viewer's own polish (NOT shared with the
// docx/ipynb/mermaid/etc. doc viewers — only wrapMarkdownDocFull injects these):
//  - the frontmatter card (a key/value readout of the leading YAML block),
//  - the table-of-contents overlay (a heading outline that slides in from the right),
//  - the per-fence copy button (revealed on hover over a code block).
// Colours mirror MD_STYLE's palette (this srcdoc iframe can't see Discord's theme
// vars). The TOC/copy affordances are keyboard/pointer-driven inside the sandbox.
export const MD_ENHANCE_STYLE = `<style>
/* Frontmatter card: a quiet panel-surface table above the body, same hairline
   border + muted key tone the docx/eml chrome uses. */
.dv-fm { margin: 0 0 20px; padding: 4px 0 0; border-bottom: 1px solid #3f4147; }
.dv-fm-row { display: flex; gap: 12px; padding: 5px 0; font-size: 13.5px; line-height: 1.5; }
.dv-fm-key { flex: 0 0 30%; max-width: 180px; color: #949ba4; font-weight: 600; word-break: break-word; }
.dv-fm-val { flex: 1 1 auto; min-width: 0; color: #dbdee1; word-break: break-word; white-space: pre-wrap; }
.dv-fm-raw .dv-fm-val { color: #b5bac1; font-family: Consolas, "Andale Mono", monospace; font-size: 12.5px; }
/* Code-fence copy button: sits top-right inside each <pre>, hidden until the block
   is hovered (or the button focused for keyboard use). Flips to a check on copy. */
.md pre { position: relative; }
.dv-copy-btn {
  position: absolute; top: 6px; right: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0;
  background: #383a40; color: #b5bac1;
  border: 1px solid #1e1f22; border-radius: 4px;
  cursor: pointer; opacity: 0; transition: opacity .1s ease, background .1s ease;
}
.md pre:hover .dv-copy-btn, .dv-copy-btn:focus-visible { opacity: 1; }
.dv-copy-btn:hover { background: #4e5058; color: #dbdee1; }
.dv-copy-btn svg { width: 16px; height: 16px; display: block; fill: currentColor; }
.dv-copy-btn .dv-copy-check { display: none; }
.dv-copy-btn.dv-copied { background: #248046; color: #fff; }
.dv-copy-btn.dv-copied .dv-copy-icon { display: none; }
.dv-copy-btn.dv-copied .dv-copy-check { display: block; }
/* TOC overlay: a scrollable outline pinned to the right edge, hidden until the
   header toggle opens it. Panel-surface card so it reads as chrome over the doc. */
.dv-toc {
  position: fixed; top: 0; right: 0; bottom: 0; width: 260px; z-index: 20;
  box-sizing: border-box; padding: 14px 8px 24px 14px; overflow-y: auto;
  background: #232428; border-left: 1px solid #3f4147;
  transform: translateX(100%); transition: transform .16s ease; display: none;
}
.dv-toc.dv-toc-open { transform: translateX(0); display: block; }
.dv-toc-title { color: #949ba4; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 10px; }
.dv-toc a {
  display: block; padding: 4px 8px; margin: 1px 0; border-radius: 4px;
  color: #b5bac1; font-size: 13px; line-height: 1.4; text-decoration: none;
  word-break: break-word; cursor: pointer;
}
.dv-toc a:hover { background: #35373c; color: #dbdee1; }
.dv-toc-l2 { padding-left: 20px; }
.dv-toc-l3 { padding-left: 34px; }
.dv-toc-l4 { padding-left: 48px; }
.dv-toc-l5 { padding-left: 62px; }
.dv-toc-l6 { padding-left: 76px; }
</style>`;

/** The in-iframe script for the markdown polish: copy buttons on code fences, and
 *  the TOC open/close driven by a postMessage from the host header toggle.
 *
 *  CLIPBOARD: this is a null-origin sandbox (allow-scripts only), where BOTH
 *  navigator.clipboard.writeText (rejects — opaque origin) AND
 *  document.execCommand("copy") (returns false — verified live) are unavailable. So
 *  the copy button posts the raw code up to the host, which owns a real Discord
 *  origin and does the clipboard write, then acks back so the button flips to the
 *  copied check. Each button gets an id so the ack targets the right one. */
export const MD_ENHANCE_SCRIPT = `<script>(function(){
  var COPY = '<svg class="dv-copy-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2Zm2 0h5a2 2 0 0 1 2 2v5h2V5h-9v2ZM6 9v9h9V9H6Z"/></svg>';
  var CHECK = '<svg class="dv-copy-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"/></svg>';
  var byId = {};
  document.querySelectorAll(".md pre").forEach(function(pre, i){
    var code = pre.querySelector("code"); if(!code) return;
    var id = "c" + i;
    var btn = document.createElement("button");
    btn.type="button"; btn.className="dv-copy-btn";
    btn.setAttribute("aria-label","Copy code"); btn.title="Copy";
    btn.innerHTML = COPY + CHECK;
    byId[id] = btn;
    btn.addEventListener("click", function(){
      try { parent.postMessage({ __dockViewMdCopy: { id: id, text: code.textContent || "" } }, "*"); } catch(e) {}
    });
    pre.appendChild(btn);
  });
  var toc = document.querySelector(".dv-toc");
  // TOC entries scroll to their heading. The document carries <base target="_blank">
  // (so stray links open externally), which makes a bare #anchor try to navigate a
  // new context instead of scrolling — so scroll the target into view ourselves.
  if (toc) toc.addEventListener("click", function(e){
    var a = e.target && e.target.closest ? e.target.closest("a[href^='#']") : null;
    if (!a) return;
    e.preventDefault();
    var el = document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  window.addEventListener("message", function(e){
    var d = e && e.data; if (!d) return;
    if (d.__dockViewMdToc !== undefined && toc) {
      toc.classList.toggle("dv-toc-open", !!d.__dockViewMdToc);
    }
    // The host copied a fence's text — flip that button to the copied check.
    if (d.__dockViewMdCopied && byId[d.__dockViewMdCopied]) {
      var b = byId[d.__dockViewMdCopied];
      b.classList.add("dv-copied"); b.title="Copied";
      setTimeout(function(){ b.classList.remove("dv-copied"); b.title="Copy"; }, 1200);
    }
  });
  // Ask the host for the current TOC state so a remounted frame (cache return /
  // leaving edit mode) reopens the outline if it was left open.
  if (toc) { try { parent.postMessage({ __dockViewMdTocReady: true }, "*"); } catch(e) {} }
})();</script>`;

/** Build the outline markup (a nav of anchor links) from the collected headings.
 *  Returns "" when the doc has no headings (the header toggle is then disabled). */
export function buildTocHtml(toc: { id: string; text: string; level: number }[]): string {
    if (toc.length === 0) return "";
    const items = toc.map(h =>
        `<a href="#${h.id}" class="dv-toc-l${h.level}">${escapeHtml(h.text)}</a>`
    ).join("");
    return `<nav class="dv-toc" aria-label="Table of contents"><div class="dv-toc-title">Contents</div>${items}</nav>`;
}

/** The markdown VIEWER's full document — the shared dark markdown doc plus the
 *  viewer-only polish (frontmatter card, TOC overlay, code-fence copy). Kept separate
 *  from wrapMarkdownDoc so the other doc viewers (docx / ipynb / mermaid / …) are
 *  untouched. `frontmatterHtml` / `toc` are "" / [] when the source has neither. */
export function wrapMarkdownDocFull(bodyHtml: string, hasMath: boolean, frontmatterHtml: string, toc: { id: string; text: string; level: number }[]): string {
    const mathStyle = hasMath ? `<style>${KATEX_CSS}</style>${MD_MATH_STYLE}` : "";
    const tocHtml = buildTocHtml(toc);
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">${MD_STYLE}${MD_ENHANCE_STYLE}${mathStyle}</head><body>`
        + `<article class="md">${frontmatterHtml}${bodyHtml}</article>${tocHtml}`
        + `${MD_LINK_SCRIPT}${MD_ENHANCE_SCRIPT}</body></html>`;
}

/** The shared DOC iframe body. Mounts content.frameHtml in a null-origin sandboxed
 *  iframe (markdown/html/docx/mermaid/graphviz/ipynb all reuse it as their Body).
 *  The dispatcher keys it on content.seq and only renders it once content has
 *  resolved (loading/error are handled upstream), so here we just watch for the
 *  frame's first load and fall back to the error card if it never fires. */
export function HtmlBody() {
    const { useRef, useState, useEffect } = React;
    // "loading" until the iframe fires load; "ok" once it does; "failed" if the
    // watchdog trips or the element errors.
    const [phase, setPhase] = useState("loading" as "loading" | "ok" | "failed");
    const timer = useRef(0 as any);

    useEffect(() => {
        timer.current = setTimeout(() => setPhase(p => (p === "ok" ? p : "failed")), IFRAME_LOAD_TIMEOUT);
        return () => clearTimeout(timer.current);
    }, []);

    if (phase === "failed") {
        // Reuse the shared error card (retry / open-in-browser / download). The
        // sentinel makes humanizeError use the artifact "didn't render" copy — the
        // file fetched fine, it just never became ready — not the generic file-load
        // wording. Retry re-fetches (fresh document); download/open are the fallbacks.
        return renderErrorBody(ARTIFACT_RENDER_FAILURE);
    }

    const onLoad = () => {
        clearTimeout(timer.current);
        // An artifact whose <iframe> emits the synthetic about:blank load before
        // its srcDoc is swapped in would flip "ok" too early; but with srcDoc the
        // first (and only) load IS the document, so this is the real render.
        setPhase("ok");
    };
    const onError = () => {
        clearTimeout(timer.current);
        setPhase("failed");
    };

    const iframe = React.createElement("iframe", {
        key: "frame",
        className: "dockview-frame",
        srcDoc: getActiveWindow().content.frameHtml,
        // allow-scripts ONLY (no allow-same-origin): a srcDoc frame with
        // allow-same-origin inherits THIS document's origin, so a script in an
        // untrusted-authored artifact could reach the host DOM and escape the
        // sandbox. Markdown/HTML here is inert and the link bridge is postMessage
        // (origin-agnostic), so a null origin loses nothing. Mirrors McpAppBody.
        sandbox: "allow-scripts",
        onLoad,
        onError,
        // Keep the frame mounted (so it actually loads) but hidden behind the
        // shared loading card until its first load fires.
        style: phase === "loading" ? { visibility: "hidden" } : undefined
    });

    // While waiting for the first load, overlay the SHARED loading card on top of
    // the (hidden) frame so the iframe path uses the same 4-state visuals as
    // every other viewer. A fast artifact clears this within a frame or two.
    if (phase === "loading") {
        return React.createElement(
            "div",
            { className: "dockview-frame-wrap" },
            iframe,
            React.createElement(
                "div",
                { className: "dockview-frame-loading-overlay" },
                React.createElement(LoadingBody, null)
            )
        );
    }
    return iframe;
}
