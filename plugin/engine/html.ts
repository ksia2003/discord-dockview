/*
 * Tiny HTML-escaping utilities, shared everywhere a string is dropped into
 * innerHTML / a srcdoc document / an attribute value. Kept in one leaf module so
 * the code/csv/markdown/structured viewers and the nonce machinery all reach the
 * same escaper — a second copy would be a latent XSS drift.
 */

/** HTML-escape for the plaintext path (and as a highlight failure fallback). */
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/** Escape a string for use inside a double-quoted HTML ATTRIBUTE value (adds the
 *  quote escapes escapeHtml omits) — used for CSV cell title= attributes built
 *  via innerHTML. */
export function escapeAttr(s: string): string {
    return escapeHtml(s).replace(/"/g, "&quot;");
}
