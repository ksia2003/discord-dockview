/*
 * PostScript placeholder Body.
 *
 * The PostScript loader (PsViewer.ts) either sniffs a PDF-compatible .ai or runs
 * Ghostscript-WASM to convert EPS / non-PDF .ai → PDF, wraps the PDF in a blob: url and
 * RETYPES the content to "pdf" BEFORE any body renders — so the dispatcher always routes
 * a PostScript file to the pdf viewer's Body, never here. The Viewer contract still
 * requires a `Body`, so this is a render-nothing placeholder (it is never actually
 * mounted). Kept as its own tiny module so PsViewer.ts has no module-top React access
 * (the same deferral every viewer follows).
 */

export function PsPlaceholderBody() {
    return null;
}
