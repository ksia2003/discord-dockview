/*
 * The channel image gallery — prev/next image navigation.
 *
 * Discord has NO gallery store; images come from MessageStore. We build an
 * ORDERED list (oldest→newest, exactly like Discord's native lightbox) of every
 * image attachment in the channel currently being viewed, then step prev/next
 * through it. The list is rebuilt from MessageStore.getMessages(channelId) on the
 * first nav request for a channel (and after a load-more fetch), keyed by channel
 * id so a channel switch invalidates it. Each entry's url is normalised through
 * fullResImageUrl (image/url.ts) so it matches the full-res url the panel loaded
 * the image under — embed.ts loads images via the same normalisation. At a list
 * end, if the MessageCollection reports more messages before/after, we
 * fetchMessages() to extend it; the prev/next button DIMS (never vanishes —
 * grammar rule 9) at a true end (no more to fetch) and while a load-more is in
 * flight.
 *
 * This is a CROSS-CUTTING capability, not a viewer: the gallery rides over the
 * image viewer and advances the SAME tab via the engine's loadInPlace primitive
 * (NOT load(), which would spawn/route through the transient — see loadInPlace's
 * own note). Gallery state lives on window.gallery, a named slot on DockWindow.
 *
 * No module-top work: MessageStore / MessageActions are read off @webpack/common
 * at CALL time; getActiveWindow() / getCurrentChannelId() only run inside the
 * functions below.
 */

import { MessageActions, MessageStore } from "@webpack/common";

import { requestRender } from "../../engine/forceRender";
import { loadInPlace } from "../../engine/load";
import { getActiveWindow } from "../../engine/window";
import { getCurrentChannelId } from "../../host/channel";
import type { GalleryEntry } from "../../engine/types";
import { fullResImageUrl, GALLERY_IMG_EXT_RE } from "./url";

/** Last-path-segment filename of a url (gallery fallback when an attachment has
 *  no `filename`). Decoded; query/hash dropped. */
function galleryNameFromUrl(url: string): string {
    let path = url;
    try { path = new URL(url, location.href).pathname; } catch { /* keep raw */ }
    let base = path.split("/").pop() || "image";
    try { base = decodeURIComponent(base); } catch { /* keep raw */ }
    return base || "image";
}

/** Build the ordered image list for `channelId` from MessageStore. Returns the
 *  entries oldest→newest plus whether the collection has more at either end. */
function buildGallery(channelId: string): { items: GalleryEntry[]; hasMoreBefore: boolean; hasMoreAfter: boolean } {
    const items: GalleryEntry[] = [];
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
                    const isImg = (typeof a.content_type === "string" && a.content_type.startsWith("image/"))
                        || GALLERY_IMG_EXT_RE.test(String(raw));
                    if (!isImg) continue;
                    const url = fullResImageUrl(String(raw));
                    const name = (a.filename as string) || galleryNameFromUrl(url);
                    items.push({ messageId: String(msg.id), url, name });
                }
            }
        }
    } catch {
        /* MessageStore unavailable / shape changed — empty gallery (nav dims) */
    }
    return { items, hasMoreBefore, hasMoreAfter };
}

/** Refresh `gallery` for the channel the panel is in (idempotent per call). */
export function refreshGallery(): void {
    const win = getActiveWindow();
    const channelId = getCurrentChannelId();
    if (!channelId) {
        win.gallery.channelId = null;
        win.gallery.items = [];
        win.gallery.hasMoreBefore = win.gallery.hasMoreAfter = false;
        return;
    }
    const built = buildGallery(channelId);
    win.gallery.channelId = channelId;
    win.gallery.items = built.items;
    win.gallery.hasMoreBefore = built.hasMoreBefore;
    win.gallery.hasMoreAfter = built.hasMoreAfter;
}

/** Index of the image CURRENTLY shown in the panel within the gallery list, or
 *  -1 if it isn't found (url mismatch / different channel). Matches on the
 *  normalised url the panel loaded. */
export function galleryCurrentIndex(): number {
    const win = getActiveWindow();
    if (win.content.type !== "image" || !win.content.url) return -1;
    const cur = fullResImageUrl(win.content.url);
    for (let i = 0; i < win.gallery.items.length; i++) {
        if (win.gallery.items[i].url === cur) return i;
    }
    return -1;
}

