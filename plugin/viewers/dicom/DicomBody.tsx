/*
 * DICOM placeholder Body.
 *
 * The DICOM loader (DicomViewer.ts) decodes the pixel data, applies rescale +
 * window/level to an offscreen <canvas>, exports a blob: PNG and RETYPES the content
 * to "image" BEFORE any body renders — so the dispatcher always routes a .dcm to the
 * image viewer's Body, never here. The Viewer contract still requires a `Body`, so
 * this is a render-nothing placeholder (it is never actually mounted). Kept as its own
 * tiny module so DicomViewer.ts has no module-top React access (the same deferral every
 * viewer follows).
 */

export function DicomPlaceholderBody() {
    return null;
}
