/*
 * Renderer-side bridge to the MAIN-process convertAttachment IPC.
 *
 * Two formats can't be decoded in the renderer — .msg needs Node `Buffer` (OLE/CFB
 * reader) and camera RAW needs a decoder whose web Worker can't run in main — so the
 * MAIN process converts them: it fetches the attachment bytes (Discord-CDN allowlisted,
 * no CSP in main), runs the Node-only library, and returns renderable bytes as base64 +
 * a mime type. This module is the renderer's thin caller: it invokes the IPC exactly
 * the way engine/lazyLib's loadChunk invokes readChunk
 * (VesktopNative.dockview.convertAttachment), then turns the base64 reply
 * into a same-origin `blob:` URL the viewer can drop into an <img> or an iframe.
 *
 * The msg viewer routes the returned text/html into the dark sandboxed iframe shell;
 * the raw viewer wraps the image bytes in a blob: and retypes to "image". Both show the
 * dock's loading state across the (network-fetch-in-main + decode) round-trip.
 */

/** The IPC reply shape (mirrors native.ts ConvertResult). */
interface ConvertReply {
    ok: boolean;
    mime?: string;
    b64?: string;
    error?: string;
}

/** A converted attachment ready for the renderer: the output mime + a same-origin
 *  blob: URL holding the decoded bytes (HTML / PNG / JPEG). */
export interface ConvertedAttachment {
    mime: string;
    blobUrl: string;
}

/** A converted attachment returned as decoded TEXT (for the msg viewer, which feeds
 *  the returned HTML straight into the iframe-shell builder rather than a blob). */
export interface ConvertedText {
    mime: string;
    text: string;
}

/** Decode a base64 string to a Uint8Array (renderer has atob; no Buffer here). */
function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Call the main-process convertAttachment IPC for `kind` ("msg" | "raw") over `url`,
 * and return the decoded bytes as a same-origin blob: URL + its mime. Throws a plain
 * Error (so the viewer surfaces it on the dock error card) when the IPC bridge is
 * missing (build/preload out of date — a relaunch is needed after a main change) or
 * the conversion failed in main.
 *
 * The caller OWNS the returned blobUrl and must URL.revokeObjectURL it on cache
 * eviction (the msg viewer's frame is GC'd with its DOM; the raw viewer's dispose()
 * revokes it, like the dxf/raster retype path).
 */
export async function convertAttachment(kind: "msg" | "raw", url: string, allowRemote = false): Promise<ConvertedAttachment> {
    const native = (window as any).VesktopNative?.dockview;
    if (!native || typeof native.convertAttachment !== "function") {
        throw new Error(
            "DockView: convertAttachment IPC unavailable — relaunch Vesktop to pick up the new main process."
        );
    }

    const reply: ConvertReply = await native.convertAttachment(kind, url, allowRemote);
    if (!reply || !reply.ok) {
        throw new Error(reply?.error || "Couldn't convert this file");
    }
    if (typeof reply.b64 !== "string" || typeof reply.mime !== "string") {
        throw new Error("Conversion returned no data");
    }

    const bytes = base64ToBytes(reply.b64);
    const blob = new Blob([bytes], { type: reply.mime });
    return { mime: reply.mime, blobUrl: URL.createObjectURL(blob) };
}

/**
 * Like convertAttachment, but returns the converted bytes as decoded UTF-8 TEXT
 * instead of a blob: URL — for the msg viewer, which feeds the returned HTML fragment
 * into the dark sandboxed-iframe shell builder (wrapMarkdownDoc + setArtifactHtml),
 * exactly as the .eml viewer does with its own parsed fragment. Throws on the same
 * conditions as convertAttachment (missing bridge / conversion failure). `allowRemote`
 * (the Privacy switch, read by the caller) is forwarded to main's sanitiser so a .msg's
 * remote images load or block to match the .eml path.
 */
export async function convertAttachmentText(kind: "msg" | "raw", url: string, allowRemote = false): Promise<ConvertedText> {
    const native = (window as any).VesktopNative?.dockview;
    if (!native || typeof native.convertAttachment !== "function") {
        throw new Error(
            "DockView: convertAttachment IPC unavailable — relaunch Vesktop to pick up the new main process."
        );
    }

    const reply: ConvertReply = await native.convertAttachment(kind, url, allowRemote);
    if (!reply || !reply.ok) {
        throw new Error(reply?.error || "Couldn't convert this file");
    }
    if (typeof reply.b64 !== "string" || typeof reply.mime !== "string") {
        throw new Error("Conversion returned no data");
    }

    const text = new TextDecoder("utf-8").decode(base64ToBytes(reply.b64));
    return { mime: reply.mime, text };
}