/** Ensure the gallery is built for the current channel and the current image is
 *  located in it; rebuild if the channel changed or the image isn't found yet
 *  (e.g. first nav after opening an image). Returns the current index. */
export function ensureGallery(): number {
    const win = getActiveWindow();
    const channelId = getCurrentChannelId();
    if (channelId !== win.gallery.channelId || galleryCurrentIndex() < 0) refreshGallery();
    return galleryCurrentIndex();
}

/** Load a gallery neighbour into the ACTIVE window IN PLACE. Gallery prev/next
 *  must advance the SAME tab you're stepping in — NOT open/focus another tab. The
 *  generic load() routes through openTab (dedup-or-append), so on a PINNED image tab
 *  it would open the next image as a separate tab and leave the pinned tab unchanged
 *  (a silent jump to another window). Since the gallery state
 *  is per-window and we only step the window that owns it (the active one), we use
 *  the engine's loadInPlace primitive: it replaces the active window's content in
 *  place, preserving the pinned tab, and only renders (the panel is already open). */
function galleryLoadInPlace(next: { name: string; url: string }): void {
    loadInPlace({ name: next.name, url: next.url, type: "image" });
}

/** Fetch one older/newer page into MessageStore, then rebuild the gallery. `dir`
 *  -1 = older (before the oldest loaded message), +1 = newer (after the newest).
 *  After it resolves we re-read getMessages and step onto the neighbour that is
 *  now in range. Best-effort: a failure just clears the loading flag. */
function galleryLoadMore(dir: -1 | 1): void {
    const win = getActiveWindow();
    const channelId = win.gallery.channelId || getCurrentChannelId();
    if (!channelId || win.gallery.loading) return;
    if (dir < 0 && !win.gallery.hasMoreBefore) return;
    if (dir > 0 && !win.gallery.hasMoreAfter) return;
    const items = win.gallery.items;
    if (!items.length) return;
    const anchor = dir < 0 ? items[0].messageId : items[items.length - 1].messageId;
    win.gallery.loading = true;
    requestRender();
    const arg: any = { channelId, limit: 50 };
    if (dir < 0) arg.before = anchor; else arg.after = anchor;
    let p: any;
    try {
        p = (MessageActions as any).fetchMessages(arg);
    } catch {
        win.gallery.loading = false;
        requestRender();
        return;
    }
    Promise.resolve(p)
        .catch(() => { /* ignore fetch error */ })
        .then(() => {
            win.gallery.loading = false;
            refreshGallery();
            // Step onto the neighbour now that the page is loaded. The current
            // image kept its place in the rebuilt list; move one in `dir`.
            const idx = galleryCurrentIndex();
            const target = idx + dir;
            if (idx >= 0 && target >= 0 && target < win.gallery.items.length) {
                galleryLoadInPlace(win.gallery.items[target]); // replace the SAME (active) tab
            } else {
                requestRender();
            }
        });
}

/** Step to the previous/next image in the channel's ordered gallery. `dir` -1 =
 *  previous (older), +1 = next (newer). If stepping past a loaded end and there
 *  are more messages to fetch, load them first (then land on the neighbour). */
export function galleryStep(dir: -1 | 1): void {
    const win = getActiveWindow();
    const idx = ensureGallery();
    if (idx < 0) return;
    const target = idx + dir;
    if (target >= 0 && target < win.gallery.items.length) {
        galleryLoadInPlace(win.gallery.items[target]); // replace the SAME (active) tab in place
        return;
    }
    // Past the loaded end → try to fetch more in that direction.
    galleryLoadMore(dir);
}

/** Can we step in `dir` (button enabled)? True when a neighbour is already loaded
 *  OR the collection has more to fetch in that direction. While a load-more is in
 *  flight the button is disabled (dimmed) but kept in its slot (rule 9). */
export function galleryCanStep(dir: -1 | 1): boolean {
    const win = getActiveWindow();
    if (win.gallery.loading) return false;
    const idx = galleryCurrentIndex();
    if (idx < 0) return false;
    const target = idx + dir;
    if (target >= 0 && target < win.gallery.items.length) return true;
    return dir < 0 ? win.gallery.hasMoreBefore : win.gallery.hasMoreAfter;
}
