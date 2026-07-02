/*
 * The file browser — the dock's home screen.
 *
 * When the dock is open with no file loaded (F9 on an empty channel, or the last tab
 * closed) DockPanel renders THIS instead of the bare empty card: a grid/list of every
 * openable attachment in the CURRENT channel, filterable by type. It is the "find"
 * pillar of the dock (viewer = open, browser = find, editor = handle).
 *
 * DATA comes entirely from engine/fileIndex (batch 1): getChannelFiles(channelId)
 * enumerates the client's cached message window into FileEntry[]; loadOlder() pages one
 * older window in (the same request native scroll makes — no search API). This module
 * adds only the UI: layout toggle, type-filter chips, thumbnails, infinite scroll, and
 * the click → load() that opens a file in the existing viewer.
 *
 * CHANNEL BINDING. It always reads the LIVE current channel id (getCurrentChannelId),
 * so a channel switch — which drops the empty shell and re-renders it fresh — naturally
 * shows the new channel's files. The per-channel index cache is invalidated on switch
 * by channelMemory.onChannelSelect (batch 1), so the list is never stale. A small
 * refresh tick (bumped by the flux MESSAGE_CREATE handler in index.tsx via
 * requestBrowserRefresh) invalidates + repaints when new attachments arrive live.
 *
 * FILTERING is client-side: the full enumeration is done once, then filtered by the
 * active category chip with no re-enumeration. Only the categories actually present in
 * the channel get a chip (plus the always-on "All").
 *
 * THUMBNAILS. Image entries render a downscaled CDN thumb via thumbUrl() (which keeps
 * the ex/is/hm signing params) with loading="lazy" so only cards near the viewport hit
 * the CDN. Non-image entries show their ContentType glyph. A file in a category the user
 * turned OFF (viewerEnabled false) is dimmed; clicking it still works but load() will
 * fall through to the stock download path (the same gate the chip uses).
 *
 * NO module-top React.createElement — everything is inside the component / helpers,
 * evaluated at render time (the panel.tsx rule).
 */

import { React } from "@webpack/common";

import { categoryOf, viewerEnabled, type ViewerCategory } from "../engine/categoryMap";
import { canLoadOlder, getChannelFiles, invalidate, loadOlder, type FileEntry } from "../engine/fileIndex";
import { load } from "../engine/load";
import { getCurrentChannelId } from "../host/channel";
import { thumbUrl } from "../viewers/image/url";
import { STRINGS } from "../strings";
import { categoryGlyphPaths } from "./browserIcons";
import { iconPaths } from "./toolbar";

const h = (...args: any[]) => (React.createElement as any)(...args);

/** The browser's own view mode, remembered for the session across re-renders/channel
 *  switches (module-level so it survives the empty shell being torn down + rebuilt on
 *  a channel switch — a session-wide look preference, not per-channel state). */
type Layout = "grid" | "list";
let layoutMode: Layout = "grid";
/** The active type-filter chip (null = All). Also session-wide; reset to All whenever
 *  the chosen category is absent from the entered channel (handled in the component). */
let activeFilter: ViewerCategory | null = null;

/** A monotonic tick the flux MESSAGE_CREATE handler bumps (via requestBrowserRefresh)
 *  to force the mounted browser to re-enumerate. Read into state on mount so a live
 *  attachment shows up without a manual reopen. */
let refreshTick = 0;
let notifyRefresh: (() => void) | null = null;

/** Called from index.tsx's flux MESSAGE_CREATE/DELETE handler when a message lands in
 *  the channel the browser is showing: drop the cached index for that channel and, if
 *  a browser is mounted, nudge it to re-read. Cheap + idempotent; a no-op when no
 *  browser is on screen. */
export function requestBrowserRefresh(channelId: string | null): void {
    invalidate(channelId);
    refreshTick++;
    notifyRefresh?.();
}

