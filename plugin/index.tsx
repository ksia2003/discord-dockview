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
import managedStyle from "./style.css?managed";

import { startEmbed, stopEmbed } from "./embed";
import { startLatex, stopLatex } from "./latex";
import { exposeDebug, onChannelSelect, startPanel, stopPanel, unexposeDebug } from "./panel";

export default definePlugin({
    name: "DockView",
    description: "첨부/이미지 클릭 → 우측 도킹 패널에 HTML artifact / PDF / 코드 / 마크다운 / 이미지를 렌더 (Ctrl+Alt+P 토글, 멤버목록 상호배타, 채널별 기억, PDF 리사이즈 재맞춤). Click an attachment chip or inline image to render it in a native-style docked panel.",
    authors: [{ name: "seonin", id: 0n }],
    target: "DESKTOP",

    // Managed style: Vencord auto-enables this CSS when the plugin starts and
    // disables it on stop (so style.css is tied to the plugin's on/off state).
    managedStyle,

    // Per-channel panel memory: Discord fires CHANNEL_SELECT on every channel
    // switch. We save the leaving channel's panel state and restore the entered
    // channel's (re-load its remembered file, or leave the panel closed/empty).
    flux: {
        CHANNEL_SELECT({ channelId }: { channelId: string | null; }) {
            onChannelSelect(channelId ?? null);
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
