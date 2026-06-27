/*
 * The MCP bridge WebSocket client — PARKED, lives only behind the toggle.
 *
 * Opens a ws to a LOCAL bridge (127.0.0.1) that fronts an MCP server, then speaks
 * the MCP-Apps host ws protocol: on `render` it fetches the ui:// resource via
 * `read` and renders it with renderMcpApp (a sandboxed iframe widget); `call.res`
 * resolves a proxied tools/call back to the originating frame; `open`/`artifact`
 * push ordinary content / a Claude-artifact into the dock. The connect info (enable
 * toggle / token / port) is read from VENCORD SETTINGS at connect time, NEVER at
 * module eval — Discord deletes window.localStorage in the renderer, so the bridge
 * token only survives in Vencord's own store (see settings.ts).
 *
 * ★ NO module-top work (the silent-death trap) ★ — the socket is NEVER opened at
 * eval. mcpSocket starts null; startMcpClient() opens it (called from index.ts's
 * startMcp, which itself no-ops unless the toggle is on); stopMcpClient() tears it
 * down. The `mcpActive` latch (set by setMcpActive from index.ts) gates reconnects
 * so a teardown can't re-open the socket. Only imports, lets initialised to null,
 * constants and function decls live at module top.
 */

import { settings } from "../settings";

import { load } from "../engine/load";
import { injectNonce, pageNonce } from "../engine/nonce";
import { resolveMcpCall, setMcpSession } from "./host";

// The bridge WebSocket + its single pending reconnect timer (lazy — never opened at
// module eval; startMcpClient opens it, stopMcpClient tears it down).
let mcpSocket: WebSocket | null = null;
let mcpReconnect: any = null;
// Lifecycle latch, flipped by index.ts start/stop. While false we neither connect
// nor reconnect (a teardown that races an in-flight close can't re-open the socket).
let mcpActive = false;
// resources/read correlation: ws read id -> the render directive awaiting its HTML.
let mcpReadSeq = 0;
const mcpPendingReads = new Map<number, { resourceUri: string; tool: any; result: any }>();
// A monotonic id shared by read + tools/call correlation (host.ts allocates call ids
// through nextCallId so the bridge's call.res can be matched to a pending frame call).
let mcpCallSeq = 0;
// Claude-artifact runtime source, fetched lazily (NEVER at module eval) from the
// bridge's http server on first `artifact` directive and cached for reuse so the
// ~1.7MB runtime is sent over the wire at most once per session.
let mcpRuntime: string | null = null;

/** The live bridge socket (or null). host.ts reads it at tools/call time to proxy. */
export function getMcpSocket(): WebSocket | null {
    return mcpSocket;
}

/** Allocate the next call-correlation id (host.ts uses this for a proxied tools/call). */
export function nextCallId(): number {
    return ++mcpCallSeq;
}

/** Flip the lifecycle latch. index.ts's startMcp/stopMcp own this; bridge reconnects
 *  only while it is true. */
export function setMcpActive(on: boolean): void {
    mcpActive = on;
}

/** Render an MCP app: a sandboxed HTML widget driven over the bridge as an MCP Apps
 *  host. Routes through the engine load() (which focuses the transient window, opens
 *  the chrome and re-renders) with the mcpapp type; `id` (= the ui:// resource uri)
 *  is threaded through as the name so the McpViewer loader keys the postMessage
 *  registry by it. The launching tool's arguments + CallToolResult are stashed on a
 *  fresh session record and flushed to the frame as tool-input/tool-result once it
 *  finishes the handshake. */
export function renderMcpApp({ id, html, toolArguments, toolResult }: { id: string; html: string; toolArguments?: any; toolResult?: any; }): void {
    // Fresh session for this app id: discard any prior frame/handshake state.
    setMcpSession(id, { win: null, initialized: false, toolArguments, toolResult });
    // The engine load() carries inline html on its `html` field (no url → not cached);
    // McpViewer.load reads it off opts.code and uses the name as the appId. We pass
    // id as BOTH name and id so the appId is the resource uri.
    load({ name: id, html, type: "mcpapp", id });
}

/** Render a Claude-artifact directive's TSX `code` with the cached runtime. Inlines
 *  the runtime + a call to window.__renderArtifact(code, {}) into a self-contained
 *  HTML doc and renders it through renderMcpApp (sandboxed iframe, allow-scripts only,
 *  nonced inline scripts). The runtime (mcpRuntime) is already "<script"-neutralized
 *  by the bridge, so McpViewer.load→injectNonce only stamps the real top-level
 *  <script> we add here. The TSX `code` is "</script"-neutralized so a literal closing
 *  tag in the source can't break the HTML parser. */
function renderArtifactCode(msg: any): void {
    if (mcpRuntime == null) return;
    const code = String(msg.code).replaceAll("</script", "<\\/script");
    const body = "<!doctype html><html><head><meta charset=utf-8></head>"
        + "<body style=\"margin:0;background:#1e1f22\"><div id=\"root\">loading…</div>"
        + "<script>" + mcpRuntime + "\nwindow.__renderArtifact(" + JSON.stringify(code) + ",{});</script>"
        + "</body></html>";
    try { renderMcpApp({ id: "artifact:" + (msg.name || "artifact"), html: body }); } catch { /* ignore */ }
}

