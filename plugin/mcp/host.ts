/*
 * The MCP Apps (SEP-1865) JSON-RPC HOST — PARKED, lives only behind the toggle.
 *
 * The dock is the host; the bridge ws peer (bridge.ts) is the MCP server. The
 * iframe ↔ host channel is raw JSON-RPC 2.0 over postMessage — the message IS the
 * JSON-RPC object, no wrapper. We never gate on event.origin: the widget iframe is
 * sandboxed without allow-same-origin, so its origin string is "null". The sender
 * is identified by event.source === a registered frame contentWindow.
 *
 * This module owns the frame/session registries (mcpFrames, mcpSessions,
 * mcpPendingCalls) and the request router (handleMcpFrameMessage). The window
 * 'message' listener (added by index.ts startMcp) calls mcpAppIdForSource +
 * handleMcpFrameMessage. A tools/call is proxied to the bridge socket; the bridge's
 * call.res reply is matched back to the originating frame via mcpPendingCalls.
 *
 * NO module-top work: plain Map literals (no lazy proxy / side effects), constants,
 * and function decls only. Nothing connects or renders at eval. The bridge socket is
 * read lazily through getMcpSocket() at call time, never imported as a value at top.
 */

import { openExternalLink } from "../external/openExternal";
import { getMcpSocket, nextCallId } from "./bridge";

// Live registry of mounted MCP-app iframe windows, keyed by app id (= the ui://
// resource uri). The host routes JSON-RPC by matching a frame→host message's
// event.source against these contentWindows. A plain Map literal is a safe
// module-top value (no lazy proxy / TDZ involved).
const mcpFrames = new Map<string, Window>();

// Per-app MCP-Apps session state, keyed by app id. Tracks the handshake (so we only
// push tool-input/result AFTER ui/notifications/initialized) and stashes the
// launching tool's args + result delivered by the bridge's `render` directive so
// they can be flushed once the frame is initialized.
export interface McpSession {
    win: Window | null;
    initialized: boolean;
    toolArguments: any;
    toolResult: any;
}
const mcpSessions = new Map<string, McpSession>();

// Correlate a ws tools/call proxy with the iframe request that triggered it, so the
// bridge's call.res can be replied to the right frame + JSON-RPC id. The id counter
// lives in bridge.ts (shared with read correlation) — we just hold the pending map.
const mcpPendingCalls = new Map<number, { win: Window; rpcId: any }>();

const MCP_PROTOCOL_VERSION = "2026-01-26";
const MCP_HOST_INFO = { name: "discord-dockview", version: "1.0.0" };

/** Seed / replace a session for an app id (called by the bridge's render path so the
 *  launching tool's args+result are stashed before the frame finishes its handshake). */
export function setMcpSession(appId: string, session: McpSession): void {
    mcpSessions.set(appId, session);
}

/** Register a live MCP-app frame window + ensure its session record exists. */
export function bindMcpFrame(appId: string, win: Window): void {
    mcpFrames.set(appId, win);
    const s = mcpSessions.get(appId);
    if (s) s.win = win;
    else mcpSessions.set(appId, { win, initialized: false, toolArguments: undefined, toolResult: undefined });
}

/** Drop a frame + its session (panel switch / unmount). Any pending ws calls
 *  targeting its window are abandoned. */
export function unbindMcpFrame(appId: string): void {
    const win = mcpFrames.get(appId);
    mcpFrames.delete(appId);
    mcpSessions.delete(appId);
    if (win) {
        for (const [id, p] of mcpPendingCalls) {
            if (p.win === win) mcpPendingCalls.delete(id);
        }
    }
}

/** Reverse-lookup the appId that owns a frame contentWindow (event.source). */
export function mcpAppIdForSource(src: any): string | null {
    for (const [id, win] of mcpFrames) {
        if (win === src) return id;
    }
    return null;
}

