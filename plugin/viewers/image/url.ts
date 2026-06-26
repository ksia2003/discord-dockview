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
