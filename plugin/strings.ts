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
        // A self-contained HTML artifact that fetched fine but never became ready in
        // the iframe (a hung/broken script, or a render that never signalled load).
        // Distinct from a fetch failure — the file is here, it just wouldn't render.
        artifact: {
            title: "This artifact didn't load",
            sub: "It didn't finish rendering — try again, or open it in your browser."
        },
        // {raw} -> the unparsed error string, last-resort fallback.
        generic: {
            title: "This file couldn't be loaded",
            sub: (raw: string) => raw
        }
    },

    // --- disabled decoder notice (Performance page) -------------------------
    // Shown when a heavy decoder set to "Disabled" on the Performance page is asked to
    // open a matching file. Not a failure — a deliberate choice — so it reads as a plain
    // notice, and the state card still offers Download. {label} -> the format name
    // ("3D model", "EPS / AI", "PSD", "JPEG XL", "DICOM").
    decoderDisabled: {
        title: (label: string) => `${label} preview is turned off`,
        sub: "Turn it back on under DockView settings → Performance, or download the file to open it elsewhere."
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

    // --- web (a page opened as a dock tab) ----------------------------------
    // The web page renders inside an isolated <webview>. These label the minimal chrome
    // (back / reload / open-external + the read-only url readout) and the load-failure card.
    web: {
        back: "Back",
        reload: "Reload",
        openExternal: "Open in browser",
        url: "Current page",
        // The honest card shown when the embedded page fails to load.
        failTitle: "Couldn't load this page",
        // {host} -> the page's host; shown on the failure card + as the tab's placeholder sub.
        sub: (host: string) => host
    },

    // --- dicom (medical image) honest gaps ----------------------------------
    // The dicom viewer decodes UNCOMPRESSED transfer syntaxes (+ RLE) client-side. A
    // COMPRESSED DICOM (JPEG / JPEG 2000 / JPEG-LS) would need a heavy codec we don't
    // ship in the renderer, so it shows this honest message (the state card's download
    // action lets the user open it in a real DICOM app) rather than a garbled image.
    dicom: {
        compressed: "This DICOM uses a compressed format we can't preview yet — download it to open in a DICOM viewer."
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
            jxl: "Loading JPEG XL decoder…",
            dxf: "Loading DXF viewer…",
            dicom: "Loading DICOM viewer…",
            email: "Loading email viewer…",
            // .msg + camera RAW are converted in the MAIN process (the convertAttachment
            // IPC): the label covers the fetch-in-main + decode round-trip, not a lib load.
            msg: "Converting message…",
            raw: "Decoding RAW image…",
            // .eps + non-PDF .ai are converted to PDF by Ghostscript-WASM (the
            // chunk-ghostscript.js out-of-bundle chunk): the label covers the chunk
            // load + the PS→PDF conversion before the pdf surface renders.
            postscript: "Converting PostScript…",
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
        sheetTab: "Sheet",
        // The formula (fx) readout bar above the grid. Before a cell is picked the
        // address slot shows this quiet "fx" marker and the value slot a one-line hint;
        // after a click the address slot shows the cell's A1 address (e.g. "B7") and the
        // value slot its formula or raw value.
        fxLabel: "fx",
        fxHint: "Click a cell to see its value or formula",
        // The collapsible Charts strip above the grid: a sheet's embedded charts drawn
        // from the workbook (SheetJS ignores them). {n} -> the chart count on the sheet.
        chartsHeading: (n: number) => `Charts (${n})`,
        // A fallback card for a chart type we recognise but don't draw (3D, radar, stock,
        // surface, combo…). {type} -> the type name, e.g. "Radar chart".
        chartUnsupported: (type: string) => `${type} — not supported yet`
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
        copied: "Copied",
        // Click a line number to select it (shift-click for a range); this button
        // copies a "name L12" / "name L12-L20" reference to paste into chat. Stays
        // in its slot but disabled until a line is picked (grammar rule 9).
        copyRef: "Copy line reference",
        copyRefEmpty: "Select a line number to copy its reference"
    },

    // --- markdown header controls -------------------------------------------
    // The table-of-contents control is a single STATE-COLOUR toggle (the same
    // grammar the csv/tree raw toggles use): off = outline hidden, highlighted =
    // outline shown. It stays in its slot but DISABLED when the document has no
    // headings (grammar rule 9 — a control never disappears by mode).
    markdown: {
        toc: "Table of contents"
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

    // --- settings sidebar (the DockView section + its rows) -----------------
    // The DockView section is its own top-level header in Discord's user-settings
    // sidebar (same rank as "Vencord Settings"), with a row per page. Rows read
    // like native ones — short single words, not sentences.
    settings: {
        section: "DockView",
        general: "General",
        viewers: "Viewers",
        performance: "Performance",
        privacy: "Privacy",
        profiles: "Profiles",
        updates: "Updates",
        examples: "Examples",
        about: "About"
    },

    // --- General settings page ----------------------------------------------
    // The dock's behaviour preferences: width, sidebar exclusivity, media autoplay,
    // per-channel memory. Each row is a native-style switch (or the width slider) with a
    // one-line note under it. Changes apply live.
    general: {
        // Width slider group.
        widthTitle: "Dock width",
        widthNote: "How wide the dock opens. Drag the dock's edge for the same effect.",
        // {px} -> the current width in pixels.
        widthValue: (px: number) => `${px}px`,
        // Sidebar exclusivity switch.
        exclusivityTitle: "Collapse the member list while the dock is open",
        exclusivityNote:
            "The dock takes the member-list slot like a thread, then restores it on close. " +
            "Turn off to keep the member list open beside the dock.",
        // Media autoplay switch.
        autoplayTitle: "Autoplay media when opened",
        autoplayNote:
            "Start playback when an audio or video file opens. Autoplaying media starts " +
            "muted — unmute it with the player controls."
    },

    // --- Viewers settings page ----------------------------------------------
    // The master switch + per-category switches deciding which attachments open in the
    // dock. A disabled category (or the master off) makes those chips behave like stock
    // Discord (download / lightbox). Changes apply to the next chip click.
    viewers: {
        // Master switch.
        masterTitle: "Open attachments in the dock",
        masterNote:
            "Click an attachment to preview it in the dock. Turn off to let attachments " +
            "download or open in Discord's lightbox instead.",
        // The heading over the category list.
        categoriesTitle: "File types",
        categoriesNote: "Choose which kinds of files open in the dock.",
        // Category labels + the formats each covers (the note under each switch).
        cat: {
            documents: "Documents",
            documentsNote: "PDF, Word, RTF, ODT, HTML, email, Jupyter notebooks",
            spreadsheets: "Spreadsheets",
            spreadsheetsNote: "Excel, ODS, CSV, TSV",
            images: "Images",
            imagesNote: "PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, APNG, ICO",
            exoticImages: "Exotic images",
            exoticImagesNote: "TIFF, HEIC, PSD, camera RAW, DICOM, DXF, JPEG XL, JPEG 2000, EPS, AI",
            codeText: "Code & text",
            codeTextNote: "Source files, logs, plain text, Markdown, JSON/XML trees",
            diagrams: "Diagrams",
            diagramsNote: "Mermaid, Graphviz",
            models3d: "3D models",
            models3dNote: "OBJ, STL, PLY, FBX, DAE, 3DS, glTF, GLB",
            media: "Media",
            mediaNote: "Audio and video",
            presentations: "Presentations",
            presentationsNote: "PowerPoint, ODP"
        }
    },

    // --- Performance settings page ------------------------------------------
    // Heavy-decoder loading modes + the large-image quality switch. Each decoder is a
    // niche, exotic library that ships out-of-bundle; the mode picker trades a little
    // startup work / disk read against instant first opens or turning the format off.
    // Changes apply to the NEXT load — a decoder already loaded this session stays
    // loaded.
    performance: {
        // The heavy-decoder group.
        decodersTitle: "Heavy decoders",
        decodersNote:
            "These formats need a large, optional decoder loaded on first use. Choose how each " +
            "one loads. Changes take effect the next time such a file opens.",
        // The three modes (the decoder Select's options + their meaning).
        modeOnDemand: "On demand",
        modePreload: "Preload",
        modeDisabled: "Disabled",
        // The one-line note under each decoder row: its formats + what the current mode
        // means. {formats} -> the covered formats.
        decoderFormats: (formats: string) => formats,
        // A short gloss of each mode, shown once under the group.
        modesLegend:
            "On demand loads the decoder the first time you open such a file. " +
            "Preload warms it in the background after startup so the first open is instant. " +
            "Disabled turns the format off — a matching file shows a notice instead.",
        // The large-image quality switch.
        losslessTitle: "Always convert large images losslessly (PNG)",
        losslessNote:
            "Exotic images (TIFF, PSD, HEIC, JPEG XL, JPEG 2000) are decoded and re-encoded for the " +
            "dock. Large frames (over ~8 megapixels) default to JPEG to keep memory down. Turn this " +
            "on to keep them lossless PNG instead — sharper, but a bigger picture uses more memory.",
        largeImageGroup: "Image quality"
    },

    // --- Privacy settings page ----------------------------------------------
    // Two groups: remote images in email files, and network privacy (the tracker
    // firewall + proxy that live in main and are driven over IPC).
    privacy: {
        emailGroup: "Email",
        remoteImagesTitle: "Load remote images in email attachments",
        remoteImagesNote:
            "Email files (.eml, .msg) can reference images hosted on a remote server. Those are blocked " +
            "by default, because loading one tells the sender you opened the message (a tracking pixel). " +
            "Turn this on to load remote images in email previews.",

        networkGroup: "Network",
        firewallTitle: "Block trackers and telemetry",
        firewallNote:
            "Cancels requests to known tracking, analytics, and telemetry endpoints (science, error " +
            "reporting, ad/analytics hosts) before they leave your machine. An allowlist keeps normal " +
            "traffic — attachments, media, and Discord's own services — untouched. On by default.",
        proxyTitle: "Use a proxy",
        proxyNote: "Route the app's connection through an HTTP or SOCKS proxy. Takes effect immediately.",
        proxyRulesLabel: "Proxy rules",
        proxyRulesPlaceholder: "socks5://127.0.0.1:9050  or  http=host:port;https=host:port",
        proxyBypassLabel: "Bypass rules",
        proxyBypassPlaceholder: "localhost;*.discord.com"
    },

    // --- Profiles settings page ---------------------------------------------
    // Multi-account: each profile is a fully separate data dir (own login + settings)
    // that opens as its own window/process. Sober settings-page voice; the page header
    // ("Profiles") comes from the sidebar row's panel title, so it isn't repeated.
    profiles: {
        intro:
            "Run more than one account. Each profile is a completely separate login with " +
            "its own settings. Switch replaces this window with another profile — one window, " +
            "and both stay signed in. Open puts a second profile in its own window beside this one.",
        // Current-profile indicator.
        currentLabel: "Current profile",
        // The label for the running default (unnamed) install.
        defaultName: "Default",
        // The small badge on the profile this window is currently running as.
        currentBadge: "Currently running",
        // The list group.
        listTitle: "Profiles",
        none: "No profiles yet. Create one below to run a second account.",
        // Per-profile actions.
        // Switch = replace THIS window with that profile (one window; the primary action).
        switch: "Switch",
        open: "Open",
        delete: "Delete",
        confirmDelete: "Confirm delete",
        cancel: "Cancel",
        // The Default row (shown while running a named profile) — switch back to the
        // default install without creating a second window.
        switchToDefault: "Switch to Default",
        // The new-profile group.
        newTitle: "New profile",
        namePlaceholder: "Profile name",
        createOpen: "Create & open",
        working: "Working…",
        // The honest cost note under the create row.
        note:
            "Switch replaces this window with the chosen profile — one window at a time, and " +
            "every profile stays signed in on this device, so switching back doesn't ask you to " +
            "log in again. Open instead runs a profile in a second window beside this one, which " +
            "uses additional memory. Deleting a profile removes its data on this device.",
        // Status lines (one line under the create row). {name} -> the profile name.
        opened: (name: string) => `Opening ${name} in a new window…`,
        // Shown briefly after Switch, before this window closes. {name} -> target name.
        switching: (name: string) => `Switching to ${name}…`,
        deleted: (name: string) => `Deleted ${name}.`,
        // {raw} -> the underlying error text.
        error: (raw: string) => raw,
        // The native bridge isn't present in this build (e.g. plain web).
        unavailable: "Profiles aren't available in this build."
    },

    // --- about page ---------------------------------------------------------
    // A small page: the running versions, a GitHub link, and a one-line credit.
    // The page header ("About") comes from the sidebar row's panel title, so it's
    // not repeated here.
    about: {
        blurb:
            "A right-docked panel that previews attachment chips inline — PDF, images, " +
            "code, markdown, spreadsheets, 3D models, and more, without leaving Discord.",
        dockviewVersion: "DockView version",
        vesktopVersion: "Vesktop base",
        // The active profile row on the About page (shows "Default" or the name).
        activeProfile: "Active profile",
        github: "GitHub",
        credits: "Built on Vesktop and Vencord. Licensed under GPL-3.0."
    },

    // --- self-update panel (settings section) -------------------------------
    // The DockView update section in Vencord's plugin settings: two user-facing
    // version lines (the running DockView version + the latest available), a
    // one-line status verdict, and the Check / Apply buttons that drive the native
    // updater. Sober, settings-page voice — these report state, not idle dead-ends,
    // so no jokes.
    update: {
        sectionTitle: "DockView updates",
        // The blurb under the title — what this section does.
        intro: "DockView patches itself from GitHub. Check for a new build, then apply it.",
        // Version row labels. Only two rows are shown to the user: the DockView version
        // running now and the latest available. (The on-disk version.txt marker and the
        // raw app-shell version are internal-only — kept out of the UI; onDisk's label is
        // retained here for any non-UI reference but is no longer rendered.)
        current: "Version",
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
        // A newer build is available whose update replaces the app itself (not just the
        // plugin). Shown instead of the plain updateAvailable line when the release needs
        // a newer shell, so the single Apply reads honestly (the app will restart to
        // finish). {version} -> the version shown in the Latest row.
        appUpdateAvailable: (version: string) => `Update available: ${version} (updates the app).`,
        // A patch was written to disk but the running code is still older — a
        // reload picks it up.
        appliedNeedsReload: "Update applied — reload to run it.",
        // After a successful apply that touches main/preload (not just renderer).
        needsRelaunch: "Update applied — restarting to finish.",
        // The placeholder verdict before the first check.
        notChecked: "Not checked yet.",
        // Check found no plugin release / couldn't reach GitHub.
        noRelease: "Couldn't find a published update.",
        // {raw} -> the underlying error text (from a failed apply).
        error: (raw: string) => `Couldn't check: ${raw}`,
        // The native updater bridge isn't present in this build.
        unavailable: "Updates aren't available in this build.",

        // --- typed check-failure copy (one per discoverManifest error code) ---
        // Each check failure reads as its OWN precise line, never a silent "—", and the
        // panel offers a Retry alongside. Lead with what happened + what the user can do.
        fail: {
            // GitHub throttled the check from this network. {time} -> the local reset
            // time ("3:47 PM"), or null when unknown.
            rateLimited: (time: string | null) =>
                time
                    ? `GitHub is rate-limiting update checks from this network — try again after ${time}.`
                    : "GitHub is rate-limiting update checks from this network — try again in a little while.",
            // The request never reached GitHub (offline / DNS / timeout).
            network: "Couldn't reach GitHub — check your connection and try again.",
            // GitHub answered, but a bad HTTP status. {code} -> the status number.
            http: (code: number) => `GitHub returned an unexpected error (HTTP ${code}) — try again.`,
            // The manifest asset was there but wasn't valid — a broken/partial release.
            malformed: "The update information from GitHub was unreadable — try again later.",
            // No published release carries a plugin update.
            noRelease: "Couldn't find a published update."
        },

        // --- automatic background check (Updates page) --------------------------
        // The "check for updates automatically" switch on the Updates page.
        autoCheckTitle: "Check for updates automatically",
        autoCheckNote:
            "Once a day, DockView quietly checks GitHub for a newer build and lets you know " +
            "when one is ready. It never installs anything on its own — you still choose when to apply.",
        // The one-time notice shown when the daily background check finds an update.
        // {version} -> the newer plugin version.
        noticeUpdate: (version: string) => `DockView ${version} is available.`,
        // The notice's action button (opens the Updates page).
        noticeButton: "See update",

        // --- app-shell update (installer-driven) --------------------------------
        // The plugin patches itself over the air; the app SHELL (Vesktop main/preload)
        // updates by re-running the installer. These strings drive that row on the
        // Updates page. Same sober, settings-page voice as the rest of this section.
        shell: {
            // The "Installed via: AppImage" line under the version rows. {method} ->
            // the detected install method's human label ("AppImage", "Windows installer").
            installedVia: (method: string) => `Installed via: ${method}`,
            // The shell version row label.
            shellVersion: "App shell",
            // Verdict when the release needs a newer shell than the one running.
            // {version} -> the required shell version.
            updateAvailable: (version: string) =>
                `A newer app (${version}) is available — it updates the app itself, not just the plugin.`,
            // The button that downloads + runs the installer for this platform.
            update: "Update app",
            // While the installer is downloading / running.
            updating: "Updating app…",
            // Shown while the shell installer downloads (larger than a plugin patch).
            downloading: "Downloading the installer…",
            // After the installer is launched (Windows / deb / rpm) — the app will close.
            launched: "Installer started — the app will restart to finish.",
            // deb/rpm without pkexec, or an install method we can't drive: point the user
            // at the download so they can install it themselves.
            manualTitle: "Update the app manually",
            manual:
                "This build can't install the update for you. Download the new installer and run it — " +
                "your settings and logins are kept.",
            // The manual download button.
            download: "Download installer",
            // A shell apply failed. {raw} -> the underlying error.
            error: (raw: string) => `Couldn't update the app: ${raw}`
        }
    }
} as const;
