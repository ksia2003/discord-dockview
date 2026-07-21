/*
 * The MSG viewer — type "msg" (.msg / binary Outlook OLE messages).
 *
 * An Outlook .msg is a binary OLE/CFB container, NOT the RFC 822 text an .eml is, so
 * the renderer can't parse it: @kenjiuno/msgreader needs Node `Buffer`, which the
 * renderer bans. So — unlike the .eml viewer, which parses in the renderer with
 * postal-mime — this viewer asks the MAIN process to do the work: it calls the
 * convertAttachment("msg", url) IPC, which fetches the attachment in main (no CSP
 * there), parses it with msgreader, and returns ONE clean body-HTML fragment — the
 * SAME `dv-eml-*` shape the .eml viewer produces (header card + body + attachment
 * list, remote images neutralised). The viewer then wraps that fragment in the SAME
 * dark sandboxed-iframe doc shell (wrapMarkdownDoc + setArtifactHtml) the .eml/docx
 * viewers use, so it themes + sandboxes identically with no second surface.
 *
 * The whole network-fetch-in-main + parse round-trip runs under content.loading, with
 * a "Converting message…" label, exactly like a heavy renderer lib spinning up.
 *
 * SECURITY: the fragment is built + sanitised in main (remote images → blocked pills,
 * scripts/styles stripped) and rendered inside the doc shell's null-origin
 * `sandbox="allow-scripts"` iframe (no allow-same-origin), so a hostile message can
 * neither reach the host DOM nor phone home.
 *
 * VIEW-ONLY: a parsed .msg has no editable source, so no HeaderControls, no edit mode.
 */

import { convertAttachmentText } from "../../engine/convertAttachment";
import { injectNonce, pageNonce, setArtifactHtml } from "../../engine/nonce";
import { settings } from "../../settings";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, Viewer, ViewerContext
} from "../../engine/types";
import { HtmlBody, wrapMarkdownDoc } from "../doc/iframe";

/** MSG loader: ask main (convertAttachment IPC) to parse the binary message into a
 *  body-HTML fragment → wrap it in the dark doc shell → nonce sandbox iframe. The
 *  verbatim dual-write is preserved (entry always filled, content only while current). */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = STRINGS.error.noSource.title;
        return;
    }
    ctx.content.loading = true;
    ctx.content.loadingLabel = STRINGS.loading.lib.msg;
    ctx.requestRender();

    // The Privacy switch decides whether the message's remote images load; read it live
    // here so a flip applies to the next .msg opened, and forward it to main's sanitiser.
    let allowRemote = false;
    try { allowRemote = settings.store.emailRemoteImages === true; } catch { /* default block */ }

    const reqUrl = opts.url;
    convertAttachmentText("msg", reqUrl, allowRemote)
        .then(({ text }) => {
            // `text` is the dv-eml body fragment built (+ sanitised) in main; wrap it in
            // the dark doc shell (no math) so it themes + sandboxes like the .eml viewer.
            const fullHtml = wrapMarkdownDoc(text, false);
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
            ctx.content.loadingLabel = null;
            ctx.content.error = null;
            ctx.requestRender();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (!token.isCurrent()) return;
            ctx.content.loading = false;
            ctx.content.loadingLabel = null;
            ctx.content.error = String(e?.message || e);
            ctx.requestRender();
        });
}

function createState(): unknown {
    return {};
}
function resetState(): void {
    /* no per-window msg view-state */
}
function snapshot(): void {
    /* nothing format-specific to park */
}
function restore(): void {
    /* nothing format-specific to restore */
}

export const MsgViewer: Viewer = {
    type: "msg",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: HtmlBody,
    // View-only: no HeaderControls (a parsed .msg has no editable source), no findModel,
    // no dispose (the iframe is GC'd with its DOM), no editable capability.
};
