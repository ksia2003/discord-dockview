/*
 * The SINGLE SOURCE of the full-resolution image URL transform.
 *
 * Discord serves image attachments with thumbnail resize hints in the query
 * (width/height/format/quality/…). Both surfaces that open an image must strip
 * those identically so the picture loads at native resolution AND so the gallery
 * can match the url the panel was loaded with:
 *   - embed.ts (a chip / inline-image click) loads the image under this url.
 *   - gallery.ts indexes the channel's images by this same normalised url, so a
 *     match locates the current image in the list.
 * Keeping ONE copy here means the chat-side interception and the gallery can never
 * drift (design §5). embed.ts imports fullResImageUrl from here.
 *
 * Pure string/URL logic — no React, no webpack, no module-top work.
 */

// An attachment counts as an image when its url path carries an image extension
// (the gallery also accepts a content_type of image/*). Mirrors IMG_EXT in
// engine/detectType, expressed as a path-end regex for the raw attachment urls.
export const GALLERY_IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|apng|avif)(\?|#|$)/i;

/** Strip Discord's thumbnail resize params (width/height/format/quality/…) while
 *  KEEPING the signed-CDN params (ex/is/hm) — dropping those 403s the asset. The
 *  result is the original-resolution url. Used by embed.ts on a chip/inline click
 *  AND by gallery.ts to index the channel images, so both agree on one url. */
export function fullResImageUrl(raw: string): string {
    try {
        const u = new URL(raw, location.href);
        // The width/height/format/quality params are the *thumbnail* resize hints;
        // dropping them gives the original-resolution asset. The ex/is/hm signing
        // params MUST stay or the CDN 403s.
        ["width", "height", "format", "quality", "size", "passthrough", "animated"]
            .forEach(p => u.searchParams.delete(p));
        return u.toString();
    } catch {
        return raw;
    }
}

/** The INVERSE of fullResImageUrl: build a downscaled THUMBNAIL url by re-attaching
 *  Discord's resize hints (width/height/format=webp) so the CDN serves a small image
 *  instead of the full asset — for the file browser's grid cards. We first clear any
 *  resize params already on the url (so we don't stack conflicting hints), then set
 *  ours. The ex/is/hm signing params are LEFT UNTOUCHED — they MUST stay or the CDN
 *  403s (same rule as fullResImageUrl). Because those params expire, a thumb url is
 *  built on demand from the entry's raw url and never stored long-term. `w`/`h` are
 *  the requested CSS pixels (Discord clamps to its own sizes); we round up to a
 *  device-pixel-ish 2x so the small card stays crisp on hidpi. Only meaningful for
 *  media.discordapp.net / cdn.discordapp.com hosts; for anything else it returns the
 *  raw url unchanged (a non-CDN image just loads at full size). */
export function thumbUrl(raw: string, w: number, h: number): string {
    try {
        const u = new URL(raw, location.href);
        const host = u.hostname;
        // The resize proxy only understands these on Discord's own CDN/proxy hosts.
        if (!/(^|\.)discordapp\.(net|com)$/.test(host)) return raw;
        // Drop any existing resize hints so ours are the only ones (keep ex/is/hm).
        ["width", "height", "format", "quality", "size", "passthrough", "animated"]
            .forEach(p => u.searchParams.delete(p));
        const rw = Math.max(1, Math.round(w * 2));
        const rh = Math.max(1, Math.round(h * 2));
        u.searchParams.set("width", String(rw));
        u.searchParams.set("height", String(rh));
        u.searchParams.set("format", "webp");
        return u.toString();
    } catch {
        return raw;
    }
}
