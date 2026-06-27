/*
 * The MCP-app viewer — type "mcpapp" — PARKED behind the settings toggle.
 *
 * This is NOT a file format: there is no chip / detectType path that produces
 * "mcpapp". An mcpapp body only ever appears because the WS bridge (bridge.ts)
 * pushed a widget and called renderMcpApp(), which load()s inline html as type
 * "mcpapp". So this viewer is only ever reached while the bridge is connected,
 * and it is registered ONLY when settings.store.mcpBridgeEnabled (see index.ts /
 * maybeRegisterMcpViewer). With the toggle off it is never in the registry, so
 * getViewer("mcpapp") is undefined and the engine's router lands on its graceful
 * unsupported state — the dock never even knows mcpapp exists.
 *
 * The body (McpAppBody) is a HARD-sandboxed iframe: sandbox="allow-scripts" ONLY
 * — NO allow-same-origin, so the frame is a null origin and an AI-pushed widget
 * can't reach the host DOM. This mirrors the doc family's HtmlBody sandbox exactly
 * and is load-bearing (carried verbatim from the monolith). The difference from
 * HtmlBody: on mount we register the frame's contentWindow with the JSON-RPC host
 * (host.ts) keyed by the appId, so the host can post into it and attribute its
 * frame→host posts back by matching event.source.
 *
 * NO module-top work: only imports, function decls, and the exported viewer literal
 * (a pure object of function refs). React is read inside the body, never destructured
 * at module top; no engine calls, no @webpack destructure, no iframe at eval.
 */

import { React } from "@webpack/common";

import { injectNonce, pageNonce } from "../engine/nonce";
import { getActiveWindow } from "../engine/window";
import type {
    CacheEntry, LoadOpts, LoadToken, McpAppViewState, Viewer, ViewerContext
} from "../engine/types";
import { bindMcpFrame, unbindMcpFrame } from "./host";

/** The per-window mcpapp view-state slice (the launched app's id). Read defensively
 *  since the slice only exists on windows built while the viewer was registered. */
function mcpState(win = getActiveWindow()): McpAppViewState {
    let vs = win.viewStates["mcpapp"] as McpAppViewState | undefined;
    if (!vs) {
        vs = { appId: null };
        win.viewStates["mcpapp"] = vs;
    }
    return vs;
}

/** MCP-app loader. Renders bridge-pushed HTML in the sandboxed (allow-scripts ONLY)
 *  iframe like an inline artifact, but stamps the host nonce so its inline scripts
 *  run under CSP, and records the app id so the JSON-RPC host can route to it. The
 *  html arrives inline on opts.code (renderMcpApp threads it through load()'s html
 *  field), so it is never cached and `entry` is always null here — matching the
 *  monolith's loadMcpApp signature. */
function load(opts: LoadOpts, _token: LoadToken, _entry: CacheEntry | null, ctx: ViewerContext): void {
    const html = opts.code || "";
    const nonce = pageNonce();
    ctx.content.html = html;
    ctx.content.frameHtml = nonce ? injectNonce(html, nonce) : html;
    ctx.content.loading = false;
    ctx.content.error = null;
    // id was threaded through renderMcpApp → load({ id }) → showContent; the engine
    // doesn't surface it on LoadOpts, so fall back to the name (renderMcpApp passes
    // the same value for both). The bridge always sets a stable id.
    mcpState(ctx.window).appId = opts.name;
}

function createState(): McpAppViewState {
    return { appId: null };
}
function resetState(vs: McpAppViewState): void {
    vs.appId = null;
}
/** mcpapp bodies are inline html (no url) so they are never cached — snapshot/restore
 *  are inert. Restore re-seeds the appId from the entry name on the off chance an
 *  mcpapp entry is ever mounted from cache (mirrors the monolith's restore arm). */
function snapshot(): void {
    /* inline html, not cached */
}
function restore(_vs: McpAppViewState, entry: CacheEntry): void {
    mcpState(getActiveWindow()).appId = entry.name || "artifact";
}

/** The MCP-app body: the widget HTML in a HARD-sandboxed iframe (sandbox is
 *  "allow-scripts" ONLY — NO allow-same-origin, so the frame is a null origin and
 *  can't reach the host). On mount we register the frame's contentWindow with the
 *  JSON-RPC host keyed by the current appId so the host can post into it and
 *  attribute its posts back (frame→host) by matching event.source; the cleanup
 *  drops the frame + its session. */
function McpAppBody() {
    const { useRef, useEffect } = React;
    const ref = useRef(null as HTMLIFrameElement | null);

    useEffect(() => {
        const appId = mcpState().appId;
        const win = ref.current?.contentWindow;
        if (appId && win) bindMcpFrame(appId, win);
        return () => { if (appId) unbindMcpFrame(appId); };
    }, []);

    const onLoad = () => {
        // re-register on (re)load: the contentWindow may be replaced when srcDoc
        // parses, so keep the registry pointing at the live window.
        const appId = mcpState().appId;
        const win = ref.current?.contentWindow;
        if (appId && win) bindMcpFrame(appId, win);
    };

    return React.createElement("iframe", {
        key: "frame",
        className: "dockview-frame",
        srcDoc: getActiveWindow().content.frameHtml,
        // allow-scripts ONLY (no allow-same-origin): a srcDoc frame with
        // allow-same-origin inherits THIS document's origin, so a script in an
        // untrusted AI-pushed widget could reach the host DOM and escape the
        // sandbox. The host bridge is postMessage (origin-agnostic), so a null
        // origin loses nothing. Mirrors the doc family's HtmlBody.
        sandbox: "allow-scripts",
        ref,
        onLoad
    });
}

export const McpViewer: Viewer<McpAppViewState> = {
    type: "mcpapp",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: McpAppBody
};
