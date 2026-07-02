/*
 * The EMAIL viewer — type "email" (.eml / MIME messages).
 *
 * An .eml is an RFC 822 / MIME text message, so the loader fetches it as an
 * ArrayBuffer and parses it with postal-mime, then builds ONE body-HTML fragment
 * (a header card + the message body + an attachment list) with emailToHtml() and
 * pushes it through the SAME dark sandboxed-iframe document the docx / rtf / odt
 * viewers use (wrapMarkdownDoc + the engine's nonce machinery via setArtifactHtml).
 *
 * SECURITY: emailToHtml() neutralises remote content BEFORE it reaches the iframe —
 * remote <img> become "blocked" pills (no tracking-pixel fetch), scripts/iframes/
 * styles are stripped, and inline cid: images are rewritten to data: URLs. Combined
 * with the doc shell's null-origin `sandbox="allow-scripts"` (no allow-same-origin),
 * a hostile email can neither reach the host DOM nor phone home. See email.ts.
 *
 * VIEW-ONLY: there is no editable source for a parsed .eml, so it has no
 * HeaderControls and never enters edit mode (no capabilities.editable).
 *
 * postal-mime is pulled in with a DYNAMIC import() routed through engine/lazyLib, so
 * its module top-level leaves Vencord startup and only runs on the first .eml opened,
 * behind a "Loading email viewer…" dock state. It's a small (~70 KB) data-light lib,
 * so it stays inline (not an out-of-bundle chunk).
 *
 * NO module-top executable work — only imports + function decls; emailToHtml is only
 * CALLED inside load().
 */

import { withLibLoading } from "../../engine/lazyLib";
import { injectNonce, pageNonce, setArtifactHtml } from "../../engine/nonce";
import { settings } from "../../settings";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { HtmlBody, wrapMarkdownDoc } from "../doc/iframe";
import { emailToHtml, type ParsedEmail } from "./email";

/** EMAIL loader: fetch as ArrayBuffer → postal-mime parse → header+body+attachments
 *  HTML → dark doc shell → nonce sandbox iframe. The verbatim dual-write is preserved
 *  (entry always filled, content only while the token is current). */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = STRINGS.error.noSource.title;
        return;
    }
    ctx.content.loading = true;
    const reqUrl = opts.url;
    ctx.fetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.arrayBuffer();
        })
        .then(async buf => {
            const PostalMime: any = await withLibLoading(ctx, STRINGS.loading.lib.email, "postal-mime",
                async () => (await import("postal-mime")).default);
            // postal-mime exposes both a static parse and an instance parse; use the
            // instance form (works across versions) on the raw bytes.
            const parser = new PostalMime();
            const email: ParsedEmail = await parser.parse(buf);
            return email;
        })
        .then(email => {
            // Build the body fragment and wrap it in the dark doc shell (no math) so it
            // themes + sandboxes identically. The Privacy switch decides whether remote
            // images load; read it live here so a flip applies to the next .eml opened.
            let allowRemote = false;
            try { allowRemote = settings.store.emailRemoteImages === true; } catch { /* default block */ }
            const fullHtml = wrapMarkdownDoc(emailToHtml(email, allowRemote), false);
            if (entry) {
                entry.html = fullHtml;
                const nonce = pageNonce();
                entry.frameHtml = nonce ? injectNonce(fullHtml, nonce) : fullHtml;
                entry.loading = false;
                entry.error = null;
            }
            if (!token.isCurrent()) return;
            setArtifactHtml(ctx.content, fullHtml);
            ctx.content.loading = false;
            ctx.content.error = null;
            ctx.requestRender();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (!token.isCurrent()) return;
            ctx.content.loading = false;
            ctx.content.error = String(e?.message || e);
            ctx.requestRender();
        });
}

function createState(): unknown {
    return {};
}
function resetState(): void {
    /* no per-window email view-state */
}
function snapshot(): void {
    /* nothing format-specific to park */
}
function restore(): void {
    /* nothing format-specific to restore */
}

export const EmailViewer: Viewer = {
    type: "email",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: HtmlBody,
    // View-only: no HeaderControls (a parsed .eml has no editable source), no findModel,
    // no dispose (the iframe is GC'd with its DOM), no editable capability.
};
