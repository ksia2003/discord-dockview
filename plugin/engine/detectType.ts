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
// OpenDocument Presentation (fflate unzip + ODF presentation XML -> per-slide HTML cards
// -> dark sandboxed iframe). Same ODF family as .odt: each <draw:page> slide's text-boxes
// are mapped through the SAME ODF→HTML core (viewers/doc/odp.ts reuses odt.ts). This is a
// legible flowed-outline preview, not a pixel-faithful slide layout. View-only.
export const ODP_EXT = new Set(["odp"]);
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
// -> dark sandboxed iframe). .eml is RFC 822/MIME text, parsed in the renderer.
export const EML_EXT = new Set(["eml"]);
// Outlook binary .msg (OLE/CFB) — postal-mime can't read it and @kenjiuno/msgreader
// needs Node Buffer (renderer-banned), so it's converted in the MAIN process: the msg
// viewer calls the convertAttachment("msg", url) IPC, gets back a clean HTML doc, and
// renders it through the SAME dark sandboxed iframe shell as .eml/docx. Routing type
// "msg"; the viewer feeds the returned HTML into that shell (no renderer-side parse).
export const MSG_EXT = new Set(["msg"]);
// Camera RAW (cr2/nef/dng/arw/raf/orf/rw2) — libraw-wasm's web Worker can't run in the
// electron main (Node) context, so the RAW viewer calls the convertAttachment("raw",
// url) IPC: MAIN extracts the embedded JPEG preview (or utif-decodes the IFD to a PNG)
// and returns the bytes; the viewer wraps them in a blob: url and RETYPES to "image"
// (like tiff/heic). Routing type "raw"; the viewer never decodes in the renderer.
export const RAW_EXT = new Set(["cr2", "nef", "dng", "arw", "raf", "orf", "rw2"]);
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
// raw camera (cr2/nef/dng/…) → the raw viewer (main-process decode); eps/ai → the
// PostScript viewer (Ghostscript-WASM in the renderer, see PS_EXT below); dicom → its own
// viewer. indd is NOT here — it needs a server-class reader and stays an "unknown" gap.
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
// DICOM medical images (.dcm/.dicom) — fetched as bytes, parsed by dicom-parser (inline),
// the pixel data + windowing metadata (Window Center/Width, Rescale Slope/Intercept,
// BitsAllocated, PixelRepresentation, PhotometricInterpretation) read in the renderer,
// rescaled + window/level-mapped to 8-bit grayscale RGBA, painted to a canvas, exported
// as a blob: url and RETYPED to "image" (so the image viewer's pan/zoom/fit/fullscreen
// render the slice). UNCOMPRESSED transfer syntaxes (Implicit/Explicit VR Little Endian,
// Explicit VR Big Endian) + RLE are decoded client-side; COMPRESSED ones (JPEG/JPEG2000/
// JPEG-LS) surface an honest "compressed DICOM not supported — download" notice rather
// than a heavy codec bundle. dicom-parser is small (~32 KB) but its source has a bare
// require("zlib") that Vencord's ban-imports rejects, so it ships as an out-of-bundle
// chunk (engine/chunkRegistry.ts), loaded on first .dcm open.
export const DICOM_EXT = new Set(["dcm", "dicom"]);
// PostScript / Illustrator (.eps, .ai) — converted to PDF and rendered by the EXISTING
// pdf.js viewer. The PostScript viewer (viewers/ps/) fetches the bytes and:
//   .ai  → MANY Illustrator files are PDF-compatible (they embed a full PDF stream), so
//          a `%PDF`-headed .ai routes STRAIGHT to the pdf viewer with no conversion
//          (zero new lib for the common case). A non-PDF .ai falls through to ↓.
//   .eps + non-PDF .ai → pure PostScript → Ghostscript-WASM (chunk-ghostscript.js, an
//          out-of-bundle chunk) converts PS → PDF IN THE RENDERER (CSP-safe instantiateWasm
//          hook, no Worker/native IPC — so the OTA reloads without a relaunch), then the
//          file retypes to "pdf" and the pdf surface (page nav/zoom/fit/find) renders it.
// Routing type "postscript"; the viewer retypes to "pdf" before any body mounts.
export const PS_EXT = new Set(["eps", "ai"]);
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
//   .odp  (OpenDocument Presentation) is NOT here — it's a different package the OOXML
//          model can't read, so it has its OWN viewer (ODP_EXT → the ODF→HTML transform).
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

