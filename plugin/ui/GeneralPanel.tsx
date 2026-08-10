/* DockView General settings: ordered F9 width presets plus viewer behaviour toggles. */

import { Button, Forms, React, Slider, Switch } from "@vencord/types/webpack/common";

import { requestRender } from "../engine/forceRender";
import {
    applyHostWidth, getCompactDockWidth, getDockWidthPresets, MAX_WIDTH_FRAC,
    parseDockWidthPresets, setDockWidthPresets
} from "../host/layout";
import { settings } from "../settings";
import { STRINGS } from "../strings";

const h = (...args: any[]) => (React.createElement as any)(...args);
const G = STRINGS.general;

function switchRow(store: any, key: string, title: string, note: string, afterChange?: () => void) {
    return h(
        Switch,
        {
            value: store[key] !== false,
            note,
            hideBorder: false,
            onChange: (value: boolean) => { store[key] = value; afterChange?.(); }
        },
        title
    );
}

function smallButton(label: string, action: () => void, disabled = false) {
    return h(
        Button,
        {
            size: Button.Sizes.SMALL,
            color: Button.Colors.PRIMARY,
            disabled,
            onClick: action,
            style: { minWidth: "auto" }
        },
        label
    );
}

function WidthPresetEditor({ store }: { store: any; }) {
    const { useMemo, useState } = React;
    const initial = useMemo(() => parseDockWidthPresets(store.dockWidthPresets), []);
    const [presets, setPresets] = useState(() => initial.length ? initial : getDockWidthPresets());
    const [structureRevision, setStructureRevision] = useState(0);
    const compact = useMemo(() => getCompactDockWidth(), []);
    const maxWidth = useMemo(
        () => Math.max(compact + 60, Math.floor((window.innerWidth || 1280) * MAX_WIDTH_FRAC)),
        [compact]
    );

    const commit = (next: number[], structureChanged = false) => {
        const normalised = setDockWidthPresets(next);
        store.dockWidthPresets = normalised.join(",");
        setPresets(normalised);
        if (structureChanged) setStructureRevision(value => value + 1);
        applyHostWidth();
        requestRender();
    };
    const change = (index: number, value: number) => {
        const next = [...presets];
        next[index] = Math.round(value);
        commit(next, true);
    };
    const move = (index: number, delta: number) => {
        const target = index + delta;
        if (target < 0 || target >= presets.length) return;
        const next = [...presets];
        [next[index], next[target]] = [next[target], next[index]];
        commit(next);
    };
    const remove = (index: number) => {
        if (presets.length <= 1) return;
        commit(presets.filter((_, itemIndex) => itemIndex !== index), true);
    };
    const add = () => {
        const last = presets[presets.length - 1] ?? compact;
        commit([...presets, Math.min(maxWidth, last + 120)], true);
    };

    return h(
        "div",
        null,
        h(Forms.FormTitle, { tag: "h3" }, G.widthTitle),
        h(
            Forms.FormText,
            { style: { marginBottom: "12px", color: "var(--text-muted)" } },
            G.widthNote
        ),
        h(
            "div",
            {
                style: {
                    marginBottom: "12px",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    background: "var(--background-secondary)"
                }
            },
            h(Forms.FormTitle, { tag: "h5", style: { marginBottom: "2px" } }, G.hiddenPresetTitle),
            h(Forms.FormText, { style: { color: "var(--text-muted)", fontSize: "12px" } }, G.hiddenPresetNote)
        ),
        ...presets.map((width, index) => h(
            "div",
            {
                // Discord's Slider owns its drag state. Keep it mounted while the value
                // changes, but remount rows after an add/remove/reorder so initialValue is
                // refreshed for the new structural order.
                key: `dock-width-${structureRevision}-${index}`,
                style: {
                    display: "grid",
                    gridTemplateColumns: "minmax(120px, 1fr) auto",
                    alignItems: "center",
                    gap: "10px",
                    marginBottom: "12px"
                }
            },
            h(
                "div",
                { style: { minWidth: 0 } },
                h(Forms.FormTitle, { tag: "h5", style: { marginBottom: "4px" } }, G.presetTitle(index + 1)),
                h(Slider, {
                    initialValue: width,
                    minValue: 200,
                    maxValue: maxWidth,
                    keyboardStep: 10,
                    markers: [200, compact, 560, maxWidth].filter((value, markerIndex, all) =>
                        value <= maxWidth && all.indexOf(value) === markerIndex
                    ),
                    stickToMarkers: false,
                    onValueRender: (value: number) => G.widthValue(Math.round(value)),
                    asValueChanges: (value: number) => change(index, value),
                    onValueChange: (value: number) => change(index, value)
                })
            ),
            h(
                "div",
                { style: { display: "flex", gap: "6px", alignItems: "center" } },
                smallButton(G.moveUp, () => move(index, -1), index === 0),
                smallButton(G.moveDown, () => move(index, 1), index === presets.length - 1),
                smallButton(G.removePreset, () => remove(index), presets.length <= 1)
            )
        )),
        smallButton(G.addPreset, add, presets[presets.length - 1] >= maxWidth)
    );
}

export function GeneralPanel() {
    const store = settings.use([
        "dockWidthPresets",
        "dockMediaAutoplay",
        "membersMultiColumn"
    ]);

    return h(
        "div",
        null,
        h(WidthPresetEditor, { store }),
        h(Forms.FormDivider, { style: { margin: "20px 0" } }),
        switchRow(store, "dockMediaAutoplay", G.autoplayTitle, G.autoplayNote),
        h(Forms.FormDivider, { style: { margin: "20px 0" } }),
        switchRow(store, "membersMultiColumn", G.membersColumnsTitle, G.membersColumnsNote, requestRender)
    );
}
