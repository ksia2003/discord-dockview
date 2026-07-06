/*
 * Out-of-bundle CHUNK REGISTRY — the single source of truth for which heavy libs
 * ship as separate on-disk chunk files instead of inline in vencordDesktopRenderer.js.
 *
 * WHY (measured, see lazyLib.ts header for the full story)
 * -------------------------------------------------------
 * Vencord builds the renderer as ONE esbuild IIFE with no code-splitting, so a
 * dynamic import() defers a lib's EXECUTION but its bytes still ship inline and
 * cost V8 compile at every Vesktop startup. For CODE-DENSE libs (mermaid, pptx,
 * codemirror, pdfjs, three) that compile cost is the startup bottleneck and is
 * removable ONLY by taking the bytes out of the bundle. So those libs are built
 * as standalone chunk files (chunk-<lib>.js) and loaded on first use over an IPC
 * disk read + eval (CSP allows 'unsafe-eval'; Vencord patches it in). DATA/wasm
 * libs (heic2any, viz, highlight.js) gain ~0 ms from byte removal — they stay
 * INLINE (a base64/data literal isn't function code V8 pre-parses), so they are
 * NOT listed here.
 *
 * THE CONTRACT THIS REGISTRY ENCODES
 * ----------------------------------
 *   key      — the stable string a viewer passes to withLibLoading()/loadLib()
 *              (usually the npm package name). loadLib() routes this key to the
 *              chunk path instead of the inline importer.
 *   pkg      — the npm package the chunk bundles. The release/dev build emits
 *              chunk-<chunkId>.js from an entry that imports this package, AND
 *              marks it `external` in the renderer bundle so its bytes leave.
 *   chunkId  — the chunk file is `chunk-<chunkId>.js`. Kept separate from the key
 *              so a scoped/path key (e.g. "@aiden0z/pptx-renderer") maps to a
 *              filesystem-safe name.
 *   exportMode — how the chunk entry re-exports the package so the eval'd module
 *              hands back the same shape the inline `import("pkg")` would:
 *                "default" → the viewer used `(await import("pkg")).default`
 *                "star"    → the viewer used the whole module namespace
 *
 * THIS FILE IS READ BY:
 *   - engine/lazyLib.ts          (runtime chunk branch — imports CHUNKS)
 *   - scripts build glue (.mjs)  (externalize + chunk-emit + OTA manifest). The
 *     .mjs scripts can't import a .ts, so they parse the CHUNKS array out of this
 *     file's source text with a regex (see scripts/chunkList.mjs). The array
 *     literal below is therefore kept in a SIMPLE, regex-friendly shape: one
 *     object per line inside a top-level `export const CHUNKS = [ ... ]`.
 */

/** One chunked heavy library. See the module header for field semantics. */
export interface ChunkSpec {
    /** withLibLoading()/loadLib() key the viewer already passes. */
    key: string;
    /** npm package the chunk bundles. For a curated multi-package chunk (entryFile
     *  set) this is the PRIMARY package; the renderer externalizes it AND its
     *  subpaths (e.g. "three" also externalizes "three/examples/..."). A chunk that
     *  pulls a SECOND top-level package needs that package listed too — see
     *  extraExternals. */
    pkg: string;
    /** chunk file is `chunk-<chunkId>.js`. */
    chunkId: string;
    /** How the chunk's exports are unwrapped for the viewer:
     *   "default" → return the chunk's default export (viewer used (await import).default)
     *   "star"    → return the chunk's whole namespace object (viewer used the module,
     *               or a curated entry whose default + named exports the viewer destructures) */
    exportMode: "default" | "star";
    /** Optional curated entry, RELATIVE to plugin/ (e.g. "engine/chunks/three.entry.ts").
     *  When set, the chunk bundles THIS module instead of the bare `pkg`, so it can
     *  gather a package + its subpaths/loaders into one deduped chunk. */
    entryFile?: string;
    /** Extra packages the chunk's entryFile imports at a SEPARATE top level (besides
     *  pkg + its subpaths) that the renderer must ALSO externalize. */
    extraExternals?: string[];
}

/*
 * The chunked libs. ⚠️ scripts/chunkList.mjs parses THIS literal by regex — keep
 * every entry on ONE line as `{ key: "..", pkg: "..", chunkId: "..", exportMode: ".." },`
 * so the build glue and the runtime never drift.
 */
export const CHUNKS: ChunkSpec[] = [
    { key: "mermaid", pkg: "mermaid", chunkId: "mermaid", exportMode: "default" },
    { key: "ag-psd", pkg: "ag-psd", chunkId: "agpsd", exportMode: "star", entryFile: "engine/chunks/agpsd.entry.ts" },
    { key: "jxl", pkg: "@jsquash/jxl", chunkId: "jxl", exportMode: "star", entryFile: "engine/chunks/jxl.entry.ts" },
    { key: "pptx-renderer", pkg: "@aiden0z/pptx-renderer", chunkId: "pptx", exportMode: "star" },
    { key: "dicom-parser", pkg: "dicom-parser", chunkId: "dicomparser", exportMode: "star" },
    { key: "three", pkg: "three", chunkId: "three", exportMode: "star", entryFile: "engine/chunks/three.entry.ts" },
    { key: "ghostscript", pkg: "@jspawn/ghostscript-wasm", chunkId: "ghostscript", exportMode: "star", entryFile: "engine/chunks/ghostscript.entry.ts" },
    { key: "pdfjs", pkg: "pdfjs-dist", chunkId: "pdfjs", exportMode: "star", entryFile: "engine/chunks/pdfjs.entry.ts" },
    { key: "rnnoise", pkg: "@timephy/rnnoise-wasm", chunkId: "rnnoise", exportMode: "star", entryFile: "engine/chunks/rnnoise.entry.ts" },
    {
        key: "codemirror", pkg: "@codemirror/state", chunkId: "codemirror", exportMode: "star",
        entryFile: "engine/chunks/codemirror.entry.ts",
        extraExternals: [
            "@codemirror/view", "@codemirror/language", "@codemirror/search", "@codemirror/merge", "@lezer/highlight",
            "@codemirror/lang-javascript", "@codemirror/lang-json", "@codemirror/lang-python", "@codemirror/lang-css",
            "@codemirror/lang-html", "@codemirror/lang-xml", "@codemirror/lang-markdown", "@codemirror/lang-rust",
            "@codemirror/lang-cpp", "@codemirror/lang-java", "@codemirror/lang-yaml", "@codemirror/lang-sql",
            "@codemirror/lang-php", "@codemirror/lang-go"
        ]
    },
];

/** Lookup by the viewer's loadLib key. undefined ⇒ the lib stays inline. */
export const CHUNK_BY_KEY: Map<string, ChunkSpec> = new Map(CHUNKS.map(c => [c.key, c]));

/** The chunk file name for a key, or null if the key is not chunked. */
export function chunkFileFor(key: string): string | null {
    const spec = CHUNK_BY_KEY.get(key);
    return spec ? `chunk-${spec.chunkId}.js` : null;
}
