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
// Rich Text Format (self-contained rtf->HTML transform -> dark sandboxed iframe).
// .rtf is text markup, NOT the legacy binary .doc (which mammoth can't read and is
// left a gap). View-only.
export const RTF_EXT = new Set(["rtf"]);
// OpenDocument Text (fflate unzip + ODF XML -> HTML -> dark sandboxed iframe).
// .fodt (flat single-XML ODF) is NOT here — it's a different container the unzip
// path can't read, so it stays a gap rather than falsely routing. View-only.
export const ODT_EXT = new Set(["odt"]);
// Spreadsheets (SheetJS -> first sheet -> CSV text -> retyped to the csv grid).
// SheetJS reads xlsm (macro-enabled OOXML) and ods (OpenDocument) natively too,
// so they ride the same xlsx pipeline. (.numbers is NOT here — Apple iWork is not
// readable by SheetJS; it would falsely route and render empty, so leave it a gap.)
export const XLSX_EXT = new Set(["xlsx", "xls", "xlsm", "ods"]);
// Mermaid diagram source (mermaid.render -> SVG -> dark sandboxed iframe).
export const MERMAID_EXT = new Set(["mmd", "mermaid"]);
// Graphviz / DOT source (viz-js renderString -> SVG -> dark sandboxed iframe).
export const GRAPHVIZ_EXT = new Set(["dot", "gv"]);
// Jupyter notebooks (JSON cells -> one HTML doc -> markdown dark sandboxed iframe).
export const IPYNB_EXT = new Set(["ipynb"]);
// Email / MIME messages (postal-mime parse -> header block + body + attachment list
// -> dark sandboxed iframe). .eml is RFC 822/MIME text; Outlook's binary .msg is a
// different OLE container postal-mime can't read, so it stays a gap (Wave 2 native).
export const EML_EXT = new Set(["eml"]);
// JSON / XML structured data: rendered as an interactive collapsible TREE by
// default, with a Raw toggle back to the highlighted code view.
export const STRUCTURED_EXT = new Set(["json", "json5", "xml"]);
// Extensions rendered as an <img> (fit-width) in the panel instead of opening
// Discord's native lightbox.
export const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "apng", "avif"]);
// Raster formats the browser can't put in <img src> directly: they are fetched as
// bytes, decoded per-format to RGBA, painted to a canvas and exported as a blob:
// url, then RETYPED to "image" so the whole image UX (fit/zoom/lightbox) is reused
// — the same decode→retype trick the xlsx loader uses to reach the csv grid.
//   tiff/tif  -> utif (multi-page TIFFs keep a "rasterimage" surface w/ a page selector;
//                single-page retypes to image)
//   psd       -> ag-psd (the composited/flattened image, any bit depth 8/16/32)
//   heic/heif -> heic2any (libheif wasm, dynamic-imported so the wasm only
//                downloads when a HEIC is actually opened)
//   tga       -> tga-js (Truevision Targa → RGBA; we flip bottom-origin files
//                ourselves since tga-js leaves them upside-down)
//   ico/cur   -> icojs (multi-frame icon → we pick the largest frame's PNG bytes)
//   jp2/jpx/j2k/j2c -> jpeg2000 (pdf.js JpxImage → component planes → RGBA)
//   jxl       -> @jsquash/jxl (libjxl wasm → RGBA; the codec + its 849 KB wasm ship
//                as an out-of-bundle chunk loaded on first .jxl open, and the wasm is
//                handed to the codec directly so it never fetches — CSP-safe)
// raw camera (cr2/nef/dng/…), eps/ai, dicom and indd are NOT here — they need
// server-side conversion and stay "unknown" gaps until a download-fallback batch.
export const RASTER_IMG_EXT = new Set([
    "tiff", "tif", "psd", "heic", "heif",
    "tga", "ico", "cur", "jp2", "jpx", "j2k", "j2c", "jxl"
]);
// CAD drawings (AutoCAD DXF) — fetched as text, parsed by dxf-parser to an entity AST,
// drawn to a canvas at high resolution (a hand-rolled 2D pass over lines/arcs/circles/
// polylines/ellipses/splines/text, blocks expanded for INSERTs), exported as a blob:
// url and RETYPED to "image" so the whole image UX (fit/zoom/pan/lightbox) renders the
// drawing. dxf-parser is small + text-only, so it ships INLINE (dynamic-imported off
// startup). The binary .dwg twin is NOT here — it needs a different (server-class)
// reader and stays an "unknown" gap rather than falsely routing.
export const DXF_EXT = new Set(["dxf"]);
// 3D models — fetched as text/bytes, parsed by the matching three.js loader, added
// to a Scene and rendered to a WebGLRenderer canvas with OrbitControls. three.js +
// its loaders are DYNAMIC-imported (off Vesktop startup) inside the viewer.
//   obj        -> OBJLoader   (text; .mtl sibling rarely present → default material)
//   stl        -> STLLoader   (ascii or binary)
//   ply        -> PLYLoader   (ascii or binary)
//   fbx        -> FBXLoader   (binary or ascii)
//   dae        -> ColladaLoader (XML)
//   3ds        -> TDSLoader   (binary)
//   gltf/glb   -> GLTFLoader  (common, high-value — three's best-supported format)
// .box3d (proprietary Box format) is NOT here — it needs Box's own runtime and stays
// a gap rather than falsely routing.
export const MODEL3D_EXT = new Set(["obj", "stl", "ply", "fbx", "dae", "3ds", "gltf", "glb"]);
// PowerPoint (Office Open XML presentation) — the @aiden0z/pptx-renderer parses the
// .pptx ZIP (slide XML + media) and renders each slide to positioned HTML/SVG in a
// live container, with slide navigation. Dynamic-imported (off Vesktop startup) inside
// the viewer. ONLY the modern OOXML .pptx is here:
//   .ppt  (legacy binary OLE/CFB) needs a different, server-class parser → gap.
//   .odp  (OpenDocument Presentation) is a different package the OOXML model can't
//          read → gap (would falsely route + render empty).
//   .key  (Apple Keynote) is proprietary iWork → gap.
//   .gslides / Google Slides has no standalone file → gap.
// Leaving those "unknown" surfaces the honest download fallback rather than a broken
// render.
export const PPTX_EXT = new Set(["pptx"]);
// Audio — played by a native <audio controls> (the element streams the url directly).
// HTML5-playable containers only; an unplayable one surfaces a download fallback.
export const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "weba"]);
// Video — played by a native <video controls>. ".ts" is deliberately NOT here (it is
// TypeScript in a dev context, not an MPEG transport stream). ".mov" usually plays.
export const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "ogv", "mov"]);

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
    // .tiff/.tif/.psd/.heic/.heif -> decoded to RGBA, painted to a canvas, exported
    // as a blob: url and retyped to "image" by the rasterimage loader. Checked right
    // after IMG_EXT so these never fall through to the code/unknown paths.
    if (ext && RASTER_IMG_EXT.has(ext)) return "rasterimage";
    // .dxf -> dxf-parser parses the drawing to an entity AST; the dxf loader draws it
    // to a high-res canvas and retypes to "image" (so the image viewer's pan/zoom/fit/
    // fullscreen render the engineering drawing). Checked alongside the raster decoders.
    if (ext && DXF_EXT.has(ext)) return "dxf";
    // .obj/.stl/.ply/.fbx/.dae/.3ds/.gltf/.glb -> the three.js loader parses the bytes
    // into a Scene rendered on a WebGLRenderer canvas with OrbitControls. Checked
    // before the media/code paths so a model never falls through to a raw dump.
    if (ext && MODEL3D_EXT.has(ext)) return "model3d";
    // .pptx -> the @aiden0z/pptx-renderer parses the OOXML ZIP and renders each slide
    // to positioned HTML/SVG in a live container, with prev/next slide nav. Checked
    // before the media/code paths so a presentation never falls through to a raw dump.
    if (ext && PPTX_EXT.has(ext)) return "pptx";
    // Media — a native <audio>/<video controls> streams the attachment url directly.
    if (ext && AUDIO_EXT.has(ext)) return "audio";
    if (ext && VIDEO_EXT.has(ext)) return "video";
    if (ext && MD_EXT.has(ext)) return "markdown";
    // .docx -> mammoth converts to HTML, rendered through the markdown iframe shell.
    if (ext && DOCX_EXT.has(ext)) return "docx";
    // .rtf -> the self-contained rtf->HTML transform, rendered through the same shell.
    if (ext && RTF_EXT.has(ext)) return "rtf";
    // .odt -> fflate unzip + ODF XML -> HTML, rendered through the same shell.
    if (ext && ODT_EXT.has(ext)) return "odt";
    // .xlsx/.xls/.xlsm/.ods -> SheetJS reads it; the loader retypes to "csv" and feeds the grid.
    if (ext && XLSX_EXT.has(ext)) return "xlsx";
    // .mmd/.mermaid -> mermaid renders the diagram to SVG in a dark sandboxed iframe.
    if (ext && MERMAID_EXT.has(ext)) return "mermaid";
    // .dot/.gv -> viz-js (Graphviz WASM) renders the diagram to SVG in a dark iframe.
    if (ext && GRAPHVIZ_EXT.has(ext)) return "graphviz";
    // .ipynb -> the notebook cells are built into one HTML doc and rendered through
    // the markdown dark-iframe pipeline (view-only).
    if (ext && IPYNB_EXT.has(ext)) return "ipynb";
    // .eml -> postal-mime parses the MIME message; the loader builds a header block +
    // body + attachment list into one HTML doc and renders it through the same dark
    // sandboxed iframe (remote images are NOT auto-loaded — view-only, sandboxed).
    if (ext && EML_EXT.has(ext)) return "email";
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
