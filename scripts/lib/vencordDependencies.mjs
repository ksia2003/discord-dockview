/*
 * Exact versions injected into the pinned Vencord checkout for DockView.
 * Keep these explicit: package-name-only `pnpm add` made identical candidate
 * builds resolve different registry versions minutes apart.
 */
export const VENCORD_DEPENDENCIES = Object.freeze({
    "@aiden0z/pptx-renderer": "1.2.4",
    "@codemirror/lang-cpp": "6.0.3",
    "@codemirror/lang-css": "6.3.1",
    "@codemirror/lang-go": "6.0.1",
    "@codemirror/lang-html": "6.4.11",
    "@codemirror/lang-java": "6.0.2",
    "@codemirror/lang-javascript": "6.2.5",
    "@codemirror/lang-json": "6.0.2",
    "@codemirror/lang-markdown": "6.5.1",
    "@codemirror/lang-php": "6.0.2",
    "@codemirror/lang-python": "6.2.1",
    "@codemirror/lang-rust": "6.0.2",
    "@codemirror/lang-sql": "6.10.0",
    "@codemirror/lang-xml": "6.1.0",
    "@codemirror/lang-yaml": "6.1.3",
    "@codemirror/language": "6.12.4",
    "@codemirror/merge": "6.12.2",
    "@codemirror/search": "6.7.1",
    "@codemirror/state": "6.7.1",
    "@codemirror/view": "6.43.6",
    "@jspawn/ghostscript-wasm": "0.0.2",
    "@jsquash/jxl": "1.3.0",
    "@kenjiuno/decompressrtf": "0.1.4",
    "@kenjiuno/msgreader": "1.28.0",
    "@lezer/highlight": "1.2.3",
    "@viz-js/viz": "3.28.0",
    "ag-psd": "31.0.2",
    "dicom-parser": "1.8.21",
    "dxf-parser": "1.1.2",
    fflate: "0.8.3",
    heic2any: "0.0.4",
    "highlight.js": "11.11.1",
    icojs: "1.0.0",
    jpeg2000: "1.1.1",
    katex: "0.18.1",
    lzutf8: "0.6.3",
    mammoth: "1.12.0",
    marked: "18.0.6",
    mermaid: "11.16.0",
    "pdfjs-dist": "6.1.200",
    "postal-mime": "2.7.5",
    "tga-js": "1.1.1",
    three: "0.185.1",
    utif: "3.1.0",
    xlsx: "0.18.5"
});

export function dependencySpecs(derivedDependencies) {
    const derived = [...derivedDependencies].sort();
    const pinned = Object.keys(VENCORD_DEPENDENCIES).sort();
    const missing = derived.filter(name => !(name in VENCORD_DEPENDENCIES));
    const unused = pinned.filter(name => !derived.includes(name));
    if (missing.length || unused.length) {
        throw new Error(
            `Vencord dependency pins do not match DockView imports (missing: ${missing.join(", ") || "none"}; unused: ${unused.join(", ") || "none"})`
        );
    }
    return derived.map(name => `${name}@${VENCORD_DEPENDENCIES[name]}`);
}
