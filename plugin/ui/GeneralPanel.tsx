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

import { Forms, React, Slider, Switch } from "@webpack/common";

import {
    DEFAULT_WIDTH, getDockWidth, MAX_WIDTH_FRAC, MIN_WIDTH, setDockWidthPersisted
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

/** The dock-width slider. Bound to the LIVE dock width (getDockWidth) — the one global
 *  width the edge-drag also drives — not to a settings-store copy. The slider's local
 *  state seeds from the current width; dragging it calls setDockWidthPersisted (clamp +
 *  live host resize + persist) and syncs back the clamped value. `asValueChanges` drives
 *  the live resize continuously through the drag; `onValueChange` commits the release. */
function WidthSlider() {
    const { useState, useMemo } = React;
    const [width, setWidth] = useState(() => getDockWidth());

    // The slider's max = MAX_WIDTH_FRAC of the current window width (the same ceiling
    // clampWidthRaw enforces), floored at MIN_WIDTH so a tiny window still gives a range.
    const maxWidth = useMemo(
        () => Math.max(MIN_WIDTH + 60, Math.floor((window.innerWidth || 1280) * MAX_WIDTH_FRAC)),
        []
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
            minValue: MIN_WIDTH,
            maxValue: maxWidth,
            keyboardStep: 10,
            markers: [MIN_WIDTH, DEFAULT_WIDTH, maxWidth],
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
