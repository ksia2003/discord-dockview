/*
 * A small, self-contained RTF → HTML converter — no dependencies, no Node built-ins.
 *
 * Why hand-rolled: the obvious libs don't survive Vencord's browser esbuild. rtf.js
 * is ~11 MB (renders WMF/EMF via canvas — far too heavy for a chat preview), and
 * @iarna/rtf-to-html pulls rtf-parser → iconv-lite + readable-stream, which need the
 * Node `buffer`/`stream`/`assert`/`util`/`events` built-ins esbuild won't polyfill
 * here (verified: the bundle errors out). So we parse RTF ourselves with a focused
 * tokenizer that covers what shows up in real chat .rtf files: paragraphs, bold /
 * italic / underline / strike, super/subscript, font sizes & colours, alignment,
 * lists (bulleted / numbered), Unicode (\uN) + hex (\'hh) escapes, and the common
 * symbol control words. The output is a body HTML FRAGMENT (no <html>/<body>) that
 * feeds the shared dark sandboxed-iframe doc shell, so default black text inherits
 * the shell's light colour and only EXPLICIT rtf colours emit an inline `color:`.
 *
 * Fidelity we deliberately punt on (a chat preview, not a word processor): embedded
 * images (\pict — usually WMF/EMF/hex blobs that need a raster decoder), tables
 * (\trowd) which degrade to their cell text as paragraphs, and exotic field/object
 * groups. These are skipped cleanly rather than rendered broken.
 *
 * NO module-top executable work: only function declarations. Pure string/number ops,
 * so it bundles to a few KB with zero polyfills.
 */

import { escapeHtml } from "../../engine/html";

/** A character-formatting state. Cloned on group push so a nested group's changes
 *  don't leak out, mirroring RTF's group-scoped property model. */
interface CharState {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strike: boolean;
    /** 0 = normal, 1 = superscript, -1 = subscript. */
    script: number;
    /** half-points (rtf \fsN), 0 = use document default. */
    fontSize: number;
    /** index into the colour table, or -1 for default (no explicit colour). */
    colorIdx: number;
    /** a control destination whose text we discard (fonttbl, stylesheet, info, …). */
    skip: boolean;
}

/** Paragraph-level properties, reset by \pard. */
interface ParaState {
    align: "left" | "right" | "center" | "justify";
    /** \li left-indent in twips (1/20 pt). */
    indent: number;
    /** a list item: "ul" (bullet) | "ol" (number) | null (plain paragraph). */
    list: "ul" | "ol" | null;
}

function freshChar(): CharState {
    return { bold: false, italic: false, underline: false, strike: false, script: 0, fontSize: 0, colorIdx: -1, skip: false };
}
function freshPara(): ParaState {
    return { align: "left", indent: 0, list: null };
}

/** RTF code-page → label for the few we bother to map; we decode \'hh bytes as
 *  Latin-1/Windows-1252 by default which covers the vast majority of chat .rtf. */
const CP1252_HIGH: Record<number, string> = {
    0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…",
    0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8A: "Š",
    0x8B: "‹", 0x8C: "Œ", 0x8E: "Ž", 0x91: "‘", 0x92: "’",
    0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
    0x98: "˜", 0x99: "™", 0x9A: "š", 0x9B: "›", 0x9C: "œ",
    0x9E: "ž", 0x9F: "Ÿ"
};

/** Decode a single \'hh byte to a character (Windows-1252 high range, else Latin-1). */
function decodeByte(b: number): string {
    if (b < 0x80) return String.fromCharCode(b);
    return CP1252_HIGH[b] || String.fromCharCode(b);
}

/** Control words that emit a literal character rather than toggling a property. */
const SYMBOLS: Record<string, string> = {
    par: "\n", line: "\n", tab: "\t", emdash: "—", endash: "–",
    bullet: "•", lquote: "‘", rquote: "’", ldblquote: "“",
    rdblquote: "”", emspace: " ", enspace: " ", "~": " ",
    "-": "­", _: "‑"
};

/** Destinations whose entire group content is metadata, not body text — skipped.
 *  `pntext`/`listtext` carry the bullet/number GLYPH a non-list-aware reader would
 *  print inline; we render real <ul>/<ol> markers, so we drop those glyphs too. */
