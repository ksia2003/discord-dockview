/*
 * Pure fetch / url / clipboard utilities shared by the loaders and the toolbars.
 *
 * dvFetch is the fetch() wrapper every viewer loader uses (a retry forces a fresh
 * network round-trip without mutating the signed url); looksLikeText is the
 * binary sniff the unknown viewer uses; absUrl / downloadUrl / copyText back the
 * header download/copy buttons. No engine imports, no ambient state.
 */

/** fetch() wrapper for the loaders. `noCache` (a retry from the error card)
 *  forces a fresh network round-trip via Cache-Control: reload, bypassing the
 *  HTTP cache without mutating the url (so signed CDN params stay intact). */
export function dvFetch(url: string, noCache?: boolean): Promise<Response> {
    return noCache ? fetch(url, { cache: "reload" }) : fetch(url);
}

/** Resolve a url to its absolute form against the host page (for download/copy). */
export function absUrl(href: string): string {
    try {
        return new URL(href, location.href).href;
    } catch {
        return href;
    }
}

/** Heuristic text-vs-binary sniff over the head of a fetched buffer: a NUL byte
 *  or too many odd control bytes => binary. Used by the unknown viewer to decide
 *  between the plaintext code path and the unsupported-format fallback. */
export function looksLikeText(buf: ArrayBuffer): boolean {
    const bytes = new Uint8Array(buf);
    const n = Math.min(bytes.length, 4096);
    if (n === 0) return true; // empty file: harmless to show as (empty) text
    // BOMs => definitely text.
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return true; // UTF-8
    if ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF)) return true; // UTF-16
    let control = 0;
    for (let i = 0; i < n; i++) {
        const b = bytes[i];
        if (b === 0) return false; // NUL: the definitive binary marker
        // C0 controls except the common text whitespace (TAB 9, LF 10, CR 13,
        // FF 12) and ESC 27 (ANSI logs). Everything >=0x20 is printable/UTF-8.
        if (b < 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27) control++;
    }
    return control / n < 0.1; // <10% odd control bytes => treat as text
}

/** Trigger a browser download of `url` (best-effort filename = `name`). */
export function downloadUrl(url: string | null | undefined, name?: string | null): void {
    if (!url) return;
    const a = document.createElement("a");
    a.href = absUrl(url);
    a.download = name || "";
    a.rel = "noopener";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    a.remove();
}

/** Copy text (a url) to the clipboard, with a non-secure-context fallback. */
export function copyText(text: string | null | undefined): void {
    if (!text) return;
    try {
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(() => fallbackCopy(text, () => { }));
            return;
        }
    } catch {
        /* fall through */
    }
    fallbackCopy(text, () => { });
}

/** Clipboard fallback for non-secure contexts (no navigator.clipboard): a hidden
 *  textarea + execCommand("copy"). Best-effort; failure is a silent no-op. */
export function fallbackCopy(text: string, done: () => void): void {
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        done();
    } catch {
        /* ignore */
    }
}
