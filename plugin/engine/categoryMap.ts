/*
 * The single source of truth mapping every ContentType the dock renders to a
 * user-facing VIEWER CATEGORY. The Viewers settings page exposes one on/off switch
 * per category; embed.ts consults categoryEnabled(type) before it intercepts a chip,
 * so an OFF category's files fall back to stock Discord (download / lightbox) and
 * never open the dock — the gate sits in the DETECTION path, so an off category never
 * half-renders.
 *
 * WHY MAP THE ContentType, NOT THE EXTENSION. detectType() already collapses the
 * scattered extension tables into one ContentType per file (a .tiff and a .psd are
 * both "rasterimage"; every 3D ext is "model3d"). Categorising the ContentType keeps
 * this one small map instead of re-listing every extension — and it CAN'T drift from
 * what the panel actually renders, because it keys off the very type the router uses.
 *
 * EXHAUSTIVE BY CONSTRUCTION. CATEGORY_OF maps every ContentType except "unknown"
 * (never intercepted) and "mcpapp" (the parked MCP surface, not a file viewer). The
 * `satisfies` check below makes the compiler reject the map if a NEW ContentType is
 * added without a category — so adding a format forces a category decision here.
 */

import { settings } from "../settings";
import type { ContentType } from "./types";

/** The user-facing viewer categories (the Viewers settings switches). The key is the
 *  settings store field (`viewer<Category>`); the order here is the display order. */
export type ViewerCategory =
    | "documents"
    | "spreadsheets"
    | "images"
    | "exoticImages"
    | "codeText"
    | "diagrams"
    | "models3d"
    | "media"
    | "presentations";

/** ContentTypes that are never chip-intercepted, so they need no category: "unknown"
 *  (stock Discord already) and "mcpapp" (the parked MCP widget surface, not a file). */
type UncategorisedType = "unknown" | "mcpapp";

/** Every rendered ContentType → its category. Representative formats per category:
 *   - documents      pdf, docx, rtf, odt, html, eml, msg, xml, md, ipynb
 *   - spreadsheets   xlsx, xls, xlsm, ods, csv, tsv
 *   - images         png, jpg, gif, webp, svg, avif, bmp, apng, ico, tga
 *   - exoticImages   tiff, heic, psd, dxf, dicom, camera raw, jxl, jp2, eps, ai
 *   - codeText       source files, logs, plain text, json/json5 trees
 *   - diagrams       mermaid, graphviz
 *   - models3d       obj, stl, ply, fbx, dae, 3ds, glb, gltf
 *   - media          audio & video
 *   - presentations  pptx, odp
 *
 *  Judgment calls (documented for the record):
 *   - "structured" (json/json5/xml tree) → codeText. XML is listed under Documents in
 *     the spec's format hint, but the dock renders json/json5/xml through the SAME
 *     interactive tree/code surface, so they belong with code & text as one control.
 *   - "html" → documents (a self-contained page previewed in the doc iframe shell,
 *     alongside docx/rtf/odt/eml/msg).
 *   - "rasterimage" / "dxf" / "dicom" / "raw" / "postscript" → exoticImages. These are
 *     the heavy/format-exotic image decoders (tiff/heic/psd, CAD, medical, camera raw,
 *     eps/ai); the everyday raster + vector web formats stay in "images".
 *   - "ipynb" → documents (a rendered notebook document, not editable code here). */
export const CATEGORY_OF = {
    // Documents.
    pdf: "documents",
    docx: "documents",
    rtf: "documents",
    odt: "documents",
    html: "documents",
    email: "documents",
    msg: "documents",
    ipynb: "documents",
    // Spreadsheets (csv/tsv route to "csv"; xlsx/xls/xlsm/ods route to "xlsx").
    xlsx: "spreadsheets",
    csv: "spreadsheets",
    // Images — the everyday raster + vector formats rendered as a plain <img>.
    image: "images",
    // Exotic images — the format-exotic decoders (tiff/heic/psd, CAD, medical, RAW,
    // PostScript) that decode-then-retype to an image surface.
    rasterimage: "exoticImages",
    dxf: "exoticImages",
    dicom: "exoticImages",
    raw: "exoticImages",
    postscript: "exoticImages",
    // Code & text — source/log/plain text + the json/json5/xml structured tree.
    code: "codeText",
    markdown: "codeText",
    structured: "codeText",
    // Diagrams.
    mermaid: "diagrams",
    graphviz: "diagrams",
    // 3D models.
    model3d: "models3d",
    // Media (audio + video).
    audio: "media",
    video: "media",
    // Presentations (pptx + odp).
    pptx: "presentations",
    odp: "presentations"
} satisfies Record<Exclude<ContentType, UncategorisedType>, ViewerCategory>;

/** The category a ContentType belongs to, or null for the never-intercepted types
 *  ("unknown" / "mcpapp"). */
export function categoryOf(type: ContentType): ViewerCategory | null {
    return (CATEGORY_OF as Record<string, ViewerCategory>)[type] ?? null;
}

/** The settings-store boolean key backing each category's on/off switch. */
const CATEGORY_SETTING: Record<ViewerCategory, string> = {
    documents: "viewerDocuments",
    spreadsheets: "viewerSpreadsheets",
    images: "viewerImages",
    exoticImages: "viewerExoticImages",
    codeText: "viewerCodeText",
    diagrams: "viewerDiagrams",
    models3d: "viewerModels3d",
    media: "viewerMedia",
    presentations: "viewerPresentations"
};

/** Whether the dock should intercept a chip resolving to `type`, read LIVE from the
 *  settings store so a toggle applies to the next chip click with no reload. Two gates:
 *  the MASTER switch (all interception) and the file's CATEGORY switch. An unmapped
 *  type ("unknown" never reaches here; "mcpapp" isn't a chip) is treated as enabled so
 *  a future type isn't silently swallowed before it gets a category. */
export function viewerEnabled(type: ContentType): boolean {
    try {
        if (!settings.store.viewersMaster) return false;
        const cat = categoryOf(type);
        if (!cat) return true;
        return (settings.store as Record<string, any>)[CATEGORY_SETTING[cat]] !== false;
    } catch {
        // Settings not resolved yet (very early boot) — default to intercepting, the
        // pre-settings behaviour.
        return true;
    }
}
