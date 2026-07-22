/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Exact files owned by the unmodified official Vencord runtime. */
export const VENCORD_CORE_FILES = [
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css"
] as const;

/** Exact files owned and updated by DockView. */
export const DOCKVIEW_RUNTIME_FILES = [
    "dockviewMain.js",
    "dockviewRenderer.js",
    "chunk-mermaid.js",
    "chunk-agpsd.js",
    "chunk-jxl.js",
    "chunk-pptx.js",
    "chunk-dicomparser.js",
    "chunk-three.js",
    "chunk-ghostscript.js",
    "chunk-pdfjs.js",
    "chunk-codemirror.js",
    "chunk-samples.js",
    "version.txt"
] as const;
