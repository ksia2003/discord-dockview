/*
 * The LAZY CodeMirror loader — the unified text engine for the dock.
 *
 * CodeMirror 6 is loaded behind a single dynamic import() (loadCM). Two hard rules
 * from the original feasibility spike carry over verbatim:
 *
 *   1. CM MUST stay behind this lazy dynamic import(). A static top-level
 *      `@codemirror/*` import THROWS at plugin module-eval and SILENTLY KILLS the
 *      whole DockView plugin (window.__dockView never appears — the same failure
 *      class as calling React.createElement at module top). The dynamic import
 *      defers CM's module evaluation to the first text-file open. Never hoist any
 *      of the imports below to module top.
 *   2. Syntax highlighting is GATED on file size (CodeBody applies the gate). CM's
 *      editing/scroll/selection/find are cheap and host-safe even at 50k lines; the
 *      SOLE source of the mount/scroll long-tasks the spike measured was the Lezer
 *      parser. So big files drop the parser entirely (plain text in CM).
 *
 * loadCM resolves every CM module behind one import(), assembles the reusable
 * surface (the Discord-tuned theme + highlight style, the find decoration field,
 * the language resolver, and the @codemirror/merge diff surface its later
 * edit-mode step needs), and caches it — only the FIRST text-file open pays the
 * import cost.
 */

// The lazily-loaded CM module surface (resolved once, then cached). Holds the
// pieces CodeBody assembles an EditorView/EditorState from plus the language
// resolver, the find plumbing, and the merge-diff surface (used by edit-mode).
import { loadLib } from "../../engine/lazyLib";

export interface CMModules {
    EditorState: any;
    EditorView: any;
    lineNumbers: any;
    Compartment: any;
    syntaxHighlighting: any;
    HighlightStyle: any;
    tags: any;
    Decoration: any;
    SearchCursor: any;
    RangeSetBuilder: any;
    StateField: any;
    StateEffect: any;
    // hljs-lang-id -> a freshly built CM LanguageSupport (or null for plaintext).
    languageFor: (hljsLang: string) => any | null;
    // our Discord-tuned theme + highlight style (built once from the modules).
    theme: any;
    highlightStyle: any;
    // find decoration plumbing (built once from the modules).
    setFindEffect: any;
    findField: any;
    // @codemirror/merge: inline colored diff vs a pristine original (edit-mode).
    unifiedMergeView: any;
    // our diff colour theme (added/changed = green, deleted = red), built once.
    mergeTheme: any;
}

let cmModulesPromise: Promise<CMModules> | null = null;

/** Resolve every CM module behind a single dynamic import() and assemble the
 *  reusable surface (theme, highlight style, language resolver, find field, merge
 *  diff theme). Cached: only the FIRST text-file open pays the import; the modules
 *  are then evaluated and the Discord theme/highlight-style/find-field are built
 *  once. */
