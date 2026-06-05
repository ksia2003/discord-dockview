/*
 * DockView — LaTeX renderer (ported from the fork's initLatexRenderer).
 * ---------------------------------------------------------------------------
 * Injects KaTeX CSS/JS from a CDN and patches Discord's markdown parser to add
 * a `$...$` / `$$...$$` latex rule. The parser patch is NOT reversible (Discord
 * caches the rebuilt parser fn), so stop() only removes the injected link/script
 * (best-effort) and leaves the rule in place — it's a no-op without `$`-math.
 */

import { React } from "@webpack/common";

const CSS_ID = "dockview-katex-css";
const JS_ID = "dockview-katex-js";

let cssEl: HTMLLinkElement | null = null;
let jsEl: HTMLScriptElement | null = null;

export function startLatex() {
    if (document.getElementById(CSS_ID) || document.getElementById(JS_ID)) return;

    const css = document.createElement("link");
    css.id = CSS_ID;
    css.rel = "stylesheet";
    css.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
    document.head.appendChild(css);
    cssEl = css;

    const js = document.createElement("script");
    js.id = JS_ID;
    js.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js";
    js.onload = () => {
        function patchParser() {
            let parser: any = null;
            const cache = (Vencord as any).Webpack.cache;
            if (!cache) { setTimeout(patchParser, 300); return; }

            for (const id in cache) {
                const mod = cache[id];
                if (!mod?.exports) continue;
                for (const key in mod.exports) {
                    const val = mod.exports[key];
                    if (val?.defaultRules && val?.reactParserFor) { parser = val; break; }
                }
                if (parser) break;
            }
            if (!parser) { setTimeout(patchParser, 300); return; }
            if (parser.defaultRules.latex) return;

            const k = (window as any).katex;

            parser.defaultRules.latex = {
                order: 23,
                match(source: string) {
                    if (source.startsWith("$$")) return /^\$\$(.+?)\$\$/s.exec(source);
                    return /^\$(.+?)\$/.exec(source);
                },
                parse(capture: string[]) {
                    const size = capture[0].startsWith("$$") ? 2 : 1;
                    return { content: capture[0].slice(size, -size), type: "latex", inline: size === 1 };
                },
                react(node: any, _output: any, state: any) {
                    try {
                        const html = k.renderToString(node.content, { output: "html", displayMode: !node.inline, throwOnError: false });
                        return React.createElement("span", { key: state.key, dangerouslySetInnerHTML: { __html: html } });
                    } catch { return node.content; }
                }
            };
            parser.parse = parser.reactParserFor(parser.defaultRules);
        }
        patchParser();
    };
    document.head.appendChild(js);
    jsEl = js;
}

export function stopLatex() {
    // best-effort: remove injected CDN resources. The parser rule patch is
    // irreversible (Discord caches the rebuilt fn) and is left in place.
    cssEl?.remove();
    jsEl?.remove();
    cssEl = null;
    jsEl = null;
    document.getElementById(CSS_ID)?.remove();
    document.getElementById(JS_ID)?.remove();
}
