/*
 * CSV / TSV parsing — pure functions, no DOM, no React.
 *
 * Two jobs:
 *  - csvDelimiterFor: decide the single-char delimiter at load time. The extension
 *    is authoritative (.tsv/.tab → tab, .csv → comma); when it's ambiguous (a .txt
 *    or a retyped xlsx) we sniff the header line for the most frequent separator.
 *  - parseDelimited: split text into a row/cell matrix per RFC 4180 (quoting, the
 *    "" escape, delimiter/newline inside quotes, both \n and \r\n).
 *
 * The grid (CsvBody) parses content.code lazily on mount with these, so the cache
 * stays text-only — no parsed-matrix payload to keep alive or invalidate.
 *
 * No module-top work: only the extOf import + two function declarations.
 */

import { extOf } from "../../engine/detectType";

/** Decide the delimiter for a file. Extension wins (.tsv/.tab = tab, .csv = comma);
 *  otherwise sniff the header line outside quotes (tab > comma > semicolon), so a
 *  retyped .txt / sheet still parses on its dominant separator. */
export function csvDelimiterFor(name: string | null, url: string | null, text: string): string {
    const ext = extOf(url) || extOf(name);
    if (ext === "tsv" || ext === "tab") return "\t";
    if (ext === "csv") return ",";
    // Ambiguous: sniff the header line (up to the first newline) outside quotes.
    const nl = text.indexOf("\n");
    const head = (nl >= 0 ? text.slice(0, nl) : text).slice(0, 4096);
    let inQ = false, tab = 0, comma = 0, semi = 0;
    for (let i = 0; i < head.length; i++) {
        const c = head[i];
        if (c === '"') inQ = !inQ;
        else if (!inQ) {
            if (c === "\t") tab++;
            else if (c === ",") comma++;
            else if (c === ";") semi++;
        }
    }
    if (tab > comma && tab >= semi) return "\t";
    if (semi > comma && semi > tab) return ";";
    return ",";
}

/** Parse CSV/TSV text into a row/cell matrix per RFC 4180, with the given single-
 *  char delimiter. Honours: quoted fields ("..."), the delimiter and newlines
 *  INSIDE quotes (kept literal, never split), the "" escape for a literal quote,
 *  and both \n and \r\n line endings. Ragged rows are returned as-is (the grid
 *  pads short rows / clips against the header column count at render time, so the
 *  parser never invents or drops cells). A trailing newline does NOT yield a
 *  spurious empty final row. Returns rows of string cells. */
export function parseDelimited(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let started = false; // has the current row produced any char/field yet?
    const n = text.length;
    const d = delimiter;

    const endField = () => { row.push(field); field = ""; started = true; };
    const endRow = () => { endField(); rows.push(row); row = []; started = false; };

    for (let i = 0; i < n; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } // "" -> literal "
                else inQuotes = false; // closing quote
            } else {
                field += c; // delimiter / newline inside quotes stays literal
            }
            continue;
        }
        if (c === '"') { inQuotes = true; started = true; continue; }
        if (c === d) { endField(); continue; }
        if (c === "\n") { endRow(); continue; }
        if (c === "\r") {
            if (text[i + 1] === "\n") i++; // swallow the LF of a CRLF
            endRow();
            continue;
        }
        field += c;
        started = true;
    }
    // Flush a final field/row only if there's pending content (so a trailing
    // newline doesn't add a phantom empty row, but a last line without a newline
    // is still captured).
    if (started || field.length || row.length) endRow();
    return rows;
}
