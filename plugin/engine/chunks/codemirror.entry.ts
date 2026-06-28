/*
 * Chunk entry for CODEMIRROR — see engine/chunkRegistry.ts (exportMode "star").
 * ---------------------------------------------------------------------------
 * The code/text viewer (viewers/text/cm.ts) pulls in 6 core @codemirror/* packages,
 * @lezer/highlight, and 14 @codemirror/lang-* packs — ~30 ms of startup V8 compile,
 * measured. Bundling them ALL here (one deduped chunk-codemirror.js) takes their
 * bytes out of vencordDesktopRenderer.js. esbuild dedupes the shared @codemirror/*
 * internals across the lang packs, so the chunk is far smaller than the sum.
 *
 * Each package is re-exported as a NAMED NAMESPACE so cm.ts reads the same module
 * surfaces it used to get from `await import("@codemirror/X")`:
 *   const mod = await loadLib("codemirror", …)   // the chunk namespace (exportMode star)
 *   const { EditorState } = mod.state             // was: await import("@codemirror/state")
 *   mod.langJavascript.javascript()               // was: (await import("@codemirror/lang-javascript"))
 * The renderer externalizes every one of these packages (chunkRegistry extraExternals),
 * so cm.ts has NO live bare import of them — only this chunk does.
 */

export * as state from "@codemirror/state";
export * as view from "@codemirror/view";
export * as language from "@codemirror/language";
export * as search from "@codemirror/search";
export * as merge from "@codemirror/merge";
export * as lezerHighlight from "@lezer/highlight";

export * as langJavascript from "@codemirror/lang-javascript";
export * as langJson from "@codemirror/lang-json";
export * as langPython from "@codemirror/lang-python";
export * as langCss from "@codemirror/lang-css";
export * as langHtml from "@codemirror/lang-html";
export * as langXml from "@codemirror/lang-xml";
export * as langMarkdown from "@codemirror/lang-markdown";
export * as langRust from "@codemirror/lang-rust";
export * as langCpp from "@codemirror/lang-cpp";
export * as langJava from "@codemirror/lang-java";
export * as langYaml from "@codemirror/lang-yaml";
export * as langSql from "@codemirror/lang-sql";
export * as langPhp from "@codemirror/lang-php";
export * as langGo from "@codemirror/lang-go";