export function loadCM(): Promise<CMModules> {
    if (cmModulesPromise) return cmModulesPromise;
    cmModulesPromise = (async () => {
        // CodeMirror is CHUNKED: every @codemirror/* + @lezer/highlight + lang pack
        // is bundled into chunk-codemirror.js (engine/chunks/codemirror.entry.ts) and
        // taken OUT of the renderer bundle. loadLib("codemirror") reads + evals that
        // chunk once and returns its namespace; we destructure each module surface
        // from it. There is NO bare `import("@codemirror/…")` here — those packages
        // are external to the renderer, so a bare specifier would dangle live.
        // (The dead inline fallback keeps the rule-1 dynamic-import shape if ever
        // un-chunked.)
        const cm: any = await loadLib("codemirror", () => import("@codemirror/state").then(m => ({ state: m })));
        const stateMod = cm.state;
        const viewMod = cm.view;
        const langMod = cm.language;
        const searchMod = cm.search;
        const lezerHl = cm.lezerHighlight;
        const mergeMod = cm.merge;

        const { EditorState, Compartment, StateField, StateEffect, RangeSetBuilder } = stateMod as any;
        const { EditorView, Decoration, lineNumbers } = viewMod as any;
        const { syntaxHighlighting, HighlightStyle } = langMod as any;
        const { SearchCursor } = searchMod as any;
        const { tags } = lezerHl as any;
        const { unifiedMergeView } = mergeMod as any;

        // --- Discord-tuned theme. Background/foreground match the in-panel code
        // surface (--background-base-lower / #dbdee1) so the editor reads at the
        // same tone as a real thread. Selection + active line use Discord vars
        // where they exist, with literal fallbacks for themes that lack them. The
        // gutter (line numbers) matches the old ::before gutter colours.
        const theme = EditorView.theme({
            "&": {
                color: "#dbdee1",
                backgroundColor: "var(--background-base-lower, #1a1a1e)",
                height: "100%",
                fontSize: "13px"
            },
            ".cm-scroller": {
                fontFamily: 'Consolas, "Andale Mono WT", "Andale Mono", "Lucida Console", monospace',
                lineHeight: "1.5",
                overflow: "auto"
            },
            ".cm-content": { caretColor: "#dbdee1" },
            "&.cm-focused": { outline: "none" },
            ".cm-gutters": {
                backgroundColor: "var(--background-base-lower, #1a1a1e)",
                color: "var(--text-muted, #6b7280)",
                border: "none",
                borderRight: "1px solid var(--background-modifier-accent, #2b2d31)"
            },
            ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
            ".cm-activeLineGutter": { backgroundColor: "transparent" },
            ".cm-activeLine": { backgroundColor: "transparent" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
                backgroundColor: "var(--text-selection, rgba(56,109,211,0.4))"
            },
            // find decorations (decoration-driven, not the @codemirror/search panel)
            ".cm-dockview-find": { backgroundColor: "rgba(255, 213, 0, 0.32)" },
            ".cm-dockview-find-active": { backgroundColor: "rgba(255, 145, 0, 0.6)" }
        }, { dark: true });

        // --- Highlight style tuned to the existing hljs dark theme (the same
        // github-dark-dimmed-ish palette used by the markdown iframe) so colours
        // stay consistent across both renderers.
        const highlightStyle = HighlightStyle.define([
            { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "#768390", fontStyle: "italic" },
            { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: "#f47067" },
            { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "#96d0ff" },
            { tag: [tags.number, tags.bool, tags.atom, tags.literal], color: "#6cb6ff" },
            { tag: [tags.variableName, tags.propertyName], color: "#dbdee1" },
            { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#dcbdfb" },
            { tag: [tags.className, tags.typeName, tags.namespace], color: "#f69d50" },
            { tag: [tags.definition(tags.variableName)], color: "#dbdee1" },
            { tag: [tags.tagName], color: "#f47067" },
            { tag: [tags.attributeName], color: "#6cb6ff" },
            { tag: [tags.attributeValue], color: "#96d0ff" },
            { tag: [tags.heading], color: "#dcbdfb", fontWeight: "700" },
            { tag: [tags.link, tags.url], color: "#6cb6ff", textDecoration: "underline" },
            { tag: [tags.emphasis], fontStyle: "italic" },
            { tag: [tags.strong], fontWeight: "700" },
            { tag: [tags.meta, tags.processingInstruction], color: "#6cb6ff" },
            { tag: [tags.deleted], color: "#ff938a" },
            { tag: [tags.inserted], color: "#96d0ff" },
            { tag: [tags.invalid], color: "#ff938a" }
        ]);

        // --- find decoration field. A StateField holds a DecorationSet rebuilt
        // from a list of {from,to,active} match ranges (dispatched via an effect),
        // so the same code find model (all matches dim / active match strong) works
        // over CM without the @codemirror/search FLOATING panel. Marks target
        // document offsets, so they survive scroll.
        const setFindEffect = StateEffect.define();
        const allMark = Decoration.mark({ class: "cm-dockview-find" });
        const activeMark = Decoration.mark({ class: "cm-dockview-find-active" });
        const findField = StateField.define({
            create: () => Decoration.none,
            update(deco: any, tr: any) {
                deco = deco.map(tr.changes);
                for (const e of tr.effects) {
                    if (e.is(setFindEffect)) {
                        const ranges: { from: number; to: number; active: boolean }[] = e.value;
                        const b = new RangeSetBuilder();
                        for (const r of ranges) {
                            if (r.from >= r.to) continue;
                            b.add(r.from, r.to, r.active ? activeMark : allMark);
                        }
                        deco = b.finish();
                    }
                }
                return deco;
            },
            provide: (f: any) => EditorView.decorations.from(f)
        });

        // --- language resolver. Maps the hljs language id we already derive per
        // file (content.codeLang) to a CM LanguageSupport, loaded from the lang
        // packs bundled into the renderer. A miss returns null → plain text in CM
        // (still themed/wrapped/findable, just no syntax colour). Each call builds
        // a fresh LanguageSupport (cheap) so two open files never share parser
        // state. Lang packs are imported lazily alongside CM (same dynamic chunk).
        // Lang packs come from the SAME codemirror chunk (already loaded above), so
        // there is no second import / network hop — just reads off the namespace.
        const jsMod = cm.langJavascript;
        const jsonMod = cm.langJson;
        const pyMod = cm.langPython;
        const cssMod = cm.langCss;
        const htmlMod = cm.langHtml;
        const xmlMod = cm.langXml;
        const mdMod = cm.langMarkdown;
        const rustMod = cm.langRust;
        const cppMod = cm.langCpp;
        const javaMod = cm.langJava;
        const yamlMod = cm.langYaml;
        const sqlMod = cm.langSql;
        const phpMod = cm.langPhp;
        const goMod = cm.langGo;

        const languageFor = (hljsLang: string): any | null => {
            switch (hljsLang) {
                case "javascript": return (jsMod as any).javascript();
                case "typescript": return (jsMod as any).javascript({ typescript: true });
                // jsx/tsx share the js pack with the jsx flag; our CODE_LANG maps
                // both .jsx and .tsx onto javascript/typescript already.
                case "json": return (jsonMod as any).json();
                case "python": return (pyMod as any).python();
                case "css": case "scss": case "less": return (cssMod as any).css();
                case "xml": case "svg": case "plist": return (xmlMod as any).xml();
                case "yaml": return (yamlMod as any).yaml();
                case "rust": return (rustMod as any).rust();
                case "c": case "cpp": return (cppMod as any).cpp();
                case "java": return (javaMod as any).java();
                case "sql": return (sqlMod as any).sql();
                case "php": return (phpMod as any).php();
                case "go": return (goMod as any).go();
                case "markdown": return (mdMod as any).markdown();
                // html only when explicitly typed html (our viewer routes .md/.svg
                // elsewhere); covers inline css/js. Reuse the html pack id.
                case "html": return (htmlMod as any).html();
                default: return null; // plaintext / unmapped → no language
            }
        };

        // --- merge diff theme. unifiedMergeView ships a dark baseTheme, but we
        // tune the colours to Discord's palette: added/changed text on a GREEN
        // wash, deleted text on a RED wash, each with a matching change-gutter
        // stripe. The accept/reject chunk buttons are HIDDEN via mergeControls:false
        // at the call site; the colored add/change/delete display is the point. We
        // restyle `cm-changedText` / `cm-deletedChunk` (the editor is the "b" side
        // of a unified view, class `cm-merge-b`). (Consumed by edit-mode, P8.)
        const mergeTheme = EditorView.theme({
            ".cm-changedLine": { backgroundColor: "rgba(63, 185, 80, 0.12)" },
            ".cm-changedText": {
                backgroundColor: "rgba(63, 185, 80, 0.32)",
                borderRadius: "2px"
            },
            ".cm-inlineChangedLine": { backgroundColor: "rgba(63, 185, 80, 0.12)" },
            ".cm-deletedChunk": { backgroundColor: "rgba(248, 81, 73, 0.12)" },
            ".cm-deletedChunk .cm-deletedText, .cm-deletedText": {
                backgroundColor: "rgba(248, 81, 73, 0.32)",
                color: "#ffb4ad",
                textDecoration: "line-through"
            },
            ".cm-insertedLine": { textDecoration: "none" },
            ".cm-changedLineGutter": { backgroundColor: "#3fb950" },
            ".cm-deletedLineGutter": { backgroundColor: "#f85149" }
        }, { dark: true });

        return {
            EditorState, EditorView, lineNumbers, Compartment, syntaxHighlighting, HighlightStyle,
            tags, Decoration, SearchCursor, RangeSetBuilder,
            StateField, StateEffect, languageFor, theme, highlightStyle,
            setFindEffect, findField, unifiedMergeView, mergeTheme
        } as CMModules;
    })();
    return cmModulesPromise;
}