const SKIP_DESTS = new Set([
    "fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer",
    "footnote", "annotation", "field", "object", "themedata", "colorschememapping",
    "latentstyles", "datastore", "generator", "mmath", "pgdsctbl", "listtable",
    "listoverridetable", "rsidtbl", "xmlnstbl", "wgrffmtfilter", "filetbl",
    "revtbl", "protusertbl", "pntext", "listtext"
]);

/** A run of text with the formatting state it was emitted under. */
interface Run { text: string; cs: CharState; }
/** A built paragraph: its para props plus the runs (already styled) inside it. */
interface Para { ps: ParaState; runs: Run[]; }

/**
 * Tokenize + interpret the RTF into a list of paragraphs of styled runs, plus the
 * parsed colour table. A single linear pass with an explicit group stack — no
 * recursion, so a deeply nested doc can't blow the call stack.
 */
function parseRtf(rtf: string): { paras: Para[]; colors: string[]; defaultFontSize: number } {
    const colors: string[] = []; // index → "r,g,b" (index 0 = "auto"/default)
    const paras: Para[] = [];
    let cur: Para = { ps: freshPara(), runs: [] };
    let buf = ""; // text accumulating under the current char state

    const charStack: CharState[] = [];
    let cs = freshChar();
    let ps = cur.ps;

    // colour-table assembly: \red \green \blue accumulate, ";" commits an entry.
    let inColorTbl = false;
    let cr = 0, cg = 0, cb = 0;

    // pending list flag from \pntext / \listtext groups and \ls overrides.
    let nextListType: "ul" | "ol" | null = null;

    // the document's base font size (half-points): the FIRST \fs seen. Runs at this
    // size emit no inline font-size, so they inherit the dark shell's body size and
    // only genuinely larger/smaller runs get an explicit pt size.
    let defaultFontSize = 0;

    const i = { p: 0 };
    const n = rtf.length;

    /** Flush the text buffer as a run under the CURRENT char state into the current
     *  paragraph. Splitting on the buffer keeps each run's styling intact. */
    function flush(): void {
        if (!buf) return;
        if (!cs.skip) cur.runs.push({ text: buf, cs: { ...cs } });
        buf = "";
    }

    /** End the current paragraph and start a fresh one, carrying paragraph props
     *  forward (RTF keeps \pard props until the next \pard). */
    function endPara(): void {
        flush();
        paras.push(cur);
        cur = { ps: { ...ps }, runs: [] };
        ps = cur.ps;
    }

    while (i.p < n) {
        const c = rtf[i.p];

        if (c === "{") {
            flush();
            charStack.push({ ...cs });
            i.p++;
            continue;
        }
        if (c === "}") {
            flush();
            const popped = charStack.pop();
            if (popped) cs = popped;
            // leaving a colour table group commits it
            if (inColorTbl) inColorTbl = false;
            i.p++;
            continue;
        }
        if (c === ";" && inColorTbl) {
            // a ";" delimiter commits the accumulated \red/\green/\blue as one
            // colour-table entry (index 0 is the empty "auto" default).
            colors.push(`${cr}, ${cg}, ${cb}`);
            cr = cg = cb = 0;
            i.p++;
            continue;
        }
        if (c === "\\") {
            // an escaped literal { } or \  OR a control word / symbol.
            const next = rtf[i.p + 1];
            if (next === "{" || next === "}" || next === "\\") {
                if (!cs.skip) buf += next;
                i.p += 2;
                continue;
            }
            if (next === "'") {
                // \'hh hex byte
                const hex = rtf.substr(i.p + 2, 2);
                const code = parseInt(hex, 16);
                if (!isNaN(code) && !cs.skip) buf += decodeByte(code);
                i.p += 4;
                continue;
            }
            // control word: \word possibly followed by a (optionally negative) number.
            const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i.p));
            if (!m) {
                // a lone control symbol like \* or \: skip the two chars (and for \*
                // mark the next group as a discardable destination).
                if (next === "*") {
                    // \* introduces an optional destination — its group is skippable.
                    cs.skip = true;
                }
                i.p += 2;
                continue;
            }
            const word = m[1];
            const param = m[2] !== undefined ? parseInt(m[2], 10) : null;
            i.p += m[0].length;

            // A control word is a state boundary: flush the text accumulated under
            // the OLD char state as its own run before the word can change the state,
            // so each run keeps the formatting it was actually typed under.
            flush();
            applyControl(word, param);
            continue;
        }
        if (c === "\n" || c === "\r") {
            // raw line breaks in the RTF source are not content.
            i.p++;
            continue;
        }
        // a literal text character.
        if (!cs.skip) buf += c;
        i.p++;
    }
    flush();
    if (cur.runs.length) paras.push(cur);

    return { paras, colors, defaultFontSize };

    // ── control-word interpreter (closure over the parse state) ──────────────
    function applyControl(word: string, param: number | null): void {
        // the colour table is a destination too, but we must NOT skip its text —
        // we read \red/\green/\blue and the ";" delimiters out of it. Handle it
        // before the generic skip set.
        if (word === "colortbl") { inColorTbl = true; return; }

        // other destinations we discard wholesale (their group text is metadata).
        if (SKIP_DESTS.has(word)) {
            cs.skip = true;
            return;
        }

        // colour-table entries: \red \green \blue then a ";" delimiter commits.
        if (inColorTbl) {
            if (word === "red") cr = param || 0;
            else if (word === "green") cg = param || 0;
            else if (word === "blue") cb = param || 0;
            return;
        }

        switch (word) {
            // paragraph reset / break
            case "pard":
                ps.align = "left"; ps.indent = 0; ps.list = null;
                return;
            case "par":
                endPara();
                return;
            case "line":
                flush();
                cur.runs.push({ text: "\n", cs: { ...cs } });
                return;

            // alignment
            case "ql": ps.align = "left"; return;
            case "qr": ps.align = "right"; return;
            case "qc": ps.align = "center"; return;
            case "qj": ps.align = "justify"; return;

            // indent (twips)
            case "li": ps.indent = param || 0; return;

            // list markers: \pntext / \listtext groups carry the bullet/number; we
            // detect the destination via \pn (bullet vs decimal) and \ls override.
            case "pnlvlblt": nextListType = "ul"; ps.list = "ul"; return;
            case "pnlvlbody": nextListType = "ol"; ps.list = "ol"; return;
            case "pndec": ps.list = "ol"; return;
            case "ls": if (ps.list == null) ps.list = nextListType || "ul"; return;

            // character formatting toggles. A control word with param 0 turns OFF.
            case "b": cs.bold = param !== 0; return;
            case "i": cs.italic = param !== 0; return;
            case "ul": cs.underline = param !== 0; return; // (only reached when not a colortbl)
            case "ulnone": cs.underline = false; return;
            case "strike": cs.strike = param !== 0; return;
            case "super": cs.script = 1; return;
            case "sub": cs.script = -1; return;
            case "nosupersub": cs.script = 0; return;
            case "fs":
                cs.fontSize = param || 0;
                if (defaultFontSize === 0 && cs.fontSize > 0) defaultFontSize = cs.fontSize;
                return;
            case "cf": cs.colorIdx = param == null ? -1 : param; return;
            case "plain":
                cs.bold = cs.italic = cs.underline = cs.strike = false;
                cs.script = 0; cs.fontSize = 0; cs.colorIdx = -1;
                return;

            // unicode escape: \uN with a following replacement char we must SKIP.
            case "u": {
                if (param != null && !cs.skip) {
                    const code = param < 0 ? param + 65536 : param;
                    buf += String.fromCharCode(code);
                }
                // \uc default is 1 replacement byte to skip after the unicode char.
                skipUnicodeFallback();
                return;
            }
            case "uc":
                ucSkip = param == null ? 1 : param;
                return;

            default:
                // a symbol control word that emits a literal char (\tab, \emdash…)?
                if (Object.prototype.hasOwnProperty.call(SYMBOLS, word)) {
                    if (cs.skip) return;
                    if (word === "par") { endPara(); return; }
                    buf += SYMBOLS[word];
                }
                // everything else (font selectors \fN, \deffN, \viewkind, dimensions…)
                // is ignored — it doesn't affect rendered body text.
                return;
        }
    }

    // \uc N: how many raw bytes follow a \uN that must be discarded (the ANSI
    // fallback for non-unicode readers). Default 1.
    function skipUnicodeFallback(): void {
        let skipped = 0;
        while (skipped < ucSkip && i.p < n) {
            const ch = rtf[i.p];
            if (ch === "\\") {
                // a \'hh fallback counts as one byte
                if (rtf[i.p + 1] === "'") { i.p += 4; skipped++; continue; }
                break; // a control word fallback: stop (rare)
            }
            if (ch === "{" || ch === "}") break;
            i.p++; skipped++;
        }
    }
}

