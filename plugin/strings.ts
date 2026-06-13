/*
 * DockView — user-facing string catalogue.
 * ---------------------------------------------------------------------------
 * Every string a user can READ (header tooltips/aria-labels, the ⋯ menu, the
 * find bar, and the four system-message states: loading / empty / error /
 * unsupported) lives here so the copy stays consistent and is reviewed in one
 * place. This is a plain const map — NOT an i18n framework. A later pass can
 * read Discord's locale and branch ko/en off the same keys, but P1 is one
 * English voice.
 *
 * Tone: Discord-native. Errors lead with information (what went wrong / what to
 * do), kept plain — no jokes at an annoyed user. The idle "dead-end" screens
 * (empty / unsupported) allow ONE light, restrained line in Discord's house
 * voice. Frequently-seen strings stay sober.
 */

export const STRINGS = {
    // --- system messages: error ---------------------------------------------
    // Lead with information. The title says what happened; the sub says what the
    // user can do or why. No wit here.
    error: {
        gone: {
            title: "This file couldn't be loaded",
            sub: "The link may have expired or been removed."
        },
        forbidden: {
            title: "You don't have access to this file",
            sub: "You don't have permission to view it."
        },
        server: {
            title: "The server couldn't send this file",
            sub: "It's us, not you — give it a moment and try again."
        },
        // {code} -> the HTTP status code.
        http: {
            title: "This file couldn't be loaded",
            sub: (code: string) => `The server responded with ${code}.`
        },
        offline: {
            title: "Can't reach the server",
            sub: "Check your connection and try again."
        },
        noSource: {
            title: "Nothing to show",
            sub: "Couldn't find a source to load."
        },
        // {raw} -> the unparsed error string, last-resort fallback.
        generic: {
            title: "This file couldn't be loaded",
            sub: (raw: string) => raw
        }
    },

    // --- system messages: unsupported format --------------------------------
    // An idle dead end — one restrained light line is allowed.
    unsupported: {
        title: "Nothing to preview here",
        // {ext} -> the file extension WITHOUT the dot, or null.
        sub: (ext: string | null) =>
            ext
                ? `We can't preview .${ext} files — download it to open it in another app.`
                : "We can't preview this file — download it to open it elsewhere."
    },

    // --- system messages: empty state ---------------------------------------
    // The other idle screen. One quiet, friendly line.
    empty: {
        text: "Open a file and it'll show up here."
    },

    // --- system messages: loading -------------------------------------------
    loading: {
        title: "Loading…"
    },

    // --- shared action buttons (state cards) --------------------------------
    actions: {
        retry: "Try again",
        openInNewWindow: "Open in browser",
        download: "Download"
    },

    // --- find bar -----------------------------------------------------------
    find: {
        placeholderPdf: "Find in document",
        placeholderCode: "Find in file",
        matchCase: "Match case",
        prevMatch: "Previous match (Shift+Enter)",
        nextMatch: "Next match (Enter)",
        close: "Close find (Esc)"
    },

    // --- zoom group (PDF + image) -------------------------------------------
    zoom: {
        out: "Zoom out (-)",
        in: "Zoom in (+)",
        level: "Zoom level",
        reset: "Reset zoom (0)"
    },

    // --- image-only controls ------------------------------------------------
    image: {
        enterFullscreen: "Fullscreen (F)",
        exitFullscreen: "Exit fullscreen (Esc)"
    },

    // --- PDF header controls -------------------------------------------------
    pdf: {
        prevPage: "Previous page (←)",
        nextPage: "Next page (→)",
        goToPage: "Go to page",
        goToPageHint: "Type a page number, Enter to jump",
        pageIndicator: "Current page / total",
        find: "Find (Ctrl+F)"
    },

    // --- code header controls -----------------------------------------------
    code: {
        detectedLanguage: "Detected language",
        find: "Find (Ctrl+F)",
        enableWrap: "Enable word wrap",
        disableWrap: "Disable word wrap",
        copy: "Copy",
        copied: "Copied",
        copyCode: "Copy code"
    },

    // --- header buttons (popout / more / close) -----------------------------
    header: {
        openInNewWindow: "Open in browser",
        popOut: "Pop out",
        more: "More",
        close: "Close",
        closeHint: "Close (Ctrl+Alt+P)"
    },

    // --- ⋯ more-menu items ---------------------------------------------------
    menu: {
        fitToWidth: "Fit to width",
        openInNewWindow: "Open in browser",
        download: "Download",
        copyImage: "Copy image",
        copyLink: "Copy link",
        openInPanel: "Open in panel"
    }
} as const;
