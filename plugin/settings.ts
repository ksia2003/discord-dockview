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

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    // --- General page -------------------------------------------------------
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

    // --- Performance page: DOM optimizer ------------------------------------
    // Defer removal of member-list "activity" DOM nodes by 100ms (OpenAsar trick) so a
    // channel/server switch paints chat first and the cosmetic activity churn settles a
    // beat later. OFF (default) — it patches a global DOM prototype, so it's opt-in. The
    // patch is applied on start() when on and cleanly removed on stop()/toggle-off
    // (domOptimizer.ts). Read at start + on every flip, not per-behaviour.
    domOptimizer: { type: OptionType.BOOLEAN, description: "Defer member-list activity DOM updates for snappier switching", default: false },

    // --- Performance page: voice ---------------------------------------------
    // Fix voice calls hanging on "DTLS Connecting" over a VPN (Tailscale etc.). This
    // mirrors a control that lives in MAIN (setWebRTCIPHandlingPolicy on every web
    // contents). ON (default, opt-out) selects the public/private interfaces on the
    // operating system's default route, avoiding non-default VPN candidates on
    // affected systems. OFF restores stock Chromium interface selection. The value
    // persists here and is mirrored into Vesktop's main settings; on plugin start and
    // every flip the panel pushes it to main over the networkPrivacy IPC, and main
    // applies/reverts the policy live.
    voiceFixEnabled: { type: OptionType.BOOLEAN, description: "Fix voice connection over VPN", default: true },
    // Denoise the outgoing microphone with open-source RNNoise (works where Discord's own
    // Krisp doesn't, notably on Linux). OFF (default, opt-in). Entirely renderer-side: on
    // start (when on) and on every flip, noiseSuppression.ts installs/removes a
    // getUserMedia hook that routes the mic through an RNNoise AudioWorklet before Discord
    // sees it. Read at start + on each flip, not per-behaviour.
    noiseSuppression: { type: OptionType.BOOLEAN, description: "Suppress background noise on your microphone (RNNoise)", default: false },

    // --- Privacy page: remote images in email files -------------------------
    // Whether an .eml / .msg body may load its REMOTE <img> (http/https). OFF (default) =
    // remote images are blocked (replaced with a "blocked" pill) so no tracking-pixel
    // request is ever made. ON = remote images load. The .eml path reads this live in the
    // renderer (email.ts); the .msg path plumbs it as an argument through the
    // convertAttachment IPC into main's sanitiser (main stays stateless).
    emailRemoteImages: { type: OptionType.BOOLEAN, description: "Load remote images in email attachments", default: false },

    // --- Privacy page: network (tracker firewall + proxy) -------------------
    // These mirror controls that actually live in MAIN (the default session's
    // webRequest + setProxy). The UI value persists here; on plugin start and on
    // every flip the panel pushes the current value to main over the networkPrivacy
    // IPC, so main holds only the live config and the panel reflects the saved state.
    //
    // The firewall blocks tracker/telemetry requests (science/analytics/error-
    // reporting endpoints, with an allowlist guard so normal traffic isn't broken).
    // Default ON — main also defaults it ON so blocking is live from the first
    // request, before this pushes anything.
    firewallEnabled: { type: OptionType.BOOLEAN, description: "Block tracker and telemetry requests", default: true },
    // Route traffic through an HTTP/SOCKS proxy. OFF (default) = direct connection.
    // proxyRules/proxyBypass are the two strings passed to session.setProxy.
    proxyEnabled: { type: OptionType.BOOLEAN, description: "Route traffic through a proxy", default: false },
    proxyRules: { type: OptionType.STRING, description: "Proxy rules", default: "" },
    proxyBypass: { type: OptionType.STRING, description: "Proxy bypass rules", default: "" },

    // --- Privacy page: message encryption (StegCloak) -----------------------
    // The MASTER switch for the message-encryption feature. OFF (default) = fully
    // inert: the FluxDispatcher receive patch is a passthrough, the ChatBar toggle
    // is disabled, nothing is encrypted or decrypted. ON = the feature arms once at
    // least one password exists (the passwords live in the OS keychain via
    // safeStorage, NOT here). messageEncryption.ts reads this live on start + every
    // flip. The per-send toggle is the ChatBar button, not a setting — it's never
    // persisted, so a restart never silently encrypts.
    messageEncryption: { type: OptionType.BOOLEAN, description: "Encrypt messages (zero-width StegCloak)", default: false },
    // The visible cover text a hidden ciphertext is embedded into (StegCloak needs a
    // ≥2-word carrier). Recipients without the feature just see this string. Default
    // is a neutral phrase; the Privacy panel lets the user change it.
    encryptionCover: { type: OptionType.STRING, description: "Cover text for encrypted messages", default: "This is a confidential message" },
    // The marker prepended to a message AFTER it's decrypted, so the reader can tell a
    // message was received encrypted. Read live on each decrypt. Empty = no marker.
    encryptionMark: { type: OptionType.STRING, description: "Prefix shown on decrypted messages", default: "🔒 " },

    // --- Privacy page: Invidious embeds -------------------------------------
    // Route YouTube embeds through an Invidious instance (a privacy frontend) instead
    // of youtube.com, so Google never receives the request a YT embed makes from the
    // client. OFF (default, opt-in) = embeds stay on youtube.com. The rewrite is a code
    // patch on Discord's embed builder (index.tsx `patches`); invidiousEmbeds.ts reads
    // this + the instance below LIVE at render time, so a flip applies to the next embed
    // with no reload. Version-fragile by nature (minified target) — hence off by default.
    invidiousEmbeds: { type: OptionType.BOOLEAN, description: "Route YouTube embeds through Invidious", default: false },
    // The Invidious instance origin YT embeds are pointed at when the toggle is on. A
    // public instance by default; the user can point it at any instance (or self-host).
    invidiousInstance: { type: OptionType.STRING, description: "Invidious instance URL", default: "https://inv.nadeko.net" },

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