// per-parse \uc fallback width (module-level mutable, reset at the top of toHtml).
let ucSkip = 1;

/** Open/close inline tags for a run's char state, returning [openTags, closeTags].
 *  A run at the document's base font size emits NO inline size, so it inherits the
 *  dark shell's body size; only genuinely re-sized runs get an explicit pt value. */
function runTags(cs: CharState, colors: string[], defaultFontSize: number): { open: string; close: string } {
    let open = "";
    let close = "";
    const style: string[] = [];
    if (cs.colorIdx > 0 && colors[cs.colorIdx]) style.push(`color: rgb(${colors[cs.colorIdx]})`);
    if (cs.fontSize > 0 && cs.fontSize !== defaultFontSize) style.push(`font-size: ${(cs.fontSize / 2).toFixed(1)}pt`);
    if (style.length) { open += `<span style="${style.join("; ")}">`; close = "</span>" + close; }
    if (cs.bold) { open += "<strong>"; close = "</strong>" + close; }
    if (cs.italic) { open += "<em>"; close = "</em>" + close; }
    if (cs.underline) { open += "<u>"; close = "</u>" + close; }
    if (cs.strike) { open += "<s>"; close = "</s>" + close; }
    if (cs.script === 1) { open += "<sup>"; close = "</sup>" + close; }
    else if (cs.script === -1) { open += "<sub>"; close = "</sub>" + close; }
    return { open, close };
}

