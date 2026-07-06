/*
 * DockView — the "Performance" settings page (renderer).
 * ---------------------------------------------------------------------------
 * Two groups:
 *   1. Heavy decoders — a per-decoder 3-way control (On demand / Preload / Disabled)
 *      for the niche, exotic libraries that ship as out-of-bundle chunks (3D, EPS/AI,
 *      PSD, JPEG XL, DICOM — engine/decoderModes.ts DECODER_CONTROLS is the SSOT).
 *      "On demand" loads the chunk on first open; "Preload" warms it after startup idle
 *      (index.tsx preloadDecoders); "Disabled" refuses to load it (a matching file shows
 *      a notice card via the lazy loader's DecoderDisabledError). All three read the
 *      store live, so a change applies to the NEXT load — an already-loaded decoder stays
 *      loaded this session.
 *   2. Image quality — the "always lossless PNG for large images" switch, backing
 *      RasterImageViewer's export threshold (settings.store.largeImageLossless).
 *
 * The decoder control is a native Discord SELECT (the filled dropdown Discord's own
 * settings use, and Vesktop's screen-share picker) — three options per row. Discord never
 * uses a segmented side-by-side toggle for a state choice, so the dropdown is the native
 * grammar for a compact per-row choice.
 *
 * GRAMMAR — mirrors GeneralPanel/ViewersPanel: deferred `h` (no module-top webpack),
 * @webpack/common primitives, FormTitle h3 sub-groups, semantic CSS variables only. The
 * page header ("Performance") comes from the sidebar row's panel title, so it isn't
 * repeated. Binds the reactive settings store (settings.use) so a change persists +
 * re-renders.
 */

import { Forms, React, Select, Switch } from "@webpack/common";

import { syncDomOptimizer } from "../domOptimizer";
import { DECODER_CONTROLS, type DecoderMode } from "../engine/decoderModes";
import { pushVoiceFix } from "../networkPrivacy";
import { syncNoiseSuppression } from "../noiseSuppression";
import { settings } from "../settings";
import { STRINGS } from "../strings";

const h = (...args: any[]) => (React.createElement as any)(...args);

const P = STRINGS.performance;

/** Read/write the Vesktop settings store (not the plugin store) for the GPU-blocklist
 *  flag: main reads it at boot, so it must live where main can see it. Writing through
 *  VesktopNative.settings persists it to Vesktop's settings.json for the next launch. */
function vesktopSettings() {
    return (window as any).VesktopNative?.settings;
}
function readIgnoreBlocklist(): boolean {
    try { return vesktopSettings()?.get?.()?.ignoreGpuBlocklist === true; } catch { return false; }
}
function writeIgnoreBlocklist(value: boolean): void {
    const s = vesktopSettings();
    if (!s?.get || !s?.set) return;
    const next = { ...s.get(), ignoreGpuBlocklist: value };
    s.set(next, "ignoreGpuBlocklist");
}

/** The three modes in display order, as native Select options (value + label). */
const MODE_OPTIONS: Array<{ value: DecoderMode; label: string; }> = [
    { value: "ondemand", label: P.modeOnDemand },
    { value: "preload", label: P.modePreload },
    { value: "disabled", label: P.modeDisabled }
];

/** One decoder row: the format label + its formats note, and the native Select bound to
 *  the decoder's settings-store STRING field. */
