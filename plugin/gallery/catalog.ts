/*
 * DockView Examples gallery — the catalog (single source of truth).
 * ---------------------------------------------------------------------------
 * One entry per VIEWER (not per extension): each names the format, the sample
 * fixture that demonstrates it, and a one-line "what this shows" caption. The
 * GallerySection UI renders these grouped by category; clicking an entry decodes
 * its fixture (from the on-demand chunk-samples.js) into a blob: URL and calls
 * __dockView.load({ name, url }) so the REAL viewer opens in the dock.
 *
 * The `file` of every entry MUST exist in plugin/gallery/samples/ (build-sample-chunk.mjs
 * base64-embeds that directory into chunk-samples.js, keyed by file name). The
 * fixture's extension is what routes it through engine/detectType — we deliberately
 * load via { name } so the dock's own detector picks the viewer, exactly as a real
 * attachment chip would.
 *
 * No React, no runtime deps — pure data, imported by ui/GallerySection.tsx.
 */

/** One gallery entry: a viewer + the fixture that exercises it. */
export interface SampleEntry {
    /** Display name of the format/viewer (e.g. "PowerPoint"). */
    label: string;
    /** The user-facing extension shown as a pill (e.g. "pptx"). */
    ext: string;
    /** Fixture file name in plugin/gallery/samples/ — also the `name` passed to
     *  load(), so detectType routes it to the right viewer. */
    file: string;
    /** One short line: what this sample demonstrates / what to try. */
    blurb: string;
}

/** A named group of entries, rendered as one section in the gallery. */
export interface SampleCategory {
    title: string;
    entries: SampleEntry[];
}

/** The catalog, grouped by category. Order = display order. */
export const SAMPLE_CATALOG: SampleCategory[] = [
    {
        title: "Documents",
        entries: [
            { label: "PDF", ext: "pdf", file: "example.pdf", blurb: "3-page PDF — page through it (PDF.js, lazy chunk)." },
            { label: "Word", ext: "docx", file: "example.docx", blurb: "Word document rendered to styled HTML (mammoth)." },
            { label: "Rich Text", ext: "rtf", file: "example.rtf", blurb: "RTF markup with bold, italic and colour." },
            { label: "OpenDocument Text", ext: "odt", file: "example.odt", blurb: "ODF text with headings and a list." }
        ]
    },
    {
        title: "Spreadsheets",
        entries: [
            { label: "Excel", ext: "xlsx", file: "example.xlsx", blurb: "Multi-sheet workbook — switch the Summary / Sales / Formulas tabs." },
            { label: "CSV", ext: "csv", file: "example.csv", blurb: "Comma-separated grid with a header-row toggle." }
        ]
    },
    {
        title: "Images",
        entries: [
            { label: "Image (PNG)", ext: "png", file: "example.png", blurb: "Raster image — fit to width, zoom, lightbox." },
            { label: "TIFF", ext: "tif", file: "example.tif", blurb: "TIFF decoded to a canvas (utif); multi-page TIFFs get a page selector." },
            { label: "HEIC", ext: "heic", file: "example.heic", blurb: "Apple HEIC decoded via libheif wasm (downloads on first open)." },
            { label: "Photoshop", ext: "psd", file: "example.psd", blurb: "PSD composite decoded to an image (ag-psd, any bit depth 8/16/32)." },
            { label: "Targa", ext: "tga", file: "example.tga", blurb: "Truevision TGA decoded to a canvas (tga-js), bottom-origin flipped upright." },
            { label: "Icon", ext: "ico", file: "example.ico", blurb: "Windows ICO — the largest frame is decoded and shown (icojs)." },
            { label: "JPEG 2000", ext: "jp2", file: "example.jp2", blurb: "JPEG 2000 decoded to a canvas (pdf.js JpxImage port)." },
            { label: "JPEG XL", ext: "jxl", file: "example.jxl", blurb: "JPEG XL decoded via libjxl wasm (@jsquash/jxl, lazy chunk — wasm handed in, no fetch)." }
        ]
    },
    {
        title: "CAD",
        entries: [
            { label: "AutoCAD DXF", ext: "dxf", file: "example.dxf", blurb: "2D CAD drawing (dxf-parser) rendered to a canvas — pan, zoom and fit the drawing." }
        ]
    },
    {
        title: "Code & Text",
        entries: [
            { label: "Code", ext: "py", file: "example.py", blurb: "Syntax-highlighted Python source." },
            { label: "Markdown", ext: "md", file: "example.md", blurb: "GitHub-flavoured Markdown — headings, table, code fence." },
            { label: "HTML artifact", ext: "html", file: "example.html", blurb: "Self-contained interactive artifact — click the button inside." },
            { label: "JSON", ext: "json", file: "example.json", blurb: "Structured data as a collapsible tree (Raw toggle available)." }
        ]
    },
    {
        title: "Diagrams",
        entries: [
            { label: "Mermaid", ext: "mmd", file: "example.mmd", blurb: "Mermaid flowchart rendered to SVG (lazy chunk)." },
            { label: "Graphviz", ext: "dot", file: "example.dot", blurb: "Graphviz DOT rendered to SVG (viz-js wasm)." },
            { label: "Jupyter", ext: "ipynb", file: "example.ipynb", blurb: "Notebook cells (markdown + code + output) as one document." }
        ]
    },
    {
        title: "Media",
        entries: [
            { label: "Audio", ext: "mp3", file: "example.mp3", blurb: "Short MP3 with native audio controls." },
            { label: "Video", ext: "mp4", file: "example.mp4", blurb: "Short MP4 with native video controls." }
        ]
    },
    {
        title: "3D",
        entries: [
            { label: "glTF binary", ext: "glb", file: "example.glb", blurb: "glTF cube — orbit, pan and zoom (three.js, lazy chunk)." },
            { label: "Wavefront OBJ", ext: "obj", file: "example.obj", blurb: "ASCII OBJ cube — orbit the model (three.js)." }
        ]
    },
    {
        title: "Presentation",
        entries: [
            { label: "PowerPoint", ext: "pptx", file: "example.pptx", blurb: "3-slide deck — step through slides (pptx renderer, lazy chunk)." }
        ]
    },
    {
        title: "Email",
        entries: [
            { label: "Email", ext: "eml", file: "example.eml", blurb: "MIME message (postal-mime) — header card, HTML body, attachment; remote images blocked." }
        ]
    }
];

/** Flattened list of every fixture file the catalog references — used to assert at
 *  load time that the chunk supplied each one. */
export function catalogFiles(): string[] {
    return SAMPLE_CATALOG.flatMap(c => c.entries.map(e => e.file));
}
