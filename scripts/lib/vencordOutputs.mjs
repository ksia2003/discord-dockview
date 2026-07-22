export const VENCORD_OUTPUT_FILES = Object.freeze([
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css"
]);

import { chunkFileNames } from "../chunkList.mjs";

export const DOCKVIEW_OUTPUT_FILES = Object.freeze([
    "dockviewMain.js",
    "dockviewRenderer.js",
    ...chunkFileNames(),
    "chunk-samples.js",
    "version.txt"
]);
