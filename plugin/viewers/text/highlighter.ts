/*
 * The code highlighter — prefer Discord's OWN bundled highlight.js, fall back.
 *
 * highlight.js is a NORMAL bundled import (eager, esbuild folds it into the
 * renderer IIFE) — that's allowed at module top, unlike CodeMirror, which MUST
 * stay behind loadCM()'s dynamic import. This module is the markdown / ipynb
 * fence highlighter and the small-file plaintext escaper; CodeMirror does its own
 * Lezer-based colouring inside CodeBody. They share the hljs language id we derive
 * per file (content.codeLang) but not the rendering.
 *
 * `highlight` does the whole-string pass (markdown fences). `highlightChunk` is
 * the continuation-aware chunk entry: it threads hljs's parser state (`top`)
 * forward so a multiline construct (block comment, template literal) straddling a
 * chunk boundary keeps the right state. hljs's legacy 4-arg signature
 * `highlight(lang, code, ignoreIllegals, continuation)` carries that state via the
 * returned `result.top`; we degrade to per-chunk independent highlight when the
 * build rejects it.
 *
 * The escapers come from engine/html.ts — never redefine them (a second copy is a
 * latent XSS drift).
 */

import { findByProps } from "@webpack";

// highlight.js (bundled) — the FALLBACK code highlighter. We prefer Discord's
// OWN bundled hljs (resolved at runtime via Webpack) and only fall back here.
import hljs from "highlight.js";

import { escapeHtml } from "../../engine/html";

type ChunkResult = { html: string; top: any };

export type Highlighter = {
    highlight: (code: string, lang: string) => string; // returns HTML
    getLanguage: (lang: string) => boolean;
    // null `continuation` starts fresh; pass the previous chunk's `top` to resume.
    highlightChunk: (code: string, lang: string, continuation: any) => ChunkResult;
};

let _hl: Highlighter | null = null;

/** Wrap a raw hljs-shaped module (Discord's or the bundled one) into our
 *  Highlighter, including the continuation-aware chunk path. `mod` must expose
 *  `highlight` + `getLanguage`; the chunk path uses the legacy 4-arg call so it
 *  can thread parser state, degrading to the object form when that's rejected. */
export function wrapHljs(mod: any): Highlighter {
    const whole = (code: string, lang: string): string => {
        try {
            const r = mod.highlight(code, { language: lang, ignoreIllegals: true });
            if (r && typeof r.value === "string") return r.value;
        } catch { /* fall through to legacy */ }
        try {
            const r = mod.highlight(lang, code, true);
            if (r && typeof r.value === "string") return r.value;
        } catch { /* fall through */ }
        return escapeHtml(code);
    };
    return {
        getLanguage: (lang: string) => { try { return !!mod.getLanguage(lang); } catch { return false; } },
        highlight: whole,
        highlightChunk: (code: string, lang: string, continuation: any): ChunkResult => {
            // Legacy signature carries continuation; only it returns a resumable
            // `top`. If the build rejects it we lose cross-chunk state but still
            // produce correct in-chunk HTML.
            try {
                const r = mod.highlight(lang, code, true, continuation);
                if (r && typeof r.value === "string") return { html: r.value, top: r.top ?? null };
            } catch { /* fall through */ }
            return { html: whole(code, lang), top: null };
        }
    };
}

/** Try to find Discord's bundled hljs via Webpack (highlight + getLanguage). */
export function discordHljs(): Highlighter | null {
    try {
        const mod = (findByProps as any)?.("highlight", "getLanguage") || (findByProps as any)?.("highlightAuto", "getLanguage");
        if (mod && typeof mod.highlight === "function" && typeof mod.getLanguage === "function") {
            return wrapHljs(mod);
        }
    } catch {
        /* ignore */
    }
    return null;
}

/** Bundled highlight.js wrapped to the same Highlighter shape. */
export function bundledHljs(): Highlighter {
    return wrapHljs(hljs);
}

/** Lazily resolve the highlighter (Discord's, else bundled). */
export function getHighlighter(): Highlighter {
    if (_hl) return _hl;
    _hl = discordHljs() || bundledHljs();
    return _hl;
}

/** Highlight `code` for `lang`, returning safe HTML (escaped if no language). */
export function highlightCode(code: string, lang: string): string {
    if (!lang || lang === "plaintext") return escapeHtml(code);
    const hl = getHighlighter();
    if (!hl.getLanguage(lang)) return escapeHtml(code);
    return hl.highlight(code, lang);
}
