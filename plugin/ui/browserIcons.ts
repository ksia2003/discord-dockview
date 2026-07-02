/*
 * Category glyphs for the file browser's type-filter chips.
 *
 * The Viewers settings page has NO per-category icon (it's a text-only switch list),
 * but the file entries themselves already carry a ContentType, and toolbar.tsx's
 * FILE_TYPE_ICON maps every ContentType to a glyph. So a category's chip just borrows
 * the glyph of one REPRESENTATIVE ContentType in that category — the same silhouette
 * the file's own card/tab uses — keeping the chip and its files visually consistent
 * with the rest of the dock without inventing a second icon set.
 *
 * PLAIN DATA + lazy build: this maps categories → a representative ContentType (no
 * React at module top, per the panel.tsx rule); categoryGlyphPaths() defers to
 * toolbar.tsx's iconPaths() at call time.
 */

import type { ViewerCategory } from "../engine/categoryMap";
import type { ContentType } from "../engine/types";
import { iconPaths } from "./toolbar";

/** The ContentType whose FILE_TYPE_ICON glyph stands in for each category chip. */
const CATEGORY_ICON_TYPE: Record<ViewerCategory, ContentType> = {
    documents: "pdf",
    spreadsheets: "xlsx",
    images: "image",
    exoticImages: "rasterimage",
    codeText: "code",
    diagrams: "mermaid",
    models3d: "model3d",
    media: "video",
    presentations: "pptx"
};

/** The <path> elements for a category chip's glyph (lazy — React is ready at call
 *  time), borrowed from the representative ContentType's FILE_TYPE_ICON entry. */
export function categoryGlyphPaths(cat: ViewerCategory): any[] {
    return iconPaths(CATEGORY_ICON_TYPE[cat]);
}