// The Discord-owned domain family. ANY url on one of these hosts is Discord's own —
// in-app navigation (discord.com/channels, /shop, /store, /app, @me DMs…), its support/
// status sites, invites (discord.gg / discord.new / discord.gift), or a CDN/media asset.
// None of them may be pulled into the isolated web tab: app routes must stay native
// (React-router), and the CDN/support sites in the cookie-less partition would just
// demand a login. A file/media CDN url is already resolved by the extension branches
// ABOVE this point, so what's left on a Discord host here is navigation/chrome — never a
// page to browse. We deny the whole family by suffix rather than list individual paths,
// because Discord adds routes (/shop, /quest-home, …) faster than any allow-list tracks.
// The list is Discord's SEPARATE apex domains, not just subdomains of one — a suffix match
// on "discord.com" alone would miss sibling apexes like discordstatus.com or discord.co.
const DISCORD_HOST_SUFFIXES = [
    "discord.com", "discordapp.com", "discordapp.net", "discord.gg",
    "discord.media", "discord.dev", "discord.new", "discord.gift", "discord.gifts",
    "dis.gd", "discordstatus.com", "discord.co", "discordcdn.com", "discordapp.io",
    "discord.store", "discord.design"
];

/** Is `host` the Discord-owned domain, or any subdomain of it? */
function isDiscordHost(host: string): boolean {
    const h = host.toLowerCase();
    return DISCORD_HOST_SUFFIXES.some(d => h === d || h.endsWith("." + d));
}

/** Is `url` a real EXTERNAL http(s) web page — the target for a dock web tab? True only
 *  for a THIRD-PARTY http(s) host: anything Discord-owned stays native/native-chrome and
 *  never opens in the isolated tab. Callers reach this only after the file-extension
 *  branches have declined, so a dock-openable file/media url never counts as "web". */
function isWebPageUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    let u: URL;
    try {
        u = new URL(url, location.href);
    } catch {
        return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return !isDiscordHost(u.hostname);
}

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
    // .cr2/.nef/.dng/.arw/.raf/.orf/.rw2 -> the main process (convertAttachment IPC)
    // extracts the embedded JPEG preview (or utif-decodes to PNG); the raw viewer
    // wraps the returned bytes in a blob: url and retypes to "image". Checked alongside
    // the raster decoders so a RAW never falls through to the code/unknown path.
    if (ext && RAW_EXT.has(ext)) return "raw";
    // .dxf -> dxf-parser parses the drawing to an entity AST; the dxf loader draws it
    // to a high-res canvas and retypes to "image" (so the image viewer's pan/zoom/fit/
    // fullscreen render the engineering drawing). Checked alongside the raster decoders.
    if (ext && DXF_EXT.has(ext)) return "dxf";
    // .dcm/.dicom -> dicom-parser reads the pixel data + windowing metadata; the dicom
    // loader rescales + window/level-maps to grayscale RGBA, paints a canvas and retypes
    // to "image". Checked alongside the raster decoders so a DICOM never falls through to
    // the code/unknown path.
    if (ext && DICOM_EXT.has(ext)) return "dicom";
    // .eps/.ai -> the PostScript viewer fetches the bytes and either routes a PDF-compatible
    // .ai straight to pdf.js (%PDF sniff) or converts PS -> PDF with Ghostscript-WASM, then
    // retypes to "pdf" so the pdf surface renders it. Checked alongside the other
    // convert-then-retype decoders so a .eps/.ai never falls through to the code/unknown path.
    if (ext && PS_EXT.has(ext)) return "postscript";
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
    // .msg -> the main process (convertAttachment IPC) parses the binary Outlook
    // message and returns a clean HTML doc; the msg viewer feeds it into the same dark
    // sandboxed iframe shell as .eml. Checked before docx so it never falls through.
    if (ext && MSG_EXT.has(ext)) return "msg";
    // .docx -> mammoth converts to HTML, rendered through the markdown iframe shell.
    if (ext && DOCX_EXT.has(ext)) return "docx";
    // .rtf -> the self-contained rtf->HTML transform, rendered through the same shell.
    if (ext && RTF_EXT.has(ext)) return "rtf";
    // .odt -> fflate unzip + ODF XML -> HTML, rendered through the same shell.
    if (ext && ODT_EXT.has(ext)) return "odt";
    // .odp -> fflate unzip + ODF presentation XML -> per-slide HTML cards, same shell.
    if (ext && ODP_EXT.has(ext)) return "odp";
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
    // No dock-openable file/media extension matched. A real EXTERNAL http(s) web page
    // (not a Discord in-app navigation link, which stays native) opens as a web tab —
    // the browsing pillar. This is LAST so a file/media url is never mistaken for a
    // page. A non-http url (mailto:, blob:, data:, …) or a discord.com/channels route
    // stays "unknown" (untouched by the link path).
    if (isWebPageUrl(opts.url)) return "web";
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
