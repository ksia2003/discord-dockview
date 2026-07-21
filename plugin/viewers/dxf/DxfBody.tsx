/*
 * DXF placeholder Body.
 *
 * The DXF loader (DxfViewer.ts) renders the parsed drawing to a canvas, exports a
 * blob: PNG and RETYPES the content to "image" BEFORE any body renders — so the
 * dispatcher always routes a .dxf to the image viewer's Body, never here. The Viewer
 * contract still requires a `Body`, so this is a render-nothing placeholder (it is
 * never actually mounted). Kept as its own tiny module so DxfViewer.ts has no module-
 * top React access (the same deferral every viewer follows).
 */

export function DxfPlaceholderBody() {
    return null;
}