function decoderRow(store: any, settingKey: string, label: string, formats: string) {
    const current: DecoderMode =
        store[settingKey] === "preload" || store[settingKey] === "disabled" ? store[settingKey] : "ondemand";
    return h(
        "div",
        { key: settingKey, style: { margin: "0 0 16px" } },
        h(
            "div",
            { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" } },
            h(
                "div",
                { style: { minWidth: "140px", flex: "1 1 200px" } },
                h(Forms.FormTitle, { tag: "h5", style: { marginBottom: "2px" } }, label),
                h(Forms.FormText, { style: { color: "var(--text-muted)", fontSize: "12px" } }, P.decoderFormats(formats))
            ),
            h(
                "div",
                { style: { flex: "0 0 auto", minWidth: "180px" } },
                h(Select, {
                    options: MODE_OPTIONS,
                    isSelected: (v: DecoderMode) => v === current,
                    select: (v: DecoderMode) => { store[settingKey] = v; },
                    serialize: String,
                    closeOnSelect: true,
                    "aria-label": label
                })
            )
        )
    );
}

export function PerformancePanel() {
    // Subscribe to every decoder-mode key + the lossless + DOM-optimizer switches so a
    // change re-renders.
    const store = settings.use([
        ...DECODER_CONTROLS.map(c => c.settingKey),
        "largeImageLossless",
        "domOptimizer",
        "voiceFixEnabled",
        "noiseSuppression"
    ]);

    // The GPU-blocklist flag lives in the Vesktop store (main reads it at boot), not the
    // plugin store, so it's held in local React state seeded from VesktopNative. Flipping
    // it persists to Vesktop's settings.json and reveals the restart hint — the flag is a
    // startup-time command-line switch that can't move on a live process.
    const [ignoreBlocklist, setIgnoreBlocklist] = React.useState(readIgnoreBlocklist);
    const [restartNeeded, setRestartNeeded] = React.useState(false);

    return h(
        "div",
        null,

        // --- Heavy decoders ------------------------------------------------
        h(Forms.FormTitle, { tag: "h3" }, P.decodersTitle),
        h(
            Forms.FormText,
            { style: { marginBottom: "16px", color: "var(--text-muted)" } },
            P.decodersNote
        ),
        ...DECODER_CONTROLS.map(c => decoderRow(store, c.settingKey, c.label, c.formats)),
        h(
            Forms.FormText,
            { style: { margin: "4px 0 8px", color: "var(--text-muted)", fontSize: "12px" } },
            P.modesLegend
        ),

        h(Forms.FormDivider, { style: { margin: "20px 0" } }),

        // --- Image quality -------------------------------------------------
        h(Forms.FormTitle, { tag: "h3" }, P.largeImageGroup),
        h(
            Switch,
            {
                value: store.largeImageLossless === true,
                note: P.losslessNote,
                hideBorder: true,
                onChange: (v: boolean) => { store.largeImageLossless = v; }
            },
            P.losslessTitle
        ),

        h(Forms.FormDivider, { style: { margin: "20px 0" } }),

        // --- Graphics ------------------------------------------------------
        h(Forms.FormTitle, { tag: "h3" }, P.graphicsGroup),
        h(
            Switch,
            {
                value: ignoreBlocklist,
                note: P.ignoreBlocklistNote,
                onChange: (v: boolean) => {
                    setIgnoreBlocklist(v);
                    setRestartNeeded(true);
                    writeIgnoreBlocklist(v);
                }
            },
            P.ignoreBlocklistTitle
        ),
        restartNeeded &&
            h(
                Forms.FormText,
                { style: { margin: "-4px 0 12px", color: "var(--text-warning)", fontSize: "12px" } },
                P.restartHint
            ),
        h(
            Switch,
            {
                value: store.domOptimizer === true,
                note: P.domOptimizerNote,
                hideBorder: true,
                onChange: (v: boolean) => {
                    store.domOptimizer = v;
                    syncDomOptimizer(v);
                }
            },
            P.domOptimizerTitle
        ),

        h(Forms.FormDivider, { style: { margin: "20px 0" } }),

        // --- Voice ---------------------------------------------------------
        h(Forms.FormTitle, { tag: "h3" }, P.voiceGroup),
        h(
            Switch,
            {
                value: store.voiceFixEnabled === true,
                note: P.voiceFixNote,
                onChange: (v: boolean) => {
                    store.voiceFixEnabled = v;
                    pushVoiceFix();
                }
            },
            P.voiceFixTitle
        ),
        h(
            Switch,
            {
                value: store.noiseSuppression === true,
                note: P.noiseSuppressionNote,
                hideBorder: true,
                onChange: (v: boolean) => {
                    store.noiseSuppression = v;
                    syncNoiseSuppression(v);
                }
            },
            P.noiseSuppressionTitle
        )
    );
}
