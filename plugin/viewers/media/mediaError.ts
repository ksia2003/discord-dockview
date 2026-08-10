/** Pure stale-guard seam for native audio/video decode failures. */

export const MEDIA_DECODE_ERROR = "Media element failed to decode";

interface MediaErrorWindow {
    content: {
        type?: string;
        seq: number;
        loading: boolean;
        error: string | null;
    };
    openRollback?: unknown;
}

/** Probe-owned settlement is descriptor/token guarded by mediaProbe, so it must
 * survive content.seq changes caused only by focusing the same tab again. */
export function markPendingMediaLoaded(bodyWindow: MediaErrorWindow): boolean {
    if (!isPendingMediaOpen(bodyWindow)) return false;
    bodyWindow.content.loading = false;
    bodyWindow.content.error = null;
    bodyWindow.openRollback = null;
    return true;
}

export function markPendingMediaDecodeError(
    bodyWindow: MediaErrorWindow,
    message = MEDIA_DECODE_ERROR
): boolean {
    if (!isPendingMediaOpen(bodyWindow)) return false;
    bodyWindow.content.loading = false;
    bodyWindow.content.error = message;
    return true;
}

/** A new media tab stays provisional until the native element proves it can decode.
 * Do not key this on content.loading: a ready cache mount can overwrite that bit
 * before DockPanel re-applies the window-only hold. */
export function isPendingMediaOpen(bodyWindow: MediaErrorWindow): boolean {
    return bodyWindow.openRollback != null
        && (bodyWindow.content.type === "audio" || bodyWindow.content.type === "video");
}

/** Keep only a newly-created media window provisional. This also repairs the cache-hit
 * path, where mountFromCache restores the ready cache entry's `loading=false` payload. */
export function holdPendingMediaOpen(bodyWindow: MediaErrorWindow): boolean {
    if (bodyWindow.openRollback == null
        || bodyWindow.content.error != null
        || (bodyWindow.content.type !== "audio" && bodyWindow.content.type !== "video")) return false;
    bodyWindow.content.loading = true;
    return true;
}

/** Settle a provisional media open after loadedmetadata/canplay. */
export function markMediaLoaded(bodyWindow: MediaErrorWindow, seq: number): boolean {
    if (bodyWindow.content.seq !== seq
        || (!bodyWindow.content.loading && bodyWindow.openRollback == null && bodyWindow.content.error == null)) return false;
    bodyWindow.content.loading = false;
    bodyWindow.content.error = null;
    if (bodyWindow.openRollback != null) bodyWindow.openRollback = null;
    return true;
}

/** Publish a native media failure only if the body-captured window still has the
 * same content sequence. The window need not remain active: settlePendingOpens scans
 * inactive provisional windows and needs this error signal to remove them too. */
export function markMediaDecodeError(
    bodyWindow: MediaErrorWindow,
    seq: number,
    message = MEDIA_DECODE_ERROR
): boolean {
    if (bodyWindow.content.seq !== seq) return false;
    bodyWindow.content.loading = false;
    bodyWindow.content.error = message;
    return true;
}
