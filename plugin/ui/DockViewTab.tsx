/*
 * DockView — standalone settings tab (renderer).
 * ---------------------------------------------------------------------------
 * The whole DockView surface as a NATIVE settings page, registered as its own
 * left-sidebar entry (index.tsx pushes it onto the Settings plugin's
 * `customEntries`). This replaces the old Plugins→DockView modal: DockView is
 * still a plugin (it just runs `hidden`), but its title/description and the MCP
 * bridge controls now live here instead of inside the plugin card.
 *
 * GRAMMAR — this mirrors how Vencord's own settings tabs are built: plain
 * `React.createElement` over `@webpack/common`'s settings primitives
 * (Forms.FormSection / FormTitle / FormText / FormDivider, Switch, TextInput,
 * Text). No JSX, matching the rest of plugin/ui.
 *
 * MCP STORE BINDING — the three controls read/write `settings.store.*` directly.
 * Vencord registers each option's `onChange` (reconnectBridge) as a change
 * listener on `plugins.DockView.<key>` at plugin init (PluginManager:
 * addChangeListener), and `settings.store` is the deep-proxied settings object,
 * so a write through it fires that listener automatically — the same path the old
 * PluginModal used (`pluginSettings[key] = newValue`). We therefore do NOT call
 * reconnectBridge by hand; we just write the store and re-render via `settings.use`.
 *
 * The MCP section is flagged WIP — the bridge itself is PARKED behind the toggle
 * (plugin/mcp), so the controls are present but labelled "in development".
 *
 * NO import cycle: this imports ../settings (store-only, no COMPONENT entry).
 * settings does not import back here.
 */

import { Forms, React, Switch, TextInput } from "@webpack/common";

import { settings } from "../settings";
import { GallerySection } from "./GallerySection";

// NOTE: must stay a lazy wrapper, NOT `const h = React.createElement`. The latter
// resolves the webpack React proxy at module-top (import time), before Vencord is
// ready, which throws and silently drops the whole plugin from Vencord.Plugins
// (design §8). Wrapping defers the `.createElement` access to call time.
const h = (...args: any[]) => (React.createElement as any)(...args);

// The plugin description, kept verbatim from definePlugin so the tab header reads
// the same blurb the old modal showed.
const DESCRIPTION =
    "Click an attachment chip or inline image to render it in a right-docked, " +
    "native-style panel: HTML artifacts, PDF, code, markdown, and images " +
    "(F9 to toggle; mutually exclusive with the member list; remembers per channel; " +
    "PDF refits on resize).";

/** A small "(in development)" pill rendered next to the MCP section title. */
function wipBadge() {
    return h(
        "span",
        {
            style: {
                marginLeft: "8px",
                padding: "1px 6px",
                borderRadius: "8px",
                fontSize: "11px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "var(--text-muted)",
                background: "var(--background-base-lower)",
                verticalAlign: "middle"
            }
        },
        "In development"
    );
}

/** The MCP bridge controls, bound to `settings.store`. `settings.use()` subscribes
 *  this component to the three keys so the controls re-render on change; each write
 *  to the store fires the registered reconnectBridge listener. */
function McpSection() {
    // Subscribe + read the live store. `use()` returns the same proxied store, so
    // assignments below persist AND trigger the option onChange listeners.
    const store = settings.use(["mcpBridgeEnabled", "mcpBridgeToken", "mcpBridgePort"]);

    return h(
        Forms.FormSection,
        { style: { marginTop: "16px" } },
        h(
            Forms.FormTitle,
            { tag: "h3", style: { display: "flex", alignItems: "center" } },
            "MCP Bridge",
            wipBadge()
        ),
        h(
            Forms.FormText,
            { style: { marginBottom: "12px", color: "var(--text-muted)" } },
            "Experimental — connect the dock to a local MCP bridge so an AI can push " +
                "live widgets into the panel. This bridge is still in development; the " +
                "controls are here for testing and may change."
        ),

        // Enable toggle (BOOLEAN). Switch is FormSwitchCompat: children = label,
        // `note` = description, `value`/`onChange` carry the boolean.
        h(
            Switch,
            {
                value: !!store.mcpBridgeEnabled,
                note: "Connect the dock to a local MCP bridge (renders AI-pushed widgets).",
                onChange: (v: boolean) => { store.mcpBridgeEnabled = v; }
            },
            "Enable MCP bridge"
        ),

        // Token (STRING).
        h(
            Forms.FormTitle,
            { tag: "h5", style: { marginTop: "8px" } },
            "Bridge token"
        ),
        h(TextInput, {
            type: "text",
            value: store.mcpBridgeToken ?? "",
            placeholder: "Paste the token the bridge prints on startup",
            onChange: (v: string) => { store.mcpBridgeToken = v; }
        }),

        // Port (NUMBER). TextInput yields a string; coerce to a number (empty → 0
        // is avoided by leaving NaN writes out so a half-typed value doesn't clobber).
        h(
            Forms.FormTitle,
            { tag: "h5", style: { marginTop: "12px" } },
            "Bridge port"
        ),
        h(TextInput, {
            type: "number",
            value: String(store.mcpBridgePort ?? ""),
            placeholder: "9820",
            onChange: (v: string) => {
                const n = parseInt(v, 10);
                if (Number.isFinite(n)) store.mcpBridgePort = n;
            }
        }),
        h(
            Forms.FormText,
            { style: { marginTop: "4px", color: "var(--text-muted)" } },
            "Bridge port (127.0.0.1)."
        )
    );
}

export function DockViewTab() {
    return h(
        "div",
        { style: { padding: "0" } },

        // --- Header: title + the plugin description. -----------------------
        h(Forms.FormTitle, { tag: "h1", style: { fontSize: "20px" } }, "DockView"),
        h(
            Forms.FormText,
            { style: { marginBottom: "8px", color: "var(--text-muted)" } },
            DESCRIPTION
        ),

        h(Forms.FormDivider, { style: { margin: "16px 0" } }),

        // --- Examples & supported formats gallery. -------------------------
        h(GallerySection),

        h(Forms.FormDivider, { style: { margin: "16px 0" } }),

        // --- MCP bridge (WIP). ---------------------------------------------
        h(McpSection)
    );
}
