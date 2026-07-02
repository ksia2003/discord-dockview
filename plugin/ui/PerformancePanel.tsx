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
 * The decoder control is a SEGMENTED control (three inline buttons, the active one
 * highlighted) — the Discord state-colour grammar the csv/tree raw toggles use — chosen
 * over a dropdown so all three modes read at a glance and the page stays native-plain.
 *
 * GRAMMAR — mirrors GeneralPanel/ViewersPanel: deferred `h` (no module-top webpack),
 * @webpack/common primitives, FormTitle h3 sub-groups, semantic CSS variables only. The
 * page header ("Performance") comes from the sidebar row's panel title, so it isn't
 * repeated. Binds the reactive settings store (settings.use) so a change persists +
 * re-renders.
 */

import { Forms, React, Switch } from "@webpack/common";

import { DECODER_CONTROLS, type DecoderMode } from "../engine/decoderModes";
import { settings } from "../settings";
import { STRINGS } from "../strings";

const h = (...args: any[]) => (React.createElement as any)(...args);

const P = STRINGS.performance;

/** The three modes in display order, with their labels. */
const MODES: Array<{ value: DecoderMode; label: string; }> = [
    { value: "ondemand", label: P.modeOnDemand },
    { value: "preload", label: P.modePreload },
    { value: "disabled", label: P.modeDisabled }
];

/** One segmented button. Highlighted (brand fill) when it is the active mode; otherwise a
 *  quiet neutral surface. Uses semantic vars so it themes with Discord. */
function segButton(active: boolean, label: string, first: boolean, last: boolean, onClick: () => void) {
    return h(
        "button",
        {
            type: "button",
            onClick,
            "aria-pressed": active,
            style: {
                flex: "1 1 0",
                padding: "6px 10px",
                fontSize: "13px",
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
                border: "1px solid var(--input-border, var(--background-modifier-accent))",
                borderRight: last ? undefined : "none",
                borderTopLeftRadius: first ? "4px" : undefined,
                borderBottomLeftRadius: first ? "4px" : undefined,
                borderTopRightRadius: last ? "4px" : undefined,
                borderBottomRightRadius: last ? "4px" : undefined,
                background: active ? "var(--brand-500, var(--brand-experiment))" : "var(--input-background, var(--background-secondary))",
                color: active ? "var(--white-500, #fff)" : "var(--text-default, var(--header-primary))",
                transition: "background 120ms ease, color 120ms ease"
            }
        },
        label
    );
}

/** One decoder row: the format label + its formats note, and the 3-way segmented control
 *  bound to the decoder's settings-store STRING field. */
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
                { style: { display: "flex", flex: "0 0 auto", minWidth: "260px" } },
                ...MODES.map((m, i) =>
                    segButton(
                        current === m.value,
                        m.label,
                        i === 0,
                        i === MODES.length - 1,
                        () => { store[settingKey] = m.value; }
                    )
                )
            )
        )
    );
}

export function PerformancePanel() {
    // Subscribe to every decoder-mode key + the lossless switch so a change re-renders.
    const store = settings.use([
        ...DECODER_CONTROLS.map(c => c.settingKey),
        "largeImageLossless"
    ]);

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
        )
    );
}
