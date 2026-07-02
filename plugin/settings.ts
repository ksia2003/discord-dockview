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
 * This module is imported by index.tsx (which wires `settings` into the plugin
 * def). It must therefore NOT import index.tsx at module top level, or we'd create
 * an import cycle. The onChange handlers reach the bridge LAZILY via a dynamic
 * import so the cycle never forms and the call is a safe no-op while the panel
 * isn't running.
 *
 * The settings here are STORE-ONLY: there is no OptionType.COMPONENT entry, so the
 * keys never render in Vencord's plugin-settings page (the plugin is `hidden`
 * anyway). The MCP keys are PARKED — the bridge is registered only behind these
 * toggles; there is no MCP UI in the DockView settings section (it was dropped in
 * the settings-panel rework; the mcp/ code stays for a separate cleanup pass).
 *
 * The dockview.* / viewers* keys back the DockView settings SECTION (General + Viewers
 * pages, ui/settings pages). They're read at RUNTIME through `settings.store.<key>` at
 * the moment a behaviour runs (a chip click, a dock open, a media mount, a channel
 * switch), so a toggle takes effect LIVE with no reload. The dock WIDTH is NOT here —
 * it persists through DataStore (engine/persist.ts LS_WIDTH), one width store shared
 * with the drag-resize; the General page's slider drives that same store, not a copy.
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
    },

    // --- General page -------------------------------------------------------
    // Collapse the member list / profile sidebar while the dock is open (the
    // native-thread exclusivity). ON = current behaviour. OFF = the dock opens
    // WITHOUT touching the member list; the open path skips syncNativeMemberList/
    // syncNativeProfileSidebar so nothing is collapsed and nothing is owed a restore.
    dockExclusivity: {
        type: OptionType.BOOLEAN,
        description: "Collapse the member list while the dock is open",
        default: true
    },
    // Autoplay audio/video when a media file opens in the dock. OFF (default) = the
    // element mounts paused with controls; the user presses play. ON = the media body
    // requests autoplay (muted-fallback if the browser blocks unmuted autoplay).
    dockMediaAutoplay: {
        type: OptionType.BOOLEAN,
        description: "Autoplay media when opened",
        default: false
    },
    // Remember the open file per channel. ON (default) = switching channels re-shows
    // the file the dock had open in each channel (engine/channelMemory). OFF = a
    // channel switch does NOT reopen the previous file; the dock state doesn't stick.
    dockPerChannelMemory: {
        type: OptionType.BOOLEAN,
        description: "Remember the open file per channel",
        default: true
    },

    // --- Viewers page: master switch ----------------------------------------
    // Open attachments in the dock. ON (default) = the chip interception is live.
    // OFF = interception fully off; attachments behave like stock Discord (download /
    // native lightbox). embed.ts's isPanelUrl short-circuits when this is off.
    viewersMaster: {
        type: OptionType.BOOLEAN,
        description: "Open attachments in the dock",
        default: true
    },

    // --- Viewers page: per-category switches (all default ON) ---------------
    // Each gates its category's detection so an OFF category's chips fall back to stock
    // Discord (engine/categoryMap.ts maps every ContentType to one of these). embed.ts
    // consults categoryEnabled(type) in the detection path, so an off category never
    // opens the dock and never half-renders.
    viewerDocuments: { type: OptionType.BOOLEAN, description: "Documents", default: true },
    viewerSpreadsheets: { type: OptionType.BOOLEAN, description: "Spreadsheets", default: true },
    viewerImages: { type: OptionType.BOOLEAN, description: "Images", default: true },
    viewerExoticImages: { type: OptionType.BOOLEAN, description: "Exotic images", default: true },
    viewerCodeText: { type: OptionType.BOOLEAN, description: "Code & text", default: true },
    viewerDiagrams: { type: OptionType.BOOLEAN, description: "Diagrams", default: true },
    viewerModels3d: { type: OptionType.BOOLEAN, description: "3D models", default: true },
    viewerMedia: { type: OptionType.BOOLEAN, description: "Media", default: true },
    viewerPresentations: { type: OptionType.BOOLEAN, description: "Presentations", default: true },

    // --- Performance page: heavy-decoder loading mode ------------------------
    // Each of these picks how a heavy, exotic decoder (an out-of-bundle chunk) loads:
    // "ondemand" (default) loads it the first time such a file opens; "preload" warms
    // it once after startup idle so the first open is instant; "disabled" refuses to
    // load it and shows a notice card instead. STRING keys, not booleans, holding one
    // of those three tokens. engine/decoderModes.ts is the SSOT that maps each chunk
    // key to one of these settings fields + reads them LIVE, so a mode change affects
    // the NEXT load (already-loaded chunks stay loaded). See DECODER_CONTROLS there.
    decoderModeThree: { type: OptionType.STRING, description: "3D model decoder loading", default: "ondemand" },
    decoderModeGhostscript: { type: OptionType.STRING, description: "EPS / AI decoder loading", default: "ondemand" },
    decoderModeAgpsd: { type: OptionType.STRING, description: "PSD decoder loading", default: "ondemand" },
    decoderModeJxl: { type: OptionType.STRING, description: "JPEG XL decoder loading", default: "ondemand" },
    decoderModeDicom: { type: OptionType.STRING, description: "DICOM decoder loading", default: "ondemand" },

    // --- Performance page: large-image quality ------------------------------
    // How the exotic raster path (tiff/psd/heic/jp2/jxl decode → canvas → blob) exports
    // a LARGE frame (> 8 MP). OFF (default) = JPEG past the threshold, so a huge PSD/TIFF
    // doesn't balloon into a multi-hundred-MB PNG copy in memory. ON = always PNG
    // (lossless), at the cost of that larger in-memory blob. Read live by
    // RasterImageViewer.rgbaToBlobUrl at export time.
    largeImageLossless: { type: OptionType.BOOLEAN, description: "Always convert large images losslessly (PNG)", default: false }
});
