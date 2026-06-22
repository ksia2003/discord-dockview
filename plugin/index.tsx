/*
 * DockView — Vencord userplugin.
 * ---------------------------------------------------------------------------
 * Ported from the Vesktop fork's right-docked multi-format viewer. Clicking a
 * panel-renderable attachment chip (.artifact/.html, .pdf, code/text, .md)
 * opens it in a right-docked panel that clones Discord's native thread sidebar:
 *   - HTML artifact -> interactive nonce-stamped sandbox iframe
 *   - PDF           -> pdf.js canvases (main-thread worker, CSP-safe)
 *   - code/text     -> highlight.js <pre><code> (selectable, scrollable)
 *   - markdown      -> marked -> dark-themed sandbox iframe
 * Toggle with Ctrl+Alt+P; mutually exclusive with the member list. LaTeX in
 * Discord markdown is rendered via KaTeX.
 *
 * target DESKTOP: the artifact/PDF/markdown renderers rely on the CSP nonce
 * trick + main-thread pdf worker that only hold under the desktop client.
 */

import definePlugin from "@utils/types";
import { Menu, React } from "@webpack/common";

import managedStyle from "./style.css?managed";

import { startEmbed, stopEmbed } from "./embed";
import { startLatex, stopLatex } from "./latex";
import { exposeDebug, onChannelSelect, onChannelSidebarView, onMemberSectionToggle, onNewFile, onUserProfileSidebarToggle, startPanel, stopPanel, unexposeDebug } from "./panel";
import { settings } from "./settings";
import { STRINGS } from "./strings";

export default definePlugin({
    name: "DockView",
    description: "Click an attachment chip or inline image to render it in a right-docked, native-style panel: HTML artifacts, PDF, code, markdown, and images (Ctrl+Alt+P to toggle; mutually exclusive with the member list; remembers per channel; PDF refits on resize).",
    authors: [{ name: "seonin", id: 0n }],
    target: "DESKTOP",

    // MCP bridge connect info (enable toggle + token + port) persists through
    // Vencord's settings store, NOT localStorage — Discord deletes
    // window.localStorage in the renderer, so a localStorage-backed token never
    // survived. Read at connect time inside startMcpClient(); see settings.ts.
    settings,

    // Managed style: Vencord auto-enables this CSS when the plugin starts and
    // disables it on stop (so style.css is tied to the plugin's on/off state).
    managedStyle,

    // Per-channel panel memory: Discord fires CHANNEL_SELECT on every channel
    // switch. We save the leaving channel's panel state and restore the entered
    // channel's (re-load its remembered file, or leave the panel closed/empty).
    //
    // Reverse member-list parity: the member list / DM user-profile sidebar share
    // the exclusive right slot with a thread (and with our panel). Clicking those
    // header buttons fires these toggle actions — when our panel holds the slot we
    // close it so the sidebar can take over, exactly as opening members evicts a
    // thread. (Our own open/close member-list toggles are filtered inside the
    // handler via a self-dispatch flag.)
    flux: {
        CHANNEL_SELECT({ channelId }: { channelId: string | null; }) {
            onChannelSelect(channelId ?? null);
        },
        CHANNEL_TOGGLE_MEMBERS_SECTION() {
            onMemberSectionToggle();
        },
        SIDEBAR_VIEW_CHANNEL() {
            onChannelSidebarView();
        },
        USER_PROFILE_SIDEBAR_TOGGLE_SECTION() {
            onUserProfileSidebarToggle();
        }
    },

    // "New file" entry point in Discord's `+` composer menu (navId
    // "channel-attach"): opens the dock with an EMPTY editable surface (the same
    // CodeMirror editor every viewer uses, in EDIT mode, default markdown). The
    // user writes a brand-new file in the dock and attaches it via the second-row
    // Attach toolbar — no original baseline, so it edits as a plain editor with no
    // merge diff. Registering this auto-adds the ContextMenu API as a dependency.
    contextMenus: {
        "channel-attach": (children: any, props: any) => {
            children.push(
                React.createElement(Menu.MenuItem, {
                    id: "dockview-new-file",
                    label: STRINGS.menu.newFile,
                    action: () => onNewFile(props?.channel ?? null)
                })
            );
        }
    },

    start() {
        startPanel();
        startEmbed();
        startLatex();
        exposeDebug();
    },

    stop() {
        stopEmbed();
        stopPanel();
        stopLatex();
        unexposeDebug();
    }
});
