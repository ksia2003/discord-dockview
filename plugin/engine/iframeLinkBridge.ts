/* Link behavior shared by every sandboxed document/artifact iframe. The null-origin
 * frame cannot open Electron/Vencord UI itself, so it reports normal clicks and link
 * context-menu requests to the host. In-page anchors remain owned by the document. */

/** Only these schemes may cross the sandbox boundary. Relative and protocol-relative
 * links are resolved by the host against the active artifact URL. */
export function isAllowedIframeRawLink(raw: string): boolean {
    const href = raw.trim();
    if (!href || href[0] === "#") return false;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1];
    return scheme == null || /^(https?|mailto)$/i.test(scheme);
}

/** Resolve a reported iframe href without allowing a non-web scheme to become a
 * navigable host URL. `mailto:` is intentionally retained for openExternalLink. */
export function resolveIframeLink(raw: string, base: string): string | null {
    if (!isAllowedIframeRawLink(raw)) return null;
    try {
        const url = new URL(raw.trim(), base);
        return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
            ? url.href
            : null;
    } catch {
        return null;
    }
}

export function canOpenIframeDock(href: string): boolean {
    try {
        const protocol = new URL(href).protocol;
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

export interface IframeSourceFrame {
    contentWindow: unknown;
    isConnected?: boolean;
    style?: { display?: string; };
    src?: string;
}

/** Find a live, visible iframe for a postMessage sender. Keeping this as a small
 * structural helper makes the sender-ownership rule testable without a DOM runtime. */
export function iframeForSource(
    source: unknown,
    frames: readonly IframeSourceFrame[]
): IframeSourceFrame | null {
    if (!source) return null;
    return frames.find(frame => frame.contentWindow === source
        && frame.isConnected !== false
        && frame.style?.display !== "none") ?? null;
}

/** srcdoc frames generally expose no useful `src`; in that case the active file URL
 * is the only correct base. A real HTTP(S) src wins when the frame supplies one. */
export function iframeLinkBase(frame: Pick<IframeSourceFrame, "src">, activeBase: string): string {
    if (!frame.src || frame.src === "about:blank") return activeBase;
    try {
        const url = new URL(frame.src, activeBase);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : activeBase;
    } catch {
        return activeBase;
    }
}

export const IFRAME_LINK_BRIDGE = `<script>(function(){
  function linkFrom(e) {
    return e.target && e.target.closest ? e.target.closest("a[href]") : null;
  }
  function safeHref(href) {
    var value = (href || "").trim();
    if (!value || value[0] === "#") return false;
    var scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
    return !scheme || /^(https?|mailto)$/i.test(scheme[1]);
  }
  document.addEventListener("click", function(e){
    var a = linkFrom(e);
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!href || href[0] === "#") return;
    if (!safeHref(href)) { e.preventDefault(); return; }
    e.preventDefault();
    try { parent.postMessage({ __dockViewOpenLink: href }, "*"); } catch (_) {}
  }, true);
  document.addEventListener("contextmenu", function(e){
    var a = linkFrom(e);
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!href || href[0] === "#") return;
    if (!safeHref(href)) { e.preventDefault(); return; }
    e.preventDefault();
    try { parent.postMessage({ __dockViewLinkContext: {
      href: href, clientX: e.clientX || 0, clientY: e.clientY || 0
    } }, "*"); } catch (_) {}
  }, true);
})();</script>`;

/** Raw self-contained HTML does not pass through the markdown wrapper. Inject the same
 * bridge immediately before </body> (or at EOF), unless the document already contains
 * it. This changes link escape behavior only; the original body/UI stays verbatim. */
export function ensureIframeLinkBridge(html: string): string {
    if (html.includes("__dockViewOpenLink")) return html;
    if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${IFRAME_LINK_BRIDGE}</body>`);
    return html + IFRAME_LINK_BRIDGE;
}
