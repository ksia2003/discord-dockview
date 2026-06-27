/*
 * The MCP feature's ONE import surface — PARKED behind the settings toggle.
 *
 * This is the ONLY module the rest of the plugin is allowed to reference: index.tsx
 * calls startMcp()/stopMcp() from its lifecycle and maybeRegisterMcpViewer() once at
 * start; settings.ts lazy-imports restartMcpClient from bridge.ts for the reconnect
 * onChange. Nothing under engine/, viewers/, host/ or ui/ imports anything from mcp/
 * — so the whole MCP feature (the WS bridge, the JSON-RPC host, the mcpapp viewer)
 * is isolated and can be reactivated later without touching the core.
 *
 * ★ DORMANCY GUARANTEE (default-off) ★ — with settings.store.mcpBridgeEnabled false
 * (the default) startMcp() returns EARLY: no WebSocket is opened, the 'message'
 * JSON-RPC router branch is NOT installed, and maybeRegisterMcpViewer() does NOT
 * register the mcpapp viewer (so getViewer("mcpapp") stays undefined and the engine
 * never routes an mcpapp body). The plugin behaves EXACTLY as if mcp/ didn't exist.
 * Flipping the toggle on and reloading reverses all three.
 *
 * NO module-top work: only imports + function decls. The window listener is created
 * inside startMcp (runtime), never at eval; nothing connects at import.
 */

import { settings } from "../settings";

import { registerViewer } from "../viewers/registry";
import { setMcpActive, startMcpClient, stopMcpClient } from "./bridge";
import { clearMcpFrames, handleMcpFrameMessage, mcpAppIdForSource } from "./host";
import { McpViewer } from "./McpViewer";

// The frame→host JSON-RPC listener, created in startMcp and removed in stopMcp so it
// only exists while the bridge is live. Lifecycle-scoped (mirrors index.tsx's own
// window listeners).
let onMcpMessage: ((e: MessageEvent) => void) | null = null;

// Latch so a double start/stop is harmless and the viewer is registered at most once.
let mcpStarted = false;
let viewerRegistered = false;

/** Register the mcpapp viewer — ONLY when the bridge toggle is on. With the toggle
 *  off this is a no-op, so the registry has no "mcpapp" entry, getViewer("mcpapp")
 *  is undefined, and the engine's router lands an mcpapp descriptor on its graceful
 *  unsupported state (which never happens anyway, since nothing pushes mcpapp without
 *  a live bridge). Called once from index.tsx start(). McpViewer is imported here in
 *  mcp/ — never from viewers/registry.ts — so the parked viewer stays out of the core
 *  graph; only this isolated subtree (reachable solely from index.tsx) references it. */
export function maybeRegisterMcpViewer(): void {
    if (viewerRegistered) return;
    if (!settings.store.mcpBridgeEnabled) return;
    registerViewer(McpViewer);
    viewerRegistered = true;
}

/** Start the MCP feature: open the bridge socket + install the frame→host JSON-RPC
 *  router. NO-OP unless the bridge toggle is on (the dormancy guarantee). Called from
 *  index.tsx start(). */
export function startMcp(): void {
    if (mcpStarted) return;
    if (!settings.store.mcpBridgeEnabled) return; // dormant: no socket, no listener
    mcpStarted = true;

    // The MCP-app frame → host channel: raw JSON-RPC 2.0 over postMessage (the message
    // IS the JSON-RPC object). The sandbox has no allow-same-origin, so event.origin is
    // "null" — never gate on it; identify the sending app by matching event.source to a
    // registered frame contentWindow, then route through the MCP-Apps host handler.
    onMcpMessage = (e: MessageEvent) => {
        const d = e?.data;
        if (d && typeof d === "object" && d.jsonrpc === "2.0" && typeof d.method === "string") {
            const appId = mcpAppIdForSource(e.source);
            if (appId) handleMcpFrameMessage(appId, e.source as Window, d);
        }
    };
    window.addEventListener("message", onMcpMessage);

    // Open the bridge (reads connect info from settings at connect time).
    setMcpActive(true);
    startMcpClient();
}

/** Stop the MCP feature: tear down the socket, remove the JSON-RPC router, drop the
 *  frame/session registries. Safe to call when never started. Called from index.tsx
 *  stop(). */
export function stopMcp(): void {
    setMcpActive(false);
    stopMcpClient();
    if (onMcpMessage) {
        window.removeEventListener("message", onMcpMessage);
        onMcpMessage = null;
    }
    clearMcpFrames();
    mcpStarted = false;
}