/** Open (or re-open) the MCP bridge WebSocket. Reads the enable toggle / token / port
 *  from Vencord settings AT CONNECT TIME (never at module eval). With the bridge
 *  disabled or no token we just log and stay disconnected. Sends the hello handshake
 *  on open, then speaks the MCP-Apps host ws protocol. Schedules a single reconnect
 *  on close/error (unless we're shutting down). Guards against a double connect when
 *  a socket is already OPEN/CONNECTING. */
export function startMcpClient(): void {
    if (!mcpActive) return; // don't reconnect after stopMcp
    if (mcpSocket && (mcpSocket.readyState === WebSocket.OPEN || mcpSocket.readyState === WebSocket.CONNECTING)) return;
    if (!settings.store.mcpBridgeEnabled) {
        console.debug("[dockview] mcp: bridge disabled in settings — not connecting");
        return;
    }
    const token = settings.store.mcpBridgeToken;
    if (!token) {
        console.debug("[dockview] mcp: no bridge token in settings — not connecting");
        return;
    }
    let sock: WebSocket;
    try {
        sock = new WebSocket(`ws://127.0.0.1:${settings.store.mcpBridgePort || 9820}`);
    } catch (e) {
        console.debug("[dockview] mcp: connect failed", e);
        return;
    }
    mcpSocket = sock;
    sock.addEventListener("open", () => {
        try { sock.send(JSON.stringify({ type: "hello", token })); } catch { /* ignore */ }
    });
    sock.addEventListener("message", (ev: MessageEvent) => {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "render" && msg.resourceUri) {
            // Fetch the ui:// resource's HTML; remember the launching tool so it can
            // be pushed to the frame once it renders + completes its handshake.
            const readId = ++mcpReadSeq;
            mcpPendingReads.set(readId, { resourceUri: msg.resourceUri, tool: msg.tool || null, result: msg.result });
            try { sock.send(JSON.stringify({ type: "read", id: readId, uri: msg.resourceUri })); } catch { mcpPendingReads.delete(readId); }
        } else if (msg.type === "read.res") {
            const req = mcpPendingReads.get(msg.id);
            if (!req) return;
            mcpPendingReads.delete(msg.id);
            const c = Array.isArray(msg.contents) ? msg.contents[0] : null;
            const html = c && typeof c.text === "string" ? c.text : null;
            if (html == null) return;
            try {
                renderMcpApp({
                    id: req.resourceUri,
                    html,
                    toolArguments: req.tool ? req.tool.arguments : undefined,
                    toolResult: req.result
                });
            } catch { /* ignore */ }
        } else if (msg.type === "call.res") {
            resolveMcpCall(msg.id, msg.result);
        } else if (msg.type === "open") {
            // Plain artifact push (not an MCP App): the server asks the dock to open
            // ordinary content (html/markdown/code/pdf/image/csv) the same way a chip
            // click / __dockView.load would — no widget handshake involved.
            try { load({ name: msg.name || "artifact", html: msg.html ?? null, url: msg.url ?? null, type: msg.type2 ?? undefined }); } catch { /* ignore */ }
        } else if (msg.type === "artifact" && typeof msg.code === "string") {
            // Claude-artifact push: render TSX `msg.code` with the artifact runtime.
            // The runtime is large (~1.7MB), so fetch it lazily on the first artifact
            // and cache it — later artifacts reuse the cached source and never re-fetch.
            if (mcpRuntime != null) {
                renderArtifactCode(msg);
            } else {
                // The runtime lives on the bridge's http server, which is the ws port
                // + 1 (the bridge's PUSH_PORT — settings only stores the ws port).
                const httpPort = (settings.store.mcpBridgePort || 9820) + 1;
                fetch(`http://127.0.0.1:${httpPort}/runtime.js`)
                    .then(r => r.text())
                    .then(t => { mcpRuntime = t; renderArtifactCode(msg); })
                    .catch(e => console.debug("[dockview] mcp: runtime fetch failed", e));
            }
        }
    });
    const reschedule = () => {
        if (mcpSocket === sock) mcpSocket = null;
        if (!mcpActive) return; // shutting down — no reconnect
        clearTimeout(mcpReconnect);
        mcpReconnect = setTimeout(startMcpClient, 3000);
    };
    sock.addEventListener("close", reschedule);
    sock.addEventListener("error", reschedule);
}

/** Tear the MCP bridge down: cancel any pending reconnect and close the socket.
 *  In-flight ws read correlations are dropped (no socket to answer them). */
export function stopMcpClient(): void {
    clearTimeout(mcpReconnect);
    mcpReconnect = null;
    try { mcpSocket?.close(); } catch { /* ignore */ }
    mcpSocket = null;
    mcpPendingReads.clear();
}

/** Reconnect the bridge after a settings change. Safe no-op while the latch is off
 *  (stop+start collapse to just stop). Called from settings.ts's onChange via a lazy
 *  import (cycle-free). */
export function restartMcpClient(): void {
    if (!mcpActive) return;
    stopMcpClient();
    startMcpClient();
}
