/*
 * DockView — viewer-scoped performance settings.
 *
 * Decoder loading and image conversion are DockView concerns. Global Chromium,
 * DOM, voice, and screen-share behavior stays with upstream Vesktop/Discord.
 */

import { Forms, React, Select, Switch } from "@vencord/types/webpack/common";

import { DECODER_CONTROLS, type DecoderMode } from "../engine/decoderModes";
import { settings } from "../settings";
import { STRINGS } from "../strings";

const h = (...args: any[]) => (React.createElement as any)(...args);
const copy = STRINGS.performance;

const MODE_OPTIONS: Array<{ value: DecoderMode; label: string; }> = [
    { value: "ondemand", label: copy.modeOnDemand },
    { value: "preload", label: copy.modePreload },
    { value: "disabled", label: copy.modeDisabled }
];

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
                h(Forms.FormText, { style: { color: "var(--text-muted)", fontSize: "12px" } }, copy.decoderFormats(formats))
            ),
            h(
                "div",
                { style: { flex: "0 0 auto", minWidth: "180px" } },
                h(Select, {
                    options: MODE_OPTIONS,
                    isSelected: (value: DecoderMode) => value === current,
                    select: (value: DecoderMode) => { store[settingKey] = value; },
                    serialize: String,
                    closeOnSelect: true,
                    "aria-label": label
                })
            )
        )
    );
}

export function PerformancePanel() {
    const store = settings.use([
        ...DECODER_CONTROLS.map(control => control.settingKey),
        "largeImageLossless"
    ]);

    return h(
        "div",
        null,
        h(Forms.FormTitle, { tag: "h3" }, copy.decodersTitle),
        h(
            Forms.FormText,
            { style: { marginBottom: "16px", color: "var(--text-muted)" } },
            copy.decodersNote
        ),
        ...DECODER_CONTROLS.map(control => decoderRow(store, control.settingKey, control.label, control.formats)),
        h(
            Forms.FormText,
            { style: { margin: "4px 0 8px", color: "var(--text-muted)", fontSize: "12px" } },
            copy.modesLegend
        ),
        h(Forms.FormDivider, { style: { margin: "20px 0" } }),
        h(Forms.FormTitle, { tag: "h3" }, copy.largeImageGroup),
        h(
            Switch,
            {
                value: store.largeImageLossless === true,
                note: copy.losslessNote,
                hideBorder: true,
                onChange: (value: boolean) => { store.largeImageLossless = value; }
            },
            copy.losslessTitle
        )
    );
}