/** Render one paragraph's runs to inner HTML (escaped text, \n → <br>). */
function renderRuns(runs: Run[], colors: string[], defaultFontSize: number): string {
    let html = "";
    for (const r of runs) {
        const { open, close } = runTags(r.cs, colors, defaultFontSize);
        const text = escapeHtml(r.text).replace(/\n/g, "<br>");
        if (!text && !close) continue;
        html += open + text + close;
    }
    return html;
}

/**
 * Convert RTF source text to a body HTML FRAGMENT for the dark doc-iframe shell.
 * Wraps the document in a `.rtf-doc` block; list paragraphs are coalesced into
 * <ul>/<ol> runs, plain ones become <p>. Empty paragraphs collapse to spacing.
 */
export function rtfToHtml(rtf: string): string {
    ucSkip = 1;
    const { paras, colors, defaultFontSize } = parseRtf(rtf);

    const blocks: string[] = [];
    let listOpen: "ul" | "ol" | null = null;
    let listItems: string[] = [];

    const closeList = () => {
        if (listOpen && listItems.length) {
            blocks.push(`<${listOpen}>` + listItems.map(li => `<li>${li}</li>`).join("") + `</${listOpen}>`);
        }
        listOpen = null;
        listItems = [];
    };

    for (const p of paras) {
        const inner = renderRuns(p.runs, colors, defaultFontSize);
        if (p.ps.list) {
            if (listOpen && listOpen !== p.ps.list) closeList();
            listOpen = p.ps.list;
            listItems.push(inner || "&nbsp;");
            continue;
        }
        closeList();
        const style: string[] = [];
        if (p.ps.align !== "left") style.push(`text-align: ${p.ps.align}`);
        if (p.ps.indent > 0) style.push(`margin-left: ${(p.ps.indent / 20).toFixed(0)}pt`);
        const attr = style.length ? ` style="${style.join("; ")}"` : "";
        // an empty paragraph still produces vertical spacing.
        blocks.push(`<p${attr}>${inner || "<br>"}</p>`);
    }
    closeList();

    return `<div class="rtf-doc">${blocks.join("\n")}</div>`;
}
