/*
 * RAW placeholder Body.
 *
 * The RAW loader (RawViewer.ts) asks the MAIN process to decode the camera RAW, wraps
 * the returned image bytes in a blob: url and RETYPES the content to "image" BEFORE any
 * body renders — so the dispatcher always routes a RAW to the image viewer's Body,
 * never here. The Viewer contract still requires a `Body`, so this is a render-nothing
 * placeholder (it is never actually mounted). Kept as its own tiny module so
 * RawViewer.ts has no module-top React access (the same deferral every viewer follows).
 */

export function RawPlaceholderBody() {
    return null;
}
