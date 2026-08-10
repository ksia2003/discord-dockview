/*
 * Heavy-decoder LOADING MODE — the single source of truth for the Performance page's
 * per-decoder "On demand / Preload / Disabled" control.
 * ---------------------------------------------------------------------------
 * A handful of viewers depend on a HEAVY, EXOTIC decoder that ships as an out-of-bundle
 * chunk (engine/chunkRegistry.ts): the 3D model loader (three.js), the EPS/AI converter
 * (Ghostscript-WASM, ~16 MB), the PSD reader (ag-psd), the JPEG-XL codec (libjxl wasm),
 * and the DICOM parser. These are niche, optional formats, so their chunk load is worth
 * making user-controllable — unlike the CORE viewers (pdf.js, codemirror) whose chunks
 * always load, and the everyday productivity formats (mermaid, pptx) which stay
 * always-available. This module lists exactly the controllable ones and NOTHING else.
 *
 * THREE MODES (a string on the settings store, one field per decoder):
 *   "ondemand" (default) — load the chunk the first time a matching file opens.
 *   "preload"            — warm the chunk once after startup idle (preloadDecoders),
 *                          so the first open is instant. Warming is best-effort; it
 *                          never blocks boot and a failure is swallowed.
 *   "disabled"           — never load the chunk. A matching file shows a notice card
 *                          ("<Format> viewer is disabled…") with a Download action
 *                          instead of loading (engine/lazyLib throws DecoderDisabled,
 *                          which the viewer's catch surfaces on the state card).
 *
 * LIVE: modeFor() reads settings.store at call time, so a mode change affects the NEXT
 * load. A chunk already loaded this session stays loaded (loadLib's cache is keyed by
 * chunk key and is not evicted by a mode change) — switching to "disabled" only blocks
 * the NEXT, not-yet-loaded open.
 *
 * NO webpack access here — this is a plain settings/registry module a loader consults.
 */

import { CHUNK_BY_KEY } from "./chunkRegistry";
import { decoderKeyForFile } from "./dockEligibility";
import { settings } from "../settings";
import type { ContentType } from "./types";

/** The three loading modes. */
export type DecoderMode = "ondemand" | "preload" | "disabled";

/** One user-controllable heavy decoder. */
export interface DecoderControl {
    /** The chunkRegistry key this control governs (loadLib/withLibLoading key). */
    chunkKey: string;
    /** The settings-store STRING field holding this decoder's mode. */
    settingKey: string;
    /** The human format name shown in the UI + the disabled notice ("EPS / AI"). */
    label: string;
    /** The formats the decoder covers, for the UI note under the control. */
    formats: string;
}

/**
 * The controllable heavy decoders, in the Performance page's display order.
 *
 * Chosen from chunkRegistry as the HEAVY + EXOTIC + OPTIONAL chunks. Excluded on
 * purpose: pdfjs + codemirror (core viewers — a PDF or a code file should always open),
 * mermaid + pptx-renderer (everyday productivity formats users expect to just work). So
 * the control governs only the genuinely niche decoders where saving the load / disabling
 * the format is a reasonable user choice.
 */
export const DECODER_CONTROLS: DecoderControl[] = [
    { chunkKey: "three", settingKey: "decoderModeThree", label: "3D model", formats: "OBJ, STL, PLY, FBX, DAE, 3DS, glTF, GLB" },
    { chunkKey: "ghostscript", settingKey: "decoderModeGhostscript", label: "EPS / AI", formats: "EPS, non-PDF Illustrator .ai" },
    { chunkKey: "ag-psd", settingKey: "decoderModeAgpsd", label: "PSD", formats: "Photoshop PSD" },
    { chunkKey: "jxl", settingKey: "decoderModeJxl", label: "JPEG XL", formats: "JPEG XL (.jxl)" },
    { chunkKey: "dicom-parser", settingKey: "decoderModeDicom", label: "DICOM", formats: "DICOM medical images" }
];

/** chunk key → its control, for the loader's quick lookup. */
const CONTROL_BY_CHUNK = new Map(DECODER_CONTROLS.map(c => [c.chunkKey, c]));

/** The human label for a controllable chunk key (for the disabled notice), or null when
 *  the key isn't user-controllable (then it always loads on demand). */
export function decoderLabelFor(chunkKey: string): string | null {
    return CONTROL_BY_CHUNK.get(chunkKey)?.label ?? null;
}

/** A valid mode token, or the default when the stored value is unset/garbage. */
function coerceMode(raw: unknown): DecoderMode {
    return raw === "preload" || raw === "disabled" ? raw : "ondemand";
}

/**
 * The live loading mode for a chunk key. Reads settings.store at call time (so a change
 * applies to the next load). A key that isn't user-controllable — or any read failure
 * during very early boot — resolves to "ondemand", the pre-settings behaviour, so a new
 * chunk is never silently blocked.
 */
export function modeFor(chunkKey: string): DecoderMode {
    const control = CONTROL_BY_CHUNK.get(chunkKey);
    if (!control) return "ondemand";
    try {
        return coerceMode((settings.store as Record<string, any>)[control.settingKey]);
    } catch {
        return "ondemand";
    }
}

/** Whether the optional heavy decoder for a routed file is available right now. The
 * extension/type mapping lives in dockEligibility.ts so chat clicks and context menus
 * apply exactly the same disabled-mode gate. */
export function decoderEnabledForFile(type: ContentType, urlOrName?: string | null): boolean {
    const key = decoderKeyForFile(type, urlOrName);
    return key == null || modeFor(key) !== "disabled";
}

/** A tagged error thrown by the lazy loader when a decoder is set to "disabled". The
 *  message is the human notice; StateCards.humanizeError renders it as a plain card
 *  (title + sub) with the viewer's Download action, no "couldn't load" framing. `label`
 *  is carried for callers that want the format name without re-parsing the message. */
export class DecoderDisabledError extends Error {
    readonly decoderLabel: string;
    constructor(label: string) {
        super(`${label} viewer is disabled in DockView settings (Performance).`);
        this.name = "DecoderDisabledError";
        this.decoderLabel = label;
    }
}

/**
 * Warm every decoder currently set to "preload", once, off the startup critical path.
 *
 * Called from the plugin's start() behind a requestIdleCallback / setTimeout so it never
 * blocks boot. Each warm is a plain loadLib(key) with no importer (the key is chunked, so
 * loadLib routes to the on-disk chunk and ignores the importer) — the same call the first
 * open would make, just earlier, so the module promise is cached before any file opens. A
 * failure is swallowed: a preload that can't read its chunk simply falls back to the
 * on-demand load when the user actually opens such a file.
 *
 * `loadFn` is injected (rather than importing engine/lazyLib here) to keep this module's
 * import graph tiny and avoid any cycle; index.tsx passes loadLib in.
 */
export function preloadDecoders(loadFn: (key: string) => Promise<any>): void {
    for (const control of DECODER_CONTROLS) {
        if (modeFor(control.chunkKey) !== "preload") continue;
        // Only warm keys that really are chunked (a control should always be, but guard).
        if (!CHUNK_BY_KEY.has(control.chunkKey)) continue;
        try {
            // The importer is never called for a chunked key (loadLib reads the chunk),
            // so a throwing placeholder is safe; keep it a rejected promise regardless.
            loadFn(control.chunkKey)?.catch?.(() => { /* falls back to on-demand */ });
        } catch {
            /* best-effort warm — ignore */
        }
    }
}
