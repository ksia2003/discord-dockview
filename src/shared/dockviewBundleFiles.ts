/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Exact runtime files in a complete bundled DockView/Vencord distribution.
 * A unit test keeps this app-domain list aligned with the plugin build registry. */
export const DOCKVIEW_VENCORD_CORE_FILES = [
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css"
] as const;

export const DOCKVIEW_VENCORD_BUNDLE_FILES = [
    ...DOCKVIEW_VENCORD_CORE_FILES,
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