// Human byte size — the same rhythm as the image header ("812 KB", "2.3 MB").
function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const kb = n / 1024;
    if (kb < 1024) return `${Math.round(kb)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
}

// A short format label from the filename extension (PNG, PDF, GLB…), upper-cased.
function extLabel(name: string): string {
    const m = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(name);
    return m ? m[1].toUpperCase() : "";
}

/** The category chips to show: "All" first, then only the categories PRESENT among the
 *  channel's files, in the Viewers-page display order. */
const CATEGORY_ORDER: ViewerCategory[] = [
    "documents", "spreadsheets", "images", "exoticImages",
    "codeText", "diagrams", "models3d", "media", "presentations"
];

function presentCategories(items: FileEntry[]): ViewerCategory[] {
    const seen = new Set<ViewerCategory>();
    for (const it of items) if (it.category) seen.add(it.category);
    return CATEGORY_ORDER.filter(c => seen.has(c));
}

/** True for entries we render an image thumbnail for (raster/vector web images). The
 *  exotic decoders (tiff/psd/heic/…) are NOT thumbnailed — the CDN proxy can't resize
 *  them, so they get their type glyph instead. */
function isThumbnailable(entry: FileEntry): boolean {
    return entry.category === "images";
}

export function FileBrowser() {
    const { useState, useEffect, useRef, useCallback } = React;

    const channelId = getCurrentChannelId();
    // Re-read the index whenever the refresh tick changes (live message arrival) or the
    // channel changes. getChannelFiles is cached per channel, so this is cheap.
    const [tick, setTick] = useState(refreshTick);
    useEffect(() => {
        notifyRefresh = () => setTick(refreshTick);
        return () => { if (notifyRefresh) notifyRefresh = null; };
    }, []);

    // Local layout/filter state mirrors the module-level session prefs so a toggle
    // repaints immediately; the module vars keep the choice across shell rebuilds.
    const [layout, setLayout] = useState<Layout>(layoutMode);
    const [filter, setFilter] = useState<ViewerCategory | null>(activeFilter);
    // A bump used to repaint after loadOlder() resolves (the index mutates in place).
    const [, bump] = useState(0);
    const rerender = useCallback(() => bump(n => n + 1), []);

    const state = getChannelFiles(channelId);
    const cats = presentCategories(state.items);

    // If the active filter isn't present in this channel, fall back to All (keeps the
    // module pref if it reappears in another channel — we only override the render).
    const effFilter = filter && cats.includes(filter) ? filter : null;

    const items = effFilter ? state.items.filter(it => it.category === effFilter) : state.items;

    // --- infinite scroll: observe a sentinel at the list end -----------------
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const loadingRef = useRef(false);
    useEffect(() => {
        const sentinel = sentinelRef.current;
        const scroller = scrollerRef.current;
        if (!sentinel || !scroller) return;
        const io = new IntersectionObserver(entries => {
            for (const e of entries) {
                if (!e.isIntersecting) continue;
                if (loadingRef.current) return;
                if (!canLoadOlder(channelId)) return;
                loadingRef.current = true;
                rerender(); // show the spinner row immediately
                loadOlder(channelId).then(() => {
                    loadingRef.current = false;
                    rerender();
                });
            }
        }, { root: scroller, rootMargin: "200px 0px", threshold: 0.01 });
        io.observe(sentinel);
        return () => io.disconnect();
        // Re-arm when the channel, the item count, or the filter changes (the sentinel
        // moves / the page boundary shifts).
    }, [channelId, state.items.length, effFilter, tick]);

    const onLayout = useCallback((mode: Layout) => {
        layoutMode = mode;
        setLayout(mode);
    }, []);
    const onFilter = useCallback((cat: ViewerCategory | null) => {
        activeFilter = cat;
        setFilter(cat);
    }, []);

    const openEntry = useCallback((entry: FileEntry) => {
        // The SAME endpoint a chip click uses: load() routes through detectType →
        // showContent → the registered viewer. A file in an OFF category still calls
        // load(), which the viewer-enabled gate lets fall through to stock download —
        // consistent with the chip behaviour.
        load({ name: entry.filename, url: entry.url });
    }, []);

    // --- toolbar row: title + layout toggle ----------------------------------
    const segBtn = (mode: Layout, label: string, hint: string, first: boolean, last: boolean) =>
        h("button", {
            key: mode,
            type: "button",
            className: "dockview-fb-seg" + (layout === mode ? " dockview-fb-seg--active" : "")
                + (first ? " dockview-fb-seg--first" : "") + (last ? " dockview-fb-seg--last" : ""),
            "aria-pressed": layout === mode,
            title: hint,
            onClick: () => onLayout(mode)
        }, label);

    const toolbar = h(
        "div",
        { className: "dockview-fb-toolbar" },
        h("div", { className: "dockview-fb-title" }, STRINGS.browser.title),
        h(
            "div",
            { className: "dockview-fb-seg-group", role: "group", "aria-label": STRINGS.browser.title },
            segBtn("grid", STRINGS.browser.layoutGrid, STRINGS.browser.layoutGridHint, true, false),
            segBtn("list", STRINGS.browser.layoutList, STRINGS.browser.layoutListHint, false, true)
        )
    );

    // --- filter chips row (only when there's more than one category present) --
    const chip = (cat: ViewerCategory | null, label: string, glyph: any[] | null) => {
        const active = effFilter === cat;
        return h(
            "button",
            {
                key: cat ?? "all",
                type: "button",
                className: "dockview-fb-chip" + (active ? " dockview-fb-chip--active" : ""),
                "aria-pressed": active,
                onClick: () => onFilter(cat)
            },
            glyph
                ? h("svg", { className: "dockview-fb-chip-icon", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true }, ...glyph)
                : null,
            h("span", null, label)
        );
    };
    const chipsRow = cats.length > 1
        ? h(
            "div",
            { className: "dockview-fb-chips", role: "group", "aria-label": STRINGS.browser.filterAll },
            chip(null, STRINGS.browser.filterAll, null),
            ...cats.map(c => chip(c, STRINGS.viewers.cat[c], categoryGlyphPaths(c)))
        )
        : null;

    // --- the body: empty state OR the grid/list + spinner sentinel -----------
    let body: any;
    if (!state.items.length) {
        body = h(
            "div",
            { className: "dockview-fb-empty" },
            h(
                "svg",
                { className: "dockview-fb-empty-icon", width: 48, height: 48, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                h("path", {
                    fill: "currentColor",
                    d: "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-7-7Zm0 2.5L17.5 9H14a1 1 0 0 1-1-1V4.5ZM8 13h8v1.5H8V13Zm0 3.5h8V18H8v-1.5Z"
                })
            ),
            h("div", { className: "dockview-fb-empty-title" }, STRINGS.browser.emptyTitle),
            h("div", { className: "dockview-fb-empty-sub" }, STRINGS.browser.emptySub)
        );
    } else {
        const cards = items.map(entry => renderCard(entry, layout, openEntry));
        const spinner = state.loading || loadingRef.current
            ? h(
                "div",
                { className: "dockview-fb-more" },
                h("div", { className: "dockview-fb-more-spinner", "aria-hidden": true }),
                h("span", null, STRINGS.browser.loadingMore)
            )
            : null;
        // The sentinel sits at the END: entering the viewport pages older files in. It
        // stays in the DOM (dimmed by the spinner above it) so the observer keeps firing.
        const sentinel = h("div", { className: "dockview-fb-sentinel", ref: sentinelRef });
        body = h(
            "div",
            {
                className: "dockview-fb-scroller",
                ref: scrollerRef
            },
            h(
                "div",
                { className: layout === "grid" ? "dockview-fb-grid" : "dockview-fb-listwrap" },
                ...cards
            ),
            spinner,
            sentinel
        );
    }

    return h(
        "div",
        { className: "dockview-fb", key: channelId ?? "nochannel" },
        toolbar,
        chipsRow,
        body
    );
}

/** One file card/row. Grid = a thumbnail/glyph tile with the name under it; list = a
 *  glyph/thumb + name + meta row. Off-category entries are dimmed. */
function renderCard(entry: FileEntry, layout: Layout, open: (e: FileEntry) => void) {
    const enabled = viewerEnabled(entry.type);
    const dim = enabled ? "" : " dockview-fb-card--off";
    const ext = extLabel(entry.filename);
    const sizeStr = typeof entry.size === "number" ? formatBytes(entry.size) : "";

    // The visual: an image thumbnail (lazy) or the type glyph.
    let media: any;
    if (isThumbnailable(entry)) {
        // Downscaled CDN thumb — signing params preserved by thumbUrl. loading="lazy"
        // defers the request until the card nears the viewport.
        const w = layout === "grid" ? 150 : 40;
        media = h("img", {
            className: "dockview-fb-thumb",
            src: thumbUrl(entry.url, w, w),
            loading: "lazy",
            decoding: "async",
            alt: "",
            "aria-hidden": true,
            // A broken thumbnail (expired link / 403) collapses to the glyph fallback.
            onError: (e: any) => { try { e.currentTarget.style.display = "none"; } catch { /* ignore */ } }
        });
    } else {
        media = h(
            "svg",
            { className: "dockview-fb-glyph", width: 28, height: 28, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            ...iconPaths(entry.type)
        );
    }

    const common = {
        role: "button",
        tabIndex: 0,
        title: entry.filename,
        onClick: () => open(entry),
        onKeyDown: (e: any) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(entry); } }
    };

    if (layout === "list") {
        return h(
            "div",
            { key: entry.messageId + entry.url, className: "dockview-fb-row" + dim, ...common },
            h("div", { className: "dockview-fb-row-media" }, media),
            h(
                "div",
                { className: "dockview-fb-row-main" },
                h("div", { className: "dockview-fb-row-name" }, entry.filename),
                h(
                    "div",
                    { className: "dockview-fb-row-meta" },
                    ext ? h("span", { className: "dockview-fb-badge" }, ext) : null,
                    sizeStr ? h("span", null, sizeStr) : null
                )
            )
        );
    }
    // Grid tile.
    return h(
        "div",
        { key: entry.messageId + entry.url, className: "dockview-fb-tile" + dim, ...common },
        h("div", { className: "dockview-fb-tile-media" }, media, ext ? h("span", { className: "dockview-fb-tile-badge" }, ext) : null),
        h("div", { className: "dockview-fb-tile-name" }, entry.filename)
    );
}
