/*
 * The viewer registry — the one place every file format is listed.
 *
 * As each viewer module is ported it adds itself here. The dock engine looks a
 * viewer up by ContentType and never imports a concrete viewer directly, so
 * adding a format touches exactly: the new viewers/<fmt>/ module, one entry
 * here, one extension mapping in engine/detectType.ts, and one in embed.ts.
 *
 * The MCP viewer is the one exception: it is NOT imported here. mcp/ is fully
 * isolated behind its settings toggle, so its mcpapp viewer is registered from
 * mcp/index.ts (maybeRegisterMcpViewer) — and ONLY when the bridge is enabled —
 * via the registerViewer hook below. This file must never statically import
 * McpViewer, or the parked feature would leak into the core graph.
 */

import type { ContentType, Viewer } from "../engine/types";

const VIEWERS = new Map<ContentType, Viewer>();

/** Register a viewer. Called once per format as its module is set up. */
export function registerViewer(viewer: Viewer): void {
    VIEWERS.set(viewer.type, viewer);
}

/** The viewer for a content type, or undefined if none is registered yet. */
export function getViewer(type: ContentType): Viewer | undefined {
    return VIEWERS.get(type);
}

/** Every registered viewer. makeWindow iterates these to build the per-window
 *  view-state map (one viewer.createState() slice per type); zero registered =
 *  an empty map, which the engine tolerates. */
export function allViewers(): Viewer[] {
    return [...VIEWERS.values()];
}

// Viewers are wired up here as they are ported (P3 onward). Kept as explicit
// registration calls rather than module-top imports so a viewer with an
// accidental top-level side effect can't take the whole registry down on load.

import { CodeViewer } from "./text/CodeViewer";
registerViewer(CodeViewer);

// pdf/ — the pdf.js page column (canvas + detached selectable text layer), with
// page nav / zoom / fit / drag-mode / find. The only viewer that needs dispose()
// (it releases the pdf.js doc on cache eviction).
import { PdfViewer } from "./pdf/PdfViewer";
registerViewer(PdfViewer);

import { ImageViewer } from "./image/ImageViewer";
registerViewer(ImageViewer);

// raster/ — TIFF / PSD / HEIC: the loader fetches the bytes, decodes per-format to
// RGBA (utif / @webtoon/psd / heic2any, each dynamic-imported), paints to a canvas,
// exports a blob: url and RETYPES to "image" so the image viewer surface renders it.
import { RasterImageViewer } from "./raster/RasterImageViewer";
registerViewer(RasterImageViewer);

// media/ — native <audio>/<video controls> that stream the attachment url directly
// (nothing to fetch/decode, like the image viewer); audio + video share one body.
import { AudioViewer, VideoViewer } from "./media/MediaViewer";
registerViewer(AudioViewer);
registerViewer(VideoViewer);

// csv/ — the spreadsheet grid (csv/tsv + xlsx-origin csv text), with a grid↔raw
// toggle whose raw view reuses the text CodeBody.
import { CsvViewer } from "./csv/CsvViewer";
registerViewer(CsvViewer);

// structured/ — the JSON/XML collapsible tree, with a tree↔raw toggle whose raw
// view reuses the text CodeBody.
import { StructuredViewer } from "./structured/StructuredViewer";
registerViewer(StructuredViewer);

// doc/ — the iframe family (markdown, self-contained html artifacts, docx, xlsx,
// mermaid, graphviz, ipynb). They share one dark sandboxed-iframe shell.
import { MarkdownViewer } from "./doc/MarkdownViewer";
registerViewer(MarkdownViewer);

import { HtmlViewer } from "./doc/HtmlViewer";
registerViewer(HtmlViewer);

import { DocxViewer } from "./doc/DocxViewer";
registerViewer(DocxViewer);

// rtf — the self-contained RTF→HTML transform (no deps) rendered through the same
// dark doc-iframe shell as docx.
import { RtfViewer } from "./doc/RtfViewer";
registerViewer(RtfViewer);

// odt — OpenDocument Text: fflate unzips the package and the ODF body XML is mapped
// to HTML (embedded pictures → data: URLs), rendered through the same shell.
import { OdtViewer } from "./doc/OdtViewer";
registerViewer(OdtViewer);

import { XlsxViewer } from "./doc/XlsxViewer";
registerViewer(XlsxViewer);

import { MermaidViewer } from "./doc/MermaidViewer";
registerViewer(MermaidViewer);

import { GraphvizViewer } from "./doc/GraphvizViewer";
registerViewer(GraphvizViewer);

import { IpynbViewer } from "./doc/IpynbViewer";
registerViewer(IpynbViewer);
