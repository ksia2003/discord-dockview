/*
 * DockView — the "About" settings page (renderer).
 * ---------------------------------------------------------------------------
 * A small page under the DockView settings section: the running DockView plugin
 * version, the Vesktop base version, a GitHub link-button, and a one-line credit.
 *
 * GRAMMAR — mirrors GallerySection.tsx / UpdatePanel.tsx: plain
 * `React.createElement` over @webpack/common primitives (no JSX), semantic CSS
 * variables only (no hard-coded colours), so it matches the native settings look
 * in every theme.
 *
 * NO import cycle: this imports ../version (pure), ../strings, and
 * ../external/openExternal (self-contained). The GitHub link opens in the OS
 * browser via the same openExternalLink the markdown/artifact sandbox uses.
 */

import { Button, Forms, React, Text } from "@webpack/common";

import { openExternalLink } from "../external/openExternal";
import { STRINGS } from "../strings";
import { DOCKVIEW_PLUGIN_VERSION, DOCKVIEW_RELEASE_REPOSITORY } from "../version";

// Lazy createElement wrapper — resolving the webpack React proxy at module-top would
// throw before Vencord is ready and drop the plugin. Defer it to call time.
const h = (...args: any[]) => (React.createElement as any)(...args);

const A = STRINGS.about;

const GITHUB_URL = `https://github.com/${DOCKVIEW_RELEASE_REPOSITORY}`;

/** The Vesktop base version off VesktopNative (the app IS Vesktop). null if the
 *  bridge isn't present in this build (e.g. plain web). */
function vesktopVersion(): string | null {
    try {
        const v = (window as any).VesktopNative?.app?.getVersion?.();
        return typeof v === "string" && v ? v : null;
    } catch {
        return null;
    }
}

/** One version row: a muted label and its value (or an em-dash when unknown). */
function versionRow(label: string, value: string | null) {
    return h(
        "div",
        { style: { display: "flex", justifyContent: "space-between", gap: "12px", margin: "3px 0" } },
        h(Text, { variant: "text-sm/normal", style: { color: "var(--text-muted)" } }, label),
        h(
            Text,
            { variant: "text-sm/medium", style: { fontVariantNumeric: "tabular-nums" } },
            value ?? "—"
        )
    );
}

export function AboutPanel() {
    return h(
        "div",
        null,
        h(
            Forms.FormText,
            { style: { marginBottom: "12px", color: "var(--text-muted)" } },
            A.blurb
        ),

        h(
            "div",
            { style: { margin: "8px 0 16px" } },
            versionRow(A.dockviewVersion, DOCKVIEW_PLUGIN_VERSION),
            versionRow(A.vesktopVersion, vesktopVersion())
        ),

        h(
            Button,
            {
                size: Button.Sizes.SMALL,
                color: Button.Colors.PRIMARY,
                onClick: () => openExternalLink(GITHUB_URL)
            },
            A.github
        ),

        h(Forms.FormDivider, { style: { margin: "16px 0" } }),

        h(
            Forms.FormText,
            { style: { color: "var(--text-muted)" } },
            A.credits
        )
    );
}
