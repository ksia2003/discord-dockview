/*
 * Browser stub for node's `util`, used ONLY by the chunk build (build-chunks.mjs).
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ag-psd references `require('util').inspect(...)` inside a handful of DEBUG-only
 * console.log paths (dead unless a debug flag is set). esbuild must still RESOLVE
 * that import to bundle the chunk for the browser; node's `util` has no browser
 * resolution, so the chunk build aliases `util` to this no-op stub. Only `inspect`
 * is referenced; it returns "" so the (unreached) debug logs degrade harmlessly.
 */

export function inspect() {
    return "";
}

export default { inspect };
