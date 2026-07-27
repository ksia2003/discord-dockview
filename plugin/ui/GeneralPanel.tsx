/*
 * DockView — the "General" settings page (renderer).
 * ---------------------------------------------------------------------------
 * The dock's behaviour preferences under the DockView settings section:
 *   - Dock width — the native Slider bound to the ONE live dock width (the same
 *     width the edge-drag resizes and persists, layout.ts). Dragging it resizes the
 *     dock live and writes through the same DataStore persistence; there is no second
 *     "default width" concept.
 *   - Autoplay media when opened.
 * The switch binds to the reactive settings store (settings.use) so a flip persists and
 * re-renders; each behaviour reads the same store live at the moment it runs, so a toggle
 * applies with no reload.
 *
 * GRAMMAR — mirrors AboutPanel.tsx / UpdatePanel.tsx: plain React.createElement over
 * @webpack/common primitives (no JSX), semantic CSS variables only, so it matches the
 * native settings look in every theme. The page header ("General") comes from the
 * sidebar row's panel title, so it isn't repeated; FormTitle h3 heads each sub-group.
 *
 * NO module-top webpack access: the `h` wrapper defers React.createElement to call
 * time (resolving the proxy at import time would throw before Vencord is ready and drop
 * the plugin). No import cycle: this imports ../settings (store-only) + host/layout.
 */

import { Forms, React, Slider, Switch } from "@vencord/types/webpack/common";

import {
    DEFAULT_EXPANDED_WIDTH, getCompactDockWidth, getExpandedDockWidth,
    MAX_WIDTH_FRAC, setDockWidthPersisted
} from "../host/layout";
import { settings } from "../settings";
import { STRINGS } from "../strings";

const h = (...args: any[]) => (React.createElement as any)(...args);

const G = STRINGS.general;

/** One switch row bound to a settings-store boolean. `store` is the live proxied store
 *  from settings.use(); writing store[key] persists + fires listeners. */
function switchRow(store: any, key: string, title: string, note: string) {
    return h(
        Switch,
        {
            value: store[key] !== false,
            note,
            hideBorder: false,
            onChange: (v: boolean) => { store[key] = v; }
        },
        title
    );
}

/** The expanded-width preset. Compact width follows Discord's native member rail; this
 *  slider changes the width F9 expands to. When already expanded the change stays live. */
function WidthSlider() {
    const { useState, useMemo } = React;
    const [width, setWidth] = useState(() => getExpandedDockWidth());
    const compactWidth = useMemo(() => getCompactDockWidth(), []);

    // The slider's max = MAX_WIDTH_FRAC of the current window width (the same ceiling
    // clampWidthRaw enforces), floored above the live native member width.
    const maxWidth = useMemo(
        () => Math.max(compactWidth + 60, Math.floor((window.innerWidth || 1280) * MAX_WIDTH_FRAC)),
        [compactWidth]
    );

    const apply = (v: number) => {
        const applied = setDockWidthPersisted(Math.round(v));
        setWidth(applied);
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
        h(Slider, {
            initialValue: width,
            minValue: compactWidth,
            maxValue: maxWidth,
            keyboardStep: 10,
            markers: [compactWidth, DEFAULT_EXPANDED_WIDTH, maxWidth],
            stickToMarkers: false,
            onValueRender: (v: number) => G.widthValue(Math.round(v)),
            asValueChanges: (v: number) => apply(v),
            onValueChange: (v: number) => apply(v)
        })
    );
}

export function GeneralPanel() {
    // Subscribe to the behaviour keys; `use()` returns the live proxied store, so
    // assignments below persist AND fire the option listeners, and a change re-renders.
    const store = settings.use([
        "dockMediaAutoplay"
    ]);

    return h(
        "div",
        null,

        // --- Dock width ----------------------------------------------------
        h(WidthSlider),

        h(Forms.FormDivider, { style: { margin: "20px 0" } }),

        // --- Behaviour switches --------------------------------------------
        switchRow(store, "dockMediaAutoplay", G.autoplayTitle, G.autoplayNote)
    );
}
