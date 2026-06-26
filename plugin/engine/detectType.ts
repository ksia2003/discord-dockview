/*
 * The single source of extension → content type.
 *
 * detectType() and every extension table live here. The dock router (showContent)
 * uses it to pick a viewer, and embed.ts imports the same tables so the chat-side
 * chip interception can never drift from what the panel actually renders. No
 * module-top React — pure data + string logic.
 */

import type { ContentType } from "./types";

// Extension -> highlight.js language id.
export const CODE_LANG: Record<string, string> = {
    txt: "plaintext", text: "plaintext", log: "plaintext",
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    py: "python", pyw: "python",
    json: "json", json5: "json",
    csv: "plaintext", tsv: "plaintext",
    css: "css", scss: "scss", less: "less",
    xml: "xml", svg: "xml", plist: "xml",
    yml: "yaml", yaml: "yaml",
    sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
    c: "c", h: "c",
    cpp: "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp", hxx: "cpp", hh: "cpp",
    java: "java", kt: "kotlin", kts: "kotlin",
    rs: "rust", go: "go", rb: "ruby", php: "php",
    sql: "sql", toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
    tex: "latex", lua: "lua",
    vue: "xml", svelte: "xml",
    swift: "swift", dart: "dart", scala: "scala", pl: "perl", pm: "perl",
    r: "r", m: "objectivec", makefile: "makefile", mk: "makefile",
    dockerfile: "dockerfile", gradle: "gradle", groovy: "groovy",
    diff: "diff", patch: "diff", env: "ini", properties: "ini"
};
// Extensions that are markdown.
export const MD_EXT = new Set(["md", "markdown", "mdown", "mkd"]);
// Word documents (mammoth -> HTML -> dark sandboxed iframe, view-only).
export const DOCX_EXT = new Set(["docx"]);
// Spreadsheets (SheetJS -> first sheet -> CSV text -> retyped to the csv grid).
export const XLSX_EXT = new Set(["xlsx", "xls"]);
// Mermaid diagram source (mermaid.render -> SVG -> dark sandboxed iframe).
export const MERMAID_EXT = new Set(["mmd", "mermaid"]);
// Graphviz / DOT source (viz-js renderString -> SVG -> dark sandboxed iframe).
export const GRAPHVIZ_EXT = new Set(["dot", "gv"]);
// Jupyter notebooks (JSON cells -> one HTML doc -> markdown dark sandboxed iframe).
export const IPYNB_EXT = new Set(["ipynb"]);
// JSON / XML structured data: rendered as an interactive collapsible TREE by
// default, with a Raw toggle back to the highlighted code view.
export const STRUCTURED_EXT = new Set(["json", "json5", "xml"]);
// Extensions rendered as an <img> (fit-width) in the panel instead of opening
// Discord's native lightbox.
export const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "apng", "avif"]);

/** Decide the content type from an explicit hint or the url/name extension. */
export function detectType(opts: { type?: ContentType; url?: string | null; name?: string | null }): ContentType {
    if (opts.type) return opts.type;
    const probe = (s?: string | null): string | null => {
        if (!s) return null;
        let path = s;
        try {
            path = new URL(s, location.href).pathname;
        } catch {
            /* keep raw */
        }
        const m = /\.([a-z0-9]+)(?:$|\?|#)/i.exec(path.split("/").pop() || "");
        return m ? m[1].toLowerCase() : null;
    };
    const ext = probe(opts.url) || probe(opts.name);
    if (ext === "pdf") return "pdf";
    if (ext && IMG_EXT.has(ext)) return "image";
    if (ext && MD_EXT.has(ext)) return "markdown";
    // .docx -> mammoth converts to HTML, rendered through the markdown iframe shell.
    if (ext && DOCX_EXT.has(ext)) return "docx";
    // .xlsx/.xls -> SheetJS reads it; the loader retypes to "csv" and feeds the grid.
    if (ext && XLSX_EXT.has(ext)) return "xlsx";
    // .mmd/.mermaid -> mermaid renders the diagram to SVG in a dark sandboxed iframe.
    if (ext && MERMAID_EXT.has(ext)) return "mermaid";
    // .dot/.gv -> viz-js (Graphviz WASM) renders the diagram to SVG in a dark iframe.
    if (ext && GRAPHVIZ_EXT.has(ext)) return "graphviz";
    // .ipynb -> the notebook cells are built into one HTML doc and rendered through
    // the markdown dark-iframe pipeline (view-only).
    if (ext && IPYNB_EXT.has(ext)) return "ipynb";
    // .json/.json5/.xml -> the interactive collapsible tree (with a Raw toggle back
    // to the highlighted code view). Checked BEFORE the CODE_LANG fallthrough so
    // these route to the tree, not the plain code viewer. (.svg stays image, .plist
    // stays code — only these three exts are intercepted.)
    if (ext && STRUCTURED_EXT.has(ext)) return "structured";
    // CSV / TSV -> the spreadsheet grid (with a header toggle back to raw text).
    if (ext === "csv" || ext === "tsv" || ext === "tab") return "csv";
    // ONLY genuine HTML-intent extensions take the iframe path. Everything else
    // unrecognised is "unknown" (sniffed text/binary at load) — NOT "html", so a
    // .xyz / binary file is never dumped raw into a sandbox iframe.
    // .artifact is TSX authoring source; delivery is self-contained .html now, so
    // show a stray .artifact as code — never feed bare TSX to the html iframe.
    if (ext === "artifact") return "code";
    if (ext === "html" || ext === "htm") return "html";
    if (ext && ext in CODE_LANG) return "code";
    return "unknown";
}

/** Resolve the hljs language id for an ext (default plaintext). */
export function codeLangFor(ext: string | null): string {
    return (ext && CODE_LANG[ext]) || "plaintext";
}

/** The lower-cased file extension of a url/name (path-aware, query/hash-stripped),
 *  or null. The same probe detectType uses, exported for the viewers that key off
 *  an extension (csv delimiter, structured json/xml kind). */
export function extOf(s: string | null | undefined): string | null {
    if (!s) return null;
    let path = s;
    try {
        path = new URL(s, location.href).pathname;
    } catch {
        /* keep raw */
    }
    const m = /\.([a-z0-9]+)(?:$|\?|#)/i.exec(path.split("/").pop() || "");
    return m ? m[1].toLowerCase() : null;
}
