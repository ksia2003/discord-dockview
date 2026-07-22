/*
 * DockView — the "Examples / supported formats" gallery (settings tab section).
 * ---------------------------------------------------------------------------
 * The "Examples" page under the DockView settings section: every supported viewer,
 * grouped by category, each with an "Open" button that loads a representative sample
 * into the REAL dock so it can be seen, touched and tested (orbit a 3D model, switch
 * xlsx sheets, page a PDF, click inside an HTML artifact, …). It doubles as a
 * user-facing showcase of what DockView can render. Mounted as its page Component
 * (settingsSection.ts builds an "Examples" row over it).
 *
 * GRAMMAR — plain `React.createElement`
 * over @webpack/common primitives (no JSX), semantic CSS variables only (no hard-
 * coded colours), so it matches the native settings look in every theme.
 *
 * DELIVERY — the samples are NOT in the renderer bundle. The first time a sample is
 * opened, gallery/samples.ts pulls chunk-samples.js over the readChunk IPC, evals it,
 * and caches the decoded map; opening decodes one fixture's base64 to a blob: URL and
 * calls __dockView.load({ name, url }) so the dock's own detectType routes it to the
 * matching viewer (exactly like a real attachment chip). The brief one-time load
 * shows a "Loading examples…" state on the clicked button; later opens are instant.
 *
 * NO import cycle: this imports the catalog (pure data), the sample loader (reads off
 * window), and @webpack/common. It reaches __dockView off `window` at click time (the
 * same neutral handle index.tsx exposes), so it never imports the engine directly.
 */

import { Button, Forms, React, Text } from "@vencord/types/webpack/common";

import { SAMPLE_CATALOG, type SampleEntry } from "../gallery/catalog";
import { isSampleChunkLoaded, sampleBlobUrl } from "../gallery/samples";

// Lazy createElement wrapper — resolving the webpack React proxy at module-top would
// throw before Vencord is ready and drop the plugin. Defer it to call time.
const h = (...args: any[]) => (React.createElement as any)(...args);

// A small MIME hint per extension so the blob: URL carries a sensible type. detectType
// routes by the file NAME (extension), so the exact MIME is not load-bearing, but a
// correct type keeps <audio>/<video>/<img> happy where the element sniffs it.
const MIME_BY_EXT: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png", tif: "image/tiff", heic: "image/heic", psd: "image/vnd.adobe.photoshop",
    tga: "image/x-tga", ico: "image/x-icon", jp2: "image/jp2", jxl: "image/jxl",
    dxf: "image/vnd.dxf", dcm: "application/dicom",
    md: "text/markdown", py: "text/x-python", json: "application/json", html: "text/html",
    csv: "text/csv", eml: "message/rfc822",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rtf: "application/rtf", odt: "application/vnd.oasis.opendocument.text",
    mmd: "text/plain", dot: "text/vnd.graphviz", ipynb: "application/json",
    mp3: "audio/mpeg", mp4: "video/mp4",
    glb: "model/gltf-binary", obj: "text/plain"
};

/** Get the neutral __dockView handle (index.tsx exposes it); null if not ready. */
function dockView(): any {
    try {
        const dv = (window as any).__dockView;
        return dv && typeof dv.load === "function" ? dv : null;
    } catch {
        return null;
    }
}

/** A small uppercase extension pill, styled with semantic vars (theme-aware). */
function extPill(ext: string) {
    return h(
        "span",
        {
            style: {
                marginLeft: "8px",
                padding: "1px 6px",
                borderRadius: "6px",
                fontSize: "11px",
                fontWeight: 600,
                letterSpacing: "0.03em",
                fontFamily: "var(--font-code, monospace)",
                color: "var(--text-muted)",
                background: "var(--background-base-lower, var(--background-secondary))"
            }
        },
        "." + ext
    );
}

/** One format card: name + ext pill, blurb, and an Open button that loads the sample
 *  into the dock. Tracks its own pending/error state so a failed decode is visible. */
function SampleCard({ entry }: { entry: SampleEntry }) {
    const { useState, useCallback } = React;
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const onOpen = useCallback(async () => {
        const dv = dockView();
        if (!dv) {
            setError("Open a channel first, then try again.");
            return;
        }
        setError(null);
        // Only show the loading label if the chunk isn't warm yet (first open in a
        // session); warm opens are instant and shouldn't flash a spinner.
        const cold = !isSampleChunkLoaded();
        if (cold) setPending(true);
        try {
            const mime = MIME_BY_EXT[entry.ext] || "application/octet-stream";
            const url = await sampleBlobUrl(entry.file, mime);
            dv.load({ name: entry.file, url });
        } catch (e) {
            setError((e as Error)?.message ?? String(e));
        } finally {
            setPending(false);
        }
    }, [entry]);

    return h(
        "div",
        {
            style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                padding: "10px 12px",
                borderRadius: "8px",
                background: "var(--background-secondary)",
                border: "1px solid var(--background-modifier-accent)"
            }
        },
        // Left: title row + blurb.
        h(
            "div",
            { style: { minWidth: 0, flex: "1 1 auto" } },
            h(
                "div",
                { style: { display: "flex", alignItems: "center" } },
                h(Text, { variant: "text-md/semibold", style: { color: "var(--header-primary)" } }, entry.label),
                extPill(entry.ext)
            ),
            h(
                Text,
                { variant: "text-sm/normal", style: { display: "block", marginTop: "2px", color: "var(--text-muted)" } },
                error ? error : entry.blurb
            )
        ),
        // Right: the Open button.
        h(
            Button,
            {
                size: Button.Sizes.SMALL,
                color: error ? Button.Colors.RED : Button.Colors.PRIMARY,
                disabled: pending,
                onClick: onOpen,
                style: { flex: "0 0 auto" }
            },
            pending ? "Loading…" : "Open"
        )
    );
}

/** One category block: a small heading + its cards in a tidy column. */
function CategoryBlock({ title, entries }: { title: string; entries: SampleEntry[] }) {
    return h(
        "div",
        { style: { marginTop: "18px" } },
        h(
            Forms.FormTitle,
            { tag: "h5", style: { textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--header-secondary)" } },
            title
        ),
        h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "6px" } },
            ...entries.map(e => h(SampleCard, { key: e.file, entry: e }))
        )
    );
}

/** The gallery section: intro + every category. The "Examples" page Component. */
export function GallerySection() {
    const total = SAMPLE_CATALOG.reduce((n, c) => n + c.entries.length, 0);
    return h(
        Forms.FormSection,
        { style: { marginTop: "16px" } },
        h(Forms.FormTitle, { tag: "h3" }, "Examples & supported formats"),
        h(
            Forms.FormText,
            { style: { marginBottom: "4px", color: "var(--text-muted)" } },
            `Open a representative sample of each of the ${total} supported viewers right ` +
                "in the dock — page a PDF, switch spreadsheet sheets, orbit a 3D model, " +
                "or click inside an HTML artifact. Samples load on demand the first time."
        ),
        ...SAMPLE_CATALOG.map(c => h(CategoryBlock, { key: c.title, title: c.title, entries: c.entries }))
    );
}
