/*
 * The channel file index — every openable attachment in the current channel.
 *
 * This is the DATA SPINE the file browser is built on. Where the image gallery
 * (viewers/image/gallery.ts) lists only IMAGE attachments so the lightbox can step
 * through them, this lists EVERY attachment the dock can open — a .pdf, a .docx, a
 * 3D model, an audio clip — anything detectType() recognises. It is a browser-side
 * catalogue, not a viewer: it fetches nothing on its own and renders nothing. The
 * UI layer (batch 2) reads getChannelFiles() to draw a grid/list and calls
 * loadOlder() when the user scrolls to the end.
 *
 * SOURCE OF TRUTH — the same as the gallery's: MessageStore.getMessages(channelId)
 * gives the client's cached message window (NOT the full history — see the
 * hasMoreBefore/hasMoreAfter flags). Each message's `attachments` array is walked
 * and every attachment that resolves to a known ContentType becomes one entry. To
 * widen the window we page with MessageActions.fetchMessages({ before }) — the
 * exact request the native scroll makes, nothing more (no search API, no eager
 * crawl). The gallery proves this machine live; this module generalises it from
 * "image only" to "all types" and adds a per-channel cache the UI can poll.
 *
 * PER-CHANNEL CACHE + INVALIDATION. Enumerating is O(cached messages); rather than
 * re-walk the store on every UI read, the built list is cached per channel id. A
 * channel switch invalidates the LEAVING channel (invalidate() called from
 * channelMemory.onChannelSelect), so re-entering rebuilds from the store fresh —
 * mirroring how the gallery keys its list by channel id. New messages arriving in
 * the open channel are reflected by a plain re-enumeration (invalidate + rebuild);
 * the store-subscription plumbing that triggers it lives in the UI layer.
 *
 * URLS ARE KEPT RAW. Unlike the gallery (which normalises image urls through
 * fullResImageUrl so a match locates the current image), the browser stores each
 * attachment's ORIGINAL url untouched — the CDN signing params (ex/is/hm) expire,
 * and the thumbnail-url helper that adds resize hints is the UI layer's job. A
 * consumer that opens an entry passes entry.url straight to load(), which is the
 * same url the chip would have used.
 *
 * NO MODULE-TOP WEBPACK. MessageStore / MessageActions are read off @webpack/common
 * only INSIDE the functions below (a module-top read silently kills the plugin).
 */

import { MessageActions, MessageStore } from "@webpack/common";

import { categoryOf, type ViewerCategory } from "./categoryMap";
import { detectType } from "./detectType";
import type { ContentType } from "./types";

/** One openable attachment in a channel. `url` is the original attachment url
 *  (url ?? proxy_url), kept RAW — no resize/signing rewrite (that's the UI's job).
 *  `type` is what the dock would open it as (detectType, never "unknown" here), and
 *  `category` is its viewer category (null only for the never-categorised types,
 *  which the enumeration already excludes — so in practice always set). `size`,
 *  `width` and `height` are carried when Discord supplies them, for the row's
 *  size/dimension display. */
export interface FileEntry {
    messageId: string;
    url: string;
    filename: string;
    content_type: string | null;
    size?: number;
    width?: number;
    height?: number;
    type: ContentType;
    category: ViewerCategory | null;
}

/** A channel's cached file list plus whether the message collection has more to
 *  page in either direction. `loading` is true while a loadOlder() fetch is in
 *  flight (so the UI can dim its spinner row and callers can no-op re-entrancy). */
export interface FileIndexState {
    channelId: string;
    items: FileEntry[];
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    loading: boolean;
}

/** Per-channel cache. Built lazily on the first getChannelFiles() for a channel and
 *  dropped by invalidate() on a channel switch. In-memory only, like channelMemory. */
const channelIndex = new Map<string, FileIndexState>();

/** Last-path-segment filename of a url (fallback when an attachment has no
 *  `filename`). Decoded; query/hash dropped. Mirrors the gallery's fallback. */
function nameFromUrl(url: string): string {
    let path = url;
    try { path = new URL(url, location.href).pathname; } catch { /* keep raw */ }
    let base = path.split("/").pop() || "file";
    try { base = decodeURIComponent(base); } catch { /* keep raw */ }
    return base || "file";
}

/** Walk MessageStore's cached window for `channelId` and build the ordered
 *  (oldest→newest, like the native view) list of every OPENABLE attachment, plus
 *  the collection's hasMore flags. An attachment is openable when detectType() maps
 *  its filename/url to a real ContentType (!== "unknown") — the SAME predicate the
 *  chip interception uses, so the browser lists exactly what a click can open.
 *  Best-effort: a missing/shape-changed store yields an empty list (no throw). */
