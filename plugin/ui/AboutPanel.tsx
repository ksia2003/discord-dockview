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
import { DOCKVIEW_PLUGIN_VERSION } from "../version";

// Lazy createElement wrapper — resolving the webpack React proxy at module-top would
// throw before Vencord is ready and drop the plugin. Defer it to call time.
const h = (...args: any[]) => (React.createElement as any)(...args);

const A = STRINGS.about;

const GITHUB_URL = "https://github.com/ksia2003/discord-dockview";

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

/** Fetch the active profile name via the native profiles bridge. Returns the name,
 *  null (default install), or undefined (bridge unavailable — hides the row). */
async function fetchActiveProfile(): Promise<string | null | undefined> {
    try {
        const n = (window as any).VencordNative?.pluginHelpers?.DockView;
        if (n && typeof n.listProfiles === "function") {
            const l = await n.listProfiles();
            return l?.current ?? null;
        }
    } catch {
        /* fall through */
    }
    return undefined;
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
    const { useState, useEffect } = React;
    // undefined = not yet resolved / bridge missing (row hidden); null = Default; string = name.
    const [profile, setProfile] = useState<string | null | undefined>(undefined);

    useEffect(() => {
        let live = true;
        fetchActiveProfile().then(p => { if (live) setProfile(p); });
        return () => { live = false; };
    }, []);

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
            versionRow(A.vesktopVersion, vesktopVersion()),
            // Show the active profile only when the bridge resolved (undefined = hide).
            profile !== undefined &&
                versionRow(A.activeProfile, profile ?? STRINGS.profiles.defaultName)
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
