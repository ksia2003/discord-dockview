/*
 * DockView — Vencord plugin settings.
 * ---------------------------------------------------------------------------
 * These back the DockView settings SECTION (General + Viewers + Performance +
 * Privacy + Updates pages, ui/settings). They persist through Vencord's own
 * settings store, NOT localStorage: Discord's renderer DELETES window.localStorage
 * (it reads back `undefined`), so a localStorage-backed value never survives, while
 * Vencord's store is available in the isolated renderer context.
 *
 * Every key is read at RUNTIME through `settings.store.<key>` at the moment a
 * behaviour runs (a chip click, a dock open, a media mount, a channel switch), so a
 * toggle takes effect LIVE with no reload. The dock WIDTH is NOT here — it persists
 * through DataStore (engine/persist.ts LS_WIDTH), one width store shared with the
 * drag-resize; the General page's slider drives that same store, not a copy.
 *
 * This module is imported by index.tsx (which wires `settings` into the plugin def),
 * so it must NOT import index.tsx at module top level, or we'd create an import cycle.
 */

import { definePluginSettings } from "@vencord/types/api/Settings";

// Vencord's OptionType is a const enum and therefore has no runtime export.
// Keep the wire values locally so the independent renderer does not depend on
// Vencord's internal @utils/types alias.
const enum OptionType {
    STRING,
    NUMBER,
    BIGINT,
    BOOLEAN,
    SELECT,
    SLIDER,
    COMPONENT,
    CUSTOM
}

export const settings = definePluginSettings({
    // --- General page -------------------------------------------------------
    // What the global F9 shortcut does. "width" preserves the existing compact ↔
    // expanded switch. "hide" temporarily removes the dock from layout; an explicit
    // new-tab action reveals it again. Kept as a string so the custom General page can
    // present the two behaviours through Discord's native Select component.
    f9Behavior: {
        type: OptionType.STRING,
        description: "F9 shortcut behavior",
        default: "width"
    },
    // ON (default) projects the captured guild Members ListScroller into two or three
    // native-width cells as the DockView rail grows. OFF returns the exact native props.
    membersMultiColumn: {
        type: OptionType.BOOLEAN,
        description: "Use multiple member columns when space allows",
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
    // Receive development (pre-release) builds via the in-app updater. OFF (default) = the
    // updater only offers full releases; ON = it also offers GitHub pre-releases (our dev
    // builds). discoverManifest reads this to widen the release filter (see UpdatePanel).
    devChannel: {
        type: OptionType.BOOLEAN,
        description: "Receive development builds",
        default: false
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
    largeImageLossless: { type: OptionType.BOOLEAN, description: "Always convert large images losslessly (PNG)", default: false },

    // --- Privacy page: remote images in email files -------------------------
    // Whether an .eml / .msg body may load its REMOTE <img> (http/https). OFF (default) =
    // remote images are blocked (replaced with a "blocked" pill) so no tracking-pixel
    // request is ever made. ON = remote images load. The .eml path reads this live in the
    // renderer (email.ts); the .msg path plumbs it as an argument through the
    // convertAttachment IPC into main's sanitiser (main stays stateless).
    emailRemoteImages: { type: OptionType.BOOLEAN, description: "Load remote images in email attachments", default: false },

    // --- Updates page: automatic background check ---------------------------
    // ON (default) = on plugin start, once per day, DockView checks GitHub for a newer
    // build off the startup critical path (idle) and, if one is found, raises a one-time
    // notice + highlights the Updates row. It NEVER auto-applies — the user still clicks
    // Apply. OFF = no background check; the Updates page still checks on demand. The
    // Updates page's "Check for updates automatically" switch drives this key.
    autoCheckUpdates: { type: OptionType.BOOLEAN, description: "Check for updates automatically", default: true },
    // The UNIX-ms timestamp of the last automatic check (0 = never). Persisted so the
    // once-per-24h throttle survives restarts; not shown in any page, just bookkeeping
    // the auto-check reads/writes. A STRING (OptionType.NUMBER coerces via the slider UI
    // machinery, which we don't use here) holding the decimal ms — parsed on read.
    lastAutoCheck: { type: OptionType.STRING, description: "Last automatic update check (internal)", default: "0", hidden: true }
});