/** Post a JSON-RPC 2.0 message into a frame (targetOrigin "*"). */
function mcpPostToFrame(win: Window, msg: any): void {
    try { win.postMessage(msg, "*"); } catch { /* frame gone */ }
}
function mcpReplyResult(win: Window, id: any, result: any): void {
    mcpPostToFrame(win, { jsonrpc: "2.0", id, result });
}
function mcpReplyError(win: Window, id: any, code: number, message: string): void {
    mcpPostToFrame(win, { jsonrpc: "2.0", id, error: { code, message } });
}

/** Reply to a frame's pending tools/call once the bridge returns call.res. Called by
 *  the bridge message handler; no-op if the frame already unmounted. */
export function resolveMcpCall(callId: number, result: any): void {
    const pending = mcpPendingCalls.get(callId);
    if (!pending) return;
    mcpPendingCalls.delete(callId);
    mcpReplyResult(pending.win, pending.rpcId, result);
}

/** After a frame's ui/notifications/initialized, push the launching tool's args
 *  (ui/notifications/tool-input) and its CallToolResult (ui/notifications/
 *  tool-result). Called once the handshake completes; tool params delivered before
 *  init are stashed on the session and flushed here. */
export function mcpFlushTool(s: McpSession): void {
    if (!s.win || !s.initialized) return;
    if (s.toolArguments !== undefined) {
        mcpPostToFrame(s.win, {
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: s.toolArguments }
        });
    }
    if (s.toolResult !== undefined) {
        // params IS the CallToolResult.
        mcpPostToFrame(s.win, {
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: s.toolResult
        });
    }
}

/** Route a JSON-RPC 2.0 message that arrived from an MCP-app frame. Requests
 *  (have an id) get a result/error reply; notifications (no id) are handled and
 *  not replied to. Unknown methods get -32601. */
export function handleMcpFrameMessage(appId: string, win: Window, d: any): void {
    const method: string = d.method;
    const isRequest = d.id != null;
    const params = d.params || {};

    // Notifications (no reply).
    if (!isRequest) {
        if (method === "ui/notifications/initialized") {
            const s = mcpSessions.get(appId);
            if (s) { s.initialized = true; mcpFlushTool(s); }
        } else if (method === "ui/notifications/size-changed") {
            // intentionally ignored (no relayout yet)
        }
        return;
    }

    // Requests (must reply with result/error).
    if (method === "ui/initialize") {
        mcpReplyResult(win, d.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            hostInfo: MCP_HOST_INFO,
            hostCapabilities: { serverTools: {}, openLinks: {} },
            hostContext: { theme: "dark", displayMode: "inline" }
        });
        return;
    }
    if (method === "tools/call") {
        // Proxy to the bridge (MCP server) and reply to this frame when call.res
        // returns. With the bridge gone we report a tool error result.
        const sock = getMcpSocket();
        if (!sock || sock.readyState !== WebSocket.OPEN) {
            mcpReplyResult(win, d.id, { content: [{ type: "text", text: "MCP bridge not connected" }], isError: true });
            return;
        }
        const callId = nextCallId();
        mcpPendingCalls.set(callId, { win, rpcId: d.id });
        try {
            sock.send(JSON.stringify({ type: "call", id: callId, name: params.name, arguments: params.arguments || {} }));
        } catch {
            mcpPendingCalls.delete(callId);
            mcpReplyResult(win, d.id, { content: [{ type: "text", text: "MCP bridge send failed" }], isError: true });
        }
        return;
    }
    if (method === "ui/request-display-mode") {
        // No real relayout yet: echo the requested mode back.
        mcpReplyResult(win, d.id, { mode: params.mode });
        return;
    }
    if (method === "ui/open-link") {
        if (typeof params.url === "string") openExternalLink(params.url);
        mcpReplyResult(win, d.id, {});
        return;
    }
    mcpReplyError(win, d.id, -32601, "method not found");
}

/** Drop every frame + session (plugin stop). The bridge socket is torn down
 *  separately by bridge.ts/stopMcpClient. */
export function clearMcpFrames(): void {
    mcpFrames.clear();
    mcpSessions.clear();
    mcpPendingCalls.clear();
}