function buildIndex(channelId: string): Omit<FileIndexState, "loading"> {
    const items: FileEntry[] = [];
    let hasMoreBefore = false;
    let hasMoreAfter = false;
    try {
        const coll = (MessageStore as any).getMessages(channelId);
        if (coll) {
            hasMoreBefore = !!coll.hasMoreBefore;
            hasMoreAfter = !!coll.hasMoreAfter;
            const arr: any[] = typeof coll.toArray === "function" ? coll.toArray() : (Array.isArray(coll) ? coll : []);
            for (const msg of arr) {
                const atts = msg && msg.attachments;
                if (!atts || !atts.length) continue;
                for (const a of atts) {
                    const raw = a && (a.url || a.proxy_url);
                    if (!raw) continue;
                    const url = String(raw);
                    const filename = (a.filename as string) || nameFromUrl(url);
                    const type = detectType({ url, name: filename });
                    if (type === "unknown") continue; // not something the dock can open
                    const entry: FileEntry = {
                        messageId: String(msg.id),
                        url,
                        filename,
                        content_type: typeof a.content_type === "string" ? a.content_type : null,
                        type,
                        category: categoryOf(type)
                    };
                    if (typeof a.size === "number") entry.size = a.size;
                    if (typeof a.width === "number") entry.width = a.width;
                    if (typeof a.height === "number") entry.height = a.height;
                    items.push(entry);
                }
            }
        }
    } catch {
        /* MessageStore unavailable / shape changed — empty index */
    }
    return { channelId, items, hasMoreBefore, hasMoreAfter };
}

/** Rebuild `channelId`'s cached state from the store (preserving the loading flag),
 *  store it and return it. */
function rebuild(channelId: string): FileIndexState {
    const prev = channelIndex.get(channelId);
    const built = buildIndex(channelId);
    const state: FileIndexState = { ...built, loading: prev?.loading ?? false };
    channelIndex.set(channelId, state);
    return state;
}

/**
 * The channel's file list, built from the cached message window. Cached per channel:
 * the first call (or the first after invalidate()) enumerates the store; later calls
 * return the cached state until it's invalidated. Callers that KNOW new messages have
 * arrived and want them reflected should call invalidate(channelId) first (or the UI
 * re-enumerates on a store-change subscription — batch 2). A falsy channelId returns
 * an empty, non-paging state.
 */
export function getChannelFiles(channelId: string | null): FileIndexState {
    if (!channelId) return { channelId: "", items: [], hasMoreBefore: false, hasMoreAfter: false, loading: false };
    const cached = channelIndex.get(channelId);
    if (cached) return cached;
    return rebuild(channelId);
}

/** Whether a loadOlder() would do anything: there's more before AND nothing is
 *  already in flight. (hasMoreBefore is read from the last-built state.) */
export function canLoadOlder(channelId: string | null): boolean {
    if (!channelId) return false;
    const state = getChannelFiles(channelId);
    return state.hasMoreBefore && !state.loading;
}

/**
 * Page one older window into MessageStore, then re-enumerate the channel's files.
 *
 * "Load more past attachments" — exactly what scrolling the native message view up
 * does: fetchMessages({ before: <oldest cached message id> }) widens the client's
 * cached window backwards, then we rebuild the index so the newly-cached older
 * attachments are appended (they sort oldest-first, so they land at the FRONT of the
 * oldest→newest list). Returns the refreshed state. A no-op (returns the current
 * state) when there's nothing more before, a fetch is already in flight, or the list
 * is empty. Best-effort: a fetch failure just clears the loading flag and returns the
 * unchanged list. NO search API — this is the same request volume/timing as native
 * scroll, so there is no added token/rate-limit exposure.
 */
export async function loadOlder(channelId: string | null): Promise<FileIndexState> {
    if (!channelId) return getChannelFiles(channelId);
    const state = getChannelFiles(channelId);
    if (state.loading || !state.hasMoreBefore) return state;
    // Anchor on the OLDEST cached message. Prefer the store's own first id (covers a
    // channel whose cached window has messages with no openable attachment — the
    // oldest FileEntry could be far newer than the true window edge); fall back to the
    // oldest indexed entry, then to the newest, if the store read fails.
    const anchor = oldestMessageId(channelId) ?? (state.items.length ? state.items[0].messageId : null);
    if (!anchor) return state;

    state.loading = true;
    let p: any;
    try {
        p = (MessageActions as any).fetchMessages({ channelId, limit: 50, before: anchor });
    } catch {
        state.loading = false;
        return state;
    }
    try {
        await Promise.resolve(p);
    } catch {
        /* ignore fetch error — fall through to rebuild with the loading flag cleared */
    }
    // Re-read: the fetch widened the store's window. rebuild() preserves nothing but
    // the loading flag (which we clear here), so re-set it false before rebuilding.
    const cur = channelIndex.get(channelId);
    if (cur) cur.loading = false;
    return rebuild(channelId);
}

/** The id of the OLDEST message in the store's cached window for `channelId` (the
 *  true page anchor, independent of whether it carries an attachment), or null if
 *  the store is unavailable/empty. Messages come oldest→newest, so index 0. */
function oldestMessageId(channelId: string): string | null {
    try {
        const coll = (MessageStore as any).getMessages(channelId);
        if (!coll) return null;
        const arr: any[] = typeof coll.toArray === "function" ? coll.toArray() : (Array.isArray(coll) ? coll : []);
        const first = arr[0];
        return first && first.id != null ? String(first.id) : null;
    } catch {
        return null;
    }
}

/** Drop a channel's cached file list (a channel switch, or a caller that wants the
 *  next getChannelFiles() to re-enumerate — e.g. new messages arrived). The next
 *  read rebuilds from the store. */
export function invalidate(channelId: string | null): void {
    if (!channelId) return;
    channelIndex.delete(channelId);
}

/** Drop EVERY channel's cached file list (plugin stop — paired with the other
 *  in-memory teardowns). */
export function clearFileIndex(): void {
    channelIndex.clear();
}
