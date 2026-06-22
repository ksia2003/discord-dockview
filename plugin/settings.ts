/*
 * DockView — Vencord plugin settings.
 * ---------------------------------------------------------------------------
 * The MCP bridge connect info (enable toggle + token + port) lives in Vencord's
 * own settings store, NOT in localStorage: Discord's renderer DELETES
 * window.localStorage (it reads back `undefined`), so a localStorage-backed
 * token never survived and the bridge client could never connect on real
 * Discord. Vencord persists these through its own storage, which is available
 * in the isolated renderer context.
 *
 * This module is imported by BOTH index.tsx (which wires `settings` into the
 * plugin def) and panel.tsx (which reads `settings.store` at connect time).
 * It must therefore NOT import either of them at module top level, or we'd
 * create an import cycle. The onChange handlers reach panel.tsx LAZILY via a
 * dynamic import so the cycle never forms and the call is a safe no-op while
 * the panel isn't running.
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

// Reconnect the bridge after a setting changes — but only via a lazy import so
// this module never statically depends on panel.tsx (cycle-free). restartMcpClient
// is itself guarded by the panel's `active` flag, so this is a no-op when the
// plugin isn't running.
function reconnectBridge() {
    import("./panel").then(m => m.restartMcpClient?.()).catch(() => { /* ignore */ });
}

export const settings = definePluginSettings({
    mcpBridgeEnabled: {
        type: OptionType.BOOLEAN,
        description: "Connect the dock to a local MCP bridge (renders AI-pushed widgets)",
        default: false,
        onChange: reconnectBridge
    },
    mcpBridgeToken: {
        type: OptionType.STRING,
        description: "Bridge auth token (paste the token the bridge prints on startup)",
        default: "",
        onChange: reconnectBridge
    },
    mcpBridgePort: {
        type: OptionType.NUMBER,
        description: "Bridge port (127.0.0.1)",
        default: 9820,
        onChange: reconnectBridge
    }
});
