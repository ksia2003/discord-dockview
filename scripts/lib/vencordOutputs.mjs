import { chunkFileNames } from "../chunkList.mjs";

export const VENCORD_OUTPUT_FILES = Object.freeze([
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css",
    ...chunkFileNames(),
    "chunk-samples.js",
    "version.txt"
]);
