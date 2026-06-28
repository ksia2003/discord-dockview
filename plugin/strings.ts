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

    // --- audio / video fallback (an unplayable container) -------------------
    media: {
        title: "Can't play this here",
        // {name} -> the file name.
        sub: (name: string) => `${name} — download it to play in another app.`
    },

    // --- system messages: loading -------------------------------------------
    loading: {
        title: "Loading…",
        // Labels shown while a viewer spins up a heavy library for the first time
        // this session (engine/lazyLib withLibLoading). Each heavy viewer picks one.
        lib: {
            heic: "Loading HEIC decoder…",
            psd: "Loading PSD decoder…",
            tiff: "Loading TIFF decoder…",
            tga: "Loading TGA decoder…",
            ico: "Loading icon decoder…",
            jp2: "Loading JPEG 2000 decoder…",
            email: "Loading email viewer…",
            pdf: "Loading PDF viewer…",
            mermaid: "Loading diagram engine…",
            graphviz: "Loading Graphviz engine…",
            docx: "Loading document viewer…",
            xlsx: "Loading spreadsheet viewer…",
            code: "Loading code viewer…",
            math: "Loading math typesetter…",
            threed: "Loading 3D viewer…",
            pptx: "Loading presentation viewer…"
        }
    },

    // --- shared action buttons (state cards) --------------------------------
    actions: {
        retry: "Try again",
        openInNewWindow: "Open in browser",
        download: "Download"
    },

    // --- find box -----------------------------------------------------------
    // A floating, browser-style Ctrl+F box anchored top-right over the content
    // (grammar rule 7). The input placeholder is a plain "Find" (rule 6 style —
    // a quiet hint, not a sentence); the same word drives every find-capable body
    // (PDF + every CodeMirror surface), so there's one placeholder, not per-type.
    find: {
        placeholder: "Find",
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
        exitFullscreen: "Exit fullscreen (Esc)",
        // prev/next step through the channel's images in order (Discord lightbox)
        prevImage: "Previous image (←)",
        nextImage: "Next image (→)",
        // Rotate the image 90° clockwise per click (cycles 0→90→180→270→0).
        rotate: "Rotate",
        // Tooltip on the natural-dimensions / size / format readout span.
        metadata: "Image details"
    },

    // --- PDF header controls -------------------------------------------------
    // The drag-mode control is a single STATE-COLOUR toggle (Discord member-list
    // grammar): one hand icon that highlights when PAN is active. Off (dim) = drag
    // selects text (the default); on (highlighted) = drag pans the page on both
    // axes so a zoomed PDF can be moved sideways. Tooltip names the action the
    // click performs, so it flips with the state.
    pdf: {
        prevPage: "Previous page (←)",
        nextPage: "Next page (→)",
        goToPage: "Go to page",
        goToPageHint: "Type a page number, Enter to jump",
        pageIndicator: "Current page / total",
        // shown while in text-select mode → clicking switches to pan
        dragPan: "Pan the page",
        // shown while in pan mode → clicking switches back to selecting text
        dragSelect: "Select text",
        find: "Find (Ctrl+F)",
        // Rotate the pages 90° clockwise per click (cycles 0→90→180→270→0).
        rotate: "Rotate"
    },

    // --- raster (multi-page TIFF) header controls ---------------------------
    // A multi-page TIFF keeps its own surface (the image viewer + a page selector);
    // the page nav mirrors the PDF page nav — prev/next chevrons + a jump input with
    // a " / N" total. Single-page TIFF / PSD / HEIC retype to a plain image and show
    // none of this. Copy speaks in "pages" (the TIFF's image directories).
    raster: {
        prevPage: "Previous page (←)",
        nextPage: "Next page (→)",
        goToPage: "Go to page",
        goToPageHint: "Type a page number, Enter to jump",
        pageIndicator: "Current page / total"
    },

    // --- pptx (presentation) header controls --------------------------------
    // Slide navigation mirrors the PDF page nav: prev/next chevrons + a jump input
    // with a " / N" total. Copy speaks in "slides", not "pages".
    pptx: {
        prevSlide: "Previous slide (←)",
        nextSlide: "Next slide (→)",
        goToSlide: "Go to slide",
        goToSlideHint: "Type a slide number, Enter to jump",
        slideIndicator: "Current slide / total"
    },

    // --- csv/tsv header controls --------------------------------------------
    // The Raw control is a single STATE-COLOUR toggle (Discord member-list style):
    // off = grid, on (highlighted) = raw text. Icon-only — the colour state, not a
    // label, communicates whether raw is active; `rawHint` is its tooltip. Copy =
    // a CSV-appropriate tooltip (the data table, not a code block).
    csv: {
        rawHint: "Show raw text",
        copyHint: "Copy table data"
    },

    // --- xlsx/ods (workbook) header controls --------------------------------
    // The sheet switcher is the Excel-style bottom tab strip (in the body, not the
    // header); the header keeps just a copy action for the active sheet's data.
    xlsx: {
        copyHint: "Copy sheet data",
        sheetTab: "Sheet"
    },

    // --- structured (JSON/XML) tree header controls -------------------------
    // The Raw control is a single STATE-COLOUR toggle (Discord member-list style):
    // off = tree, on (highlighted) = raw text. Icon-only — `rawHint` is its tooltip.
    tree: {
        rawHint: "Show raw text",
        copyHint: "Copy"
    },

    // --- code header controls -----------------------------------------------
    // Word wrap defaults on (code shouldn't h-scroll), with a state-colour toggle
    // to drop to a single-line view for wide tabular text.
    code: {
        detectedLanguage: "Detected language",
        find: "Find (Ctrl+F)",
        wrap: "Word wrap",
        copy: "Copy",
        copied: "Copied"
    },

    // --- edit toggle (code / markdown / artifact) ---------------------------
    // A single STATE-COLOUR toggle (Discord member-list grammar): one pencil icon
    // button that highlights when EDIT is active. A file opens in its view mode
    // (code = read, markdown = rendered, artifact = rendered); the toggle enters a
    // TEMPORARY in-memory edit over the source (the original file is untouched).
    // Tooltip names the action the click performs, so it flips with the state.
    edit: {
        // code: read <-> edit
        enterEditCode: "Edit",
        exitEditCode: "Done editing",
        // markdown: rendered <-> edit source
        enterEditMarkdown: "Edit source",
        exitEditMarkdown: "Done editing",
        // .artifact: rendered <-> edit html source
        enterEditArtifact: "Edit HTML",
        exitEditArtifact: "Done editing"
    },

    // --- header buttons (popout / more / close) -----------------------------
    // `close` / `closeHint` are the per-TAB ✕ (one file); `closeDock` is the
    // far-right DOCK X that closes the whole dock (the F9 toggle).
    header: {
        openInNewWindow: "Open in browser",
        popOut: "Pop out",
        more: "More",
        close: "Close",
        closeHint: "Close",
        closeDock: "Close dock",
        closeDockHint: "Close dock (F9)"
    },

    // --- ⋯ more-menu items ---------------------------------------------------
    menu: {
        fitToWidth: "Fit to width",
        openInNewWindow: "Open in browser",
        download: "Download",
        copyImage: "Copy image",
        copyLink: "Copy link",
        openInPanel: "Open in panel",
        // Attach the file currently shown in the panel to the message composer
        // (a pending upload chip on the active channel). When the file has edits,
        // the EDITED buffer is attached, not the original.
        attach: "Attach to message",
        // `+` composer-menu item: open an empty editable dock surface (a new
        // markdown file) and write it from scratch.
        newFile: "New file",
        // Pin the active window so it becomes a persistent TAB that survives channel
        // switches (the multi-window vision: the dock holds several windows you can
        // switch between, like a browser). The item flips to Unpin once pinned.
        pin: "Pin as a tab",
        unpin: "Unpin tab"
    },

    // --- tabs (pin-driven multi-window) -------------------------------------
    // The tabs that live in the header top row (the icon/name slot), ALWAYS shown
    // (one window or many). Each tab carries a file-type icon + name + a ⋯ + close ✕.
    tabs: {
        // {name} -> the file name shown in the tab.
        select: (name: string) => `Switch to ${name}`,
        close: "Close tab",
        // the label for an empty window's tab (the open-but-empty dock).
        untitled: "DockView"
    },

    // --- attach (after edit) filename input ---------------------------------
    // Staging an edited file as a new upload offers a native filename field (the
    // Discord "new thread name" pattern, grammar rule 6): the file's own name is
    // the PLACEHOLDER, so leaving it blank reuses that name; typing renames the
    // staged file. `defaultNewName` is the placeholder for a brand-new file that
    // never had an original name.
    attach: {
        defaultNewName: "message.md",
        confirm: "Attach",
        cancel: "Cancel",
        hint: "Attach to message"
    },

    // --- self-update panel (settings section) -------------------------------
    // The DockView update section in Vencord's plugin settings: three version
    // lines (running / on-disk / latest), a one-line status verdict, and the
    // Check / Apply buttons that drive the native updater. Sober, settings-page
    // voice — these report state, not idle dead-ends, so no jokes.
    update: {
        sectionTitle: "DockView updates",
        // The blurb under the title — what this section does.
        intro: "DockView patches itself from GitHub. Check for a new build, then apply it.",
        // Version row labels.
        current: "Running",
        onDisk: "On disk",
        latest: "Latest",
        // Buttons.
        check: "Check for updates",
        checking: "Checking…",
        apply: "Apply update",
        applying: "Applying…",
        // Status verdicts (one line under the version rows).
        upToDate: "You're on the latest build.",
        // {version} -> the latest plugin version available.
        updateAvailable: (version: string) => `Update available: ${version}.`,
        // A patch was written to disk but the running code is still older — a
        // reload picks it up.
        appliedNeedsReload: "Update applied — reload to run it.",
        // After a successful apply that touches main/preload (not just renderer).
        needsRelaunch: "Update applied — restarting to finish.",
        // The placeholder verdict before the first check.
        notChecked: "Not checked yet.",
        // Check found no plugin release / couldn't reach GitHub.
        noRelease: "Couldn't find a published update.",
        // {raw} -> the underlying error text.
        error: (raw: string) => `Couldn't check: ${raw}`,
        // The native updater bridge isn't present in this build.
        unavailable: "Updates aren't available in this build."
    }
} as const;
