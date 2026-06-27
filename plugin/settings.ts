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

// Reconnect the bridge after a setting changes. The MCP bridge is PARKED under
// mcp/ (registered only behind these toggles), so we reach restartMcpClient LAZILY
// via a dynamic import: that keeps mcp/ (and its transitive engine/host imports) out
// of settings' eval-time graph — no cycle, no eager pull of the bridge into the
// core. restartMcpClient is itself a safe no-op while the feature isn't running.
function reconnectBridge() {
    import("./mcp/bridge").then(m => m.restartMcpClient()).catch(() => { /* not running */ });
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
