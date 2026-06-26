/*
 * The CSP nonce machinery for the artifact iframe — VERBATIM.
 *
 * Discord's host document carries a per-load CSP nonce on its own scripts. An
 * artifact iframe's inline scripts only run if they carry the SAME nonce, so we
 * stamp it on. This is load-bearing for artifact rendering under CSP and is
 * preserved exactly from the monolith.
 *
 * injectNonce stamps ONLY inline scripts: it skips a <script> that already has a
 * nonce and skips an external `src=` script (stamping those is pointless and
 * nonce-attr + a src is the classic trap). The `<script(\s[^>]*)?>` substring
 * match is deliberate — it matches the opening tag including a bare `<script>`.
 *
 * (The sandbox itself is `sandbox="allow-scripts"` ONLY — never allow-same-origin
 * = null-origin — set where the iframe is built, in the doc viewer; this module
 * only handles the nonce.)
 */

import { escapeHtml } from "./html";
import type { PanelContent } from "./types";

export { escapeHtml };
export { escapeAttr } from "./html";

/** The per-load CSP nonce the host document's own scripts carry. */
export function pageNonce(): string | null {
    try {
        const sc = document.querySelector<HTMLScriptElement>("script[nonce]");
        return sc ? sc.nonce || sc.getAttribute("nonce") : null;
    } catch {
        return null;
    }
}

/** Stamp the host page's CSP nonce onto every INLINE <script> so it runs. */
export function injectNonce(html: string, nonce: string): string {
    return html.replace(/<script(\s[^>]*)?>/gi, (full, attrs) => {
        const a = attrs || "";
        if (/\snonce\s*=/i.test(a)) return full; // already nonced
        if (/\ssrc\s*=/i.test(a)) return full; // external script: leave alone
        return `<script${a} nonce="${nonce}">`;
    });
}

/** Set a content's body HTML + build the nonce-stamped srcdoc the iframe renders.
 *  Operates on the passed content (the engine has no ambient `activeWindow` for
 *  viewers — the html viewer hands its content in). */
export function setArtifactHtml(content: PanelContent, html: string): void {
    content.html = html;
    const nonce = pageNonce();
    content.frameHtml = nonce ? injectNonce(html, nonce) : html;
}
