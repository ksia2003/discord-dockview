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
 * adds only the UI: type-filter pills, thumbnails, infinite scroll, and the click →
 * load() that opens a file in the existing viewer. It renders a grid (Discord shows
 * media grids without a layout switch).
 *
 * HEADER HOISTING. The browser's identity does NOT sit on its own body row — it lives
 * in the DOCK HEADER. On browser home DockPanel renders the browser's title in header
 * row 1 (the slot the tab strip uses when a file is open) and the type filter in header
 * row 2 (the slot a viewer's controls use), so the browser and the viewer share one
 * two-row header grammar and the top row is never wasted. This module exports those
 * header pieces (browserTitleRow / browserFilterRow) alongside the body (FileBrowser).
 * They all read the SAME per-channel state (browserStates) and a change calls
 * requestRender(), which repaints the whole dock — header + body together — so no
 * cross-tree React state is needed (they render in one DockPanel pass).
 *
 * CHANNEL BINDING. It always reads the LIVE current channel id (getCurrentChannelId),
 * so a channel switch — which keeps the open browser home and re-renders it fresh (the
 * component is keyed by channel id) — naturally shows the new channel's files. The
 * per-channel index cache is invalidated on switch by channelMemory.onChannelSelect
 * (batch 1), so the list is never stale. A small refresh tick (bumped by the flux
 * MESSAGE_CREATE handler in index.tsx via requestBrowserRefresh) invalidates + repaints
 * when new attachments arrive live.
 *
 * PER-CHANNEL MEMORY (design §3.3). The chosen type filter and the scroll position are
 * remembered PER CHANNEL in our own in-memory Map (browserStates) — revisiting a channel
 * restores how you left its browser. In-memory only, like channelMemory; cleared on
 * plugin stop.
 *
 * FILTERING is client-side: the full enumeration is done once, then filtered by the
 * active category pill with no re-enumeration. Only the categories actually present in
 * the channel get a pill (plus the always-on "All").
 *
 * THUMBNAILS. Image entries render a downscaled CDN thumb via thumbUrl() (which keeps
 * the ex/is/hm signing params) with loading="lazy" so only cards near the viewport hit
 * the CDN. Non-image entries show their ContentType glyph. A file in a category the user
 * turned OFF (viewerEnabled false) is dimmed; clicking it still works but load() will
 * fall through to the stock download path (the same gate a chip click uses).
 *
 * NO module-top React.createElement — everything is inside the component / helpers,
 * evaluated at render time (the panel.tsx rule).
 */

import { React } from "@webpack/common";

import { viewerEnabled, type ViewerCategory } from "../engine/categoryMap";
import { canLoadOlder, getChannelFiles, invalidate, loadOlder, type FileEntry } from "../engine/fileIndex";
import { load } from "../engine/load";
import { requestRender } from "../engine/forceRender";
import { getCurrentChannelId } from "../host/channel";
import { thumbUrl } from "../viewers/image/url";
import { STRINGS } from "../strings";
import { categoryGlyphPaths } from "./browserIcons";
import { iconPaths } from "./toolbar";

const h = (...args: any[]) => (React.createElement as any)(...args);

/** The browser's per-channel look state (design §3.3): the type-filter selection and the
 *  last scroll position. Remembered so returning to a channel restores how you left its
 *  browser. It is our OWN in-memory Map (not an extension of engine/channelMemory, which
 *  stores a single loaded-file descriptor); like that map it never persists to disk —
 *  the dock is a transient view over the session. */
interface BrowserState {
    filter: ViewerCategory | null;
    scrollTop: number;
}

const browserStates = new Map<string, BrowserState>();

/** The default look for a channel we've never browsed: no filter, top of list. */
function defaultBrowserState(): BrowserState {
    return { filter: null, scrollTop: 0 };
}

/** This channel's remembered browser state (created on first visit). */
function getBrowserState(channelId: string | null): BrowserState {
    const key = channelId ?? "";
    let s = browserStates.get(key);
    if (!s) { s = defaultBrowserState(); browserStates.set(key, s); }
    return s;
}

/** Drop EVERY channel's remembered browser state (plugin stop — paired with the other
 *  in-memory teardowns in index.tsx). */
export function clearBrowserStates(): void { browserStates.clear(); }

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
    // The header (title/filter) lives outside the body component, so also repaint the
    // whole dock — a live message can change the present-category set (a new type
    // appears → the filter row gains/loses options).
    requestRender();
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

// --- shared filter mutator (drives the whole dock, header + body) -------------
// The filter strip (browserFilterRow) lives OUTSIDE the FileBrowser body tree, so a
// click there can't call a local setState — it writes the per-channel state and
// requestRender()s the whole dock, which re-renders header + body from the Map in
// one pass. (Inside the body, useState still drives the immediate list repaint; the two
// stay in lock-step because both read the same BrowserState.)
function setFilter(channelId: string | null, cat: ViewerCategory | null): void {
    getBrowserState(channelId).filter = cat;
    requestRender();
}

/** Header ROW 1 content for browser home: the title in the tab-strip slot. DockPanel
 *  renders this in place of the (empty) tab strip when the dock is on its file-browser
 *  home. The browser is grid-only (Discord shows media grids without a layout switch),
 *  so the title stands alone. */
export function browserTitleRow() {
    return h(
        "div",
        { className: "dockview-fb-headline" },
        h("div", { className: "dockview-fb-title" }, STRINGS.browser.title)
    );
}

/** True when the browser home wants a SECOND header row: the type filter, shown only
 *  when the current channel has more than one openable category (a single-category
 *  channel needs no filter). DockPanel reads this to decide the two-row header. */
export function browserHasFilterRow(): boolean {
    const channelId = getCurrentChannelId();
    return presentCategories(getChannelFiles(channelId).items).length > 1;
}

/** Header ROW 2 content for browser home: the type filter as rounded PILLS (the
 *  Discord forum tag-pill grammar): each type is a small pill with its category glyph
 *  + label; the ACTIVE pill fills with the selected-surface tint + brighter text (the
 *  native forum "selected tag" look). "All" first, then one pill per PRESENT category.
 *  DockPanel renders this in the second-row slot a viewer's controls use, so the
 *  browser and the viewer share one two-row header. Null when there's nothing to
 *  filter. */
export function browserFilterRow() {
    const channelId = getCurrentChannelId();
    const state = getBrowserState(channelId);
    const cats = presentCategories(getChannelFiles(channelId).items);
    if (cats.length <= 1) return null;
    const active = state.filter;
    const pill = (cat: ViewerCategory | null, label: string, glyph: any[] | null) => {
        const on = active === cat;
        return h(
            "button",
            {
                key: cat ?? "all",
                type: "button",
                className: "dockview-fb-pill" + (on ? " dockview-fb-pill--active" : ""),
                "aria-pressed": on,
                onClick: () => setFilter(channelId, cat)
            },
            glyph
                ? h("svg", { className: "dockview-fb-pill-icon", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true }, ...glyph)
                : null,
            h("span", null, label)
        );
    };
    return h(
        "div",
        { className: "dockview-fb-pills", role: "group", "aria-label": STRINGS.browser.filterAll },
        pill(null, STRINGS.browser.filterAll, null),
        ...cats.map(c => pill(c, STRINGS.viewers.cat[c], categoryGlyphPaths(c)))
    );
}

export function FileBrowser() {
    const { useState, useEffect, useRef, useCallback } = React;

    const channelId = getCurrentChannelId();
    const mem = getBrowserState(channelId);
    // Re-read the index whenever the refresh tick changes (live message arrival) or the
    // channel changes. getChannelFiles is cached per channel, so this is cheap.
    const [tick, setTick] = useState(refreshTick);

    // The filter lives in the per-channel Map and is toggled from the hoisted header
    // (browserFilterRow), which requestRender()s the whole dock. The body reads it
    // straight off the Map on each render — no local mirror to drift.
    const filter = mem.filter;

    useEffect(() => {
        // A tick can arrive from a live message (requestBrowserRefresh) OR from the γ
        // context menu setting mem.filter on the CURRENT channel — reconcile by pulling
        // the fresh tick so the body re-reads the index + the Map's filter.
        notifyRefresh = () => { setTick(refreshTick); };
        return () => { if (notifyRefresh) notifyRefresh = null; };
    }, [mem]);
    // A bump used to repaint after loadOlder() resolves (the index mutates in place).
    const [, bump] = useState(0);
    const rerender = useCallback(() => bump(n => n + 1), []);
    // The last loadOlder() paged nothing new (a network hiccup) → show an honest retry
    // row instead of silently retrying forever. Cleared when a retry succeeds / re-arms.
    const [loadFailed, setLoadFailed] = useState(false);

    const state = getChannelFiles(channelId);

    // The active filter is honoured even when its category has no pill in THIS channel
    // (a γ prefilter can precede the file appearing in the cached window): the filtered
    // list simply comes up empty, and the filter-empty card explains it honestly rather
    // than silently reverting to All. `effFilter` is just the current filter (null = All).
    const effFilter = filter;

    const items = effFilter ? state.items.filter(it => it.category === effFilter) : state.items;

    // --- per-channel scroll restore ------------------------------------------
    // Restore this channel's remembered scroll once the list is painted; save it on
    // scroll (throttled to a frame). Keyed on channel + item count so a fresh channel
    // (or a paged-in older window) re-applies the saved offset without fighting the user.
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const restoredRef = useRef(false);
    useEffect(() => {
        restoredRef.current = false;
    }, [channelId]);
    useEffect(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        if (!restoredRef.current && mem.scrollTop > 0) {
            scroller.scrollTop = mem.scrollTop;
            restoredRef.current = true;
        }
        let raf = 0;
        const onScroll = () => {
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                mem.scrollTop = scroller.scrollTop;
            });
        };
        scroller.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            if (raf) cancelAnimationFrame(raf);
            scroller.removeEventListener("scroll", onScroll);
        };
    }, [channelId, state.items.length, effFilter]);

    // --- infinite scroll: observe a sentinel at the list end -----------------
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const loadingRef = useRef(false);
    const runLoadOlder = useCallback(() => {
        if (loadingRef.current) return;
        if (!canLoadOlder(channelId)) return;
        loadingRef.current = true;
        setLoadFailed(false);
        rerender(); // show the spinner row immediately
        loadOlder(channelId).then(after => {
            loadingRef.current = false;
            // loadError is set ONLY when the network fetch itself failed — not when a
            // fetch succeeds but pages in an older window that held no openable
            // attachments (a legitimate no-growth result). So the retry row shows on a
            // real hiccup, and a text-only older page just quietly reaches the end.
            setLoadFailed(after.loadError);
            rerender();
        });
    }, [channelId, rerender]);
    useEffect(() => {
        const sentinel = sentinelRef.current;
        const scroller = scrollerRef.current;
        if (!sentinel || !scroller) return;
        const io = new IntersectionObserver(entries => {
            for (const e of entries) {
                if (!e.isIntersecting) continue;
                // Don't auto-page while a previous attempt is showing its retry row —
                // the user taps Try again (no silent infinite retry on a bad network).
                if (loadFailed) return;
                runLoadOlder();
            }
        }, { root: scroller, rootMargin: "200px 0px", threshold: 0.01 });
        io.observe(sentinel);
        return () => io.disconnect();
        // Re-arm when the channel, the item count, or the filter changes (the sentinel
        // moves / the page boundary shifts).
    }, [channelId, state.items.length, effFilter, tick, loadFailed, runLoadOlder]);

    const openEntry = useCallback((entry: FileEntry) => {
        // The SAME endpoint a chip click uses: load() routes through detectType →
        // showContent → the registered viewer. A file in an OFF category still calls
        // load(), which the viewer-enabled gate lets fall through to stock download —
        // consistent with the chip behaviour.
        load({ name: entry.filename, url: entry.url });
    }, []);

    // A centred empty-state card: the folder icon + a title + a sub-line. Reused for
    // both the "channel has no files" and the "filter matches nothing" states.
    const emptyCard = (title: string, sub: string) => h(
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
        h("div", { className: "dockview-fb-empty-title" }, title),
        h("div", { className: "dockview-fb-empty-sub" }, sub)
    );

    // --- the body: empty state OR the grid/list + spinner sentinel -----------
    let body: any;
    if (!state.items.length) {
        // The channel genuinely has no openable attachments in the cached window.
        body = emptyCard(STRINGS.browser.emptyTitle, STRINGS.browser.emptySub);
    } else if (!items.length) {
        // The channel HAS files, but the active type filter matches none of them — an
        // honest "no <type> here" rather than silently showing everything.
        const label = effFilter ? STRINGS.viewers.cat[effFilter] : STRINGS.browser.filterAll;
        body = emptyCard(STRINGS.browser.emptyFilterTitle(label), STRINGS.browser.emptyFilterSub);
    } else {
        const cards = items.map(entry => renderCard(entry, openEntry));
        // The end-of-list row: while a page is loading, a dim spinner; if the last page
        // FAILED (a network hiccup), an honest retry row (no silent infinite retry); it
        // never just disappears while there's more to load. When there's nothing more
        // before, no row shows.
        let moreRow: any = null;
        if (state.loading || loadingRef.current) {
            moreRow = h(
                "div",
                { className: "dockview-fb-more" },
                h("div", { className: "dockview-fb-more-spinner", "aria-hidden": true }),
                h("span", null, STRINGS.browser.loadingMore)
            );
        } else if (loadFailed) {
            moreRow = h(
                "div",
                { className: "dockview-fb-more dockview-fb-more--failed" },
                h("span", null, STRINGS.browser.loadMoreFailed),
                h(
                    "button",
                    {
                        type: "button",
                        className: "dockview-fb-retry",
                        onClick: () => { setLoadFailed(false); runLoadOlder(); }
                    },
                    STRINGS.browser.loadMoreRetry
                )
            );
        }
        // The sentinel sits at the END: entering the viewport pages older files in. It
        // stays in the DOM (below the spinner/retry row) so the observer keeps firing —
        // but not while the retry row is up (the observer effect bails on loadFailed).
        const sentinel = h("div", { className: "dockview-fb-sentinel", ref: sentinelRef });
        body = h(
            "div",
            {
                className: "dockview-fb-scroller",
                ref: scrollerRef
            },
            h(
                "div",
                { className: "dockview-fb-grid" },
                ...cards
            ),
            moreRow,
            sentinel
        );
    }

    // The body is PURE content now — the title + type filter live in the dock header
    // (browserTitleRow / browserFilterRow), rendered by DockPanel.
    return h(
        "div",
        { className: "dockview-fb", key: channelId ?? "nochannel" },
        body
    );
}

/** One file card: a thumbnail/glyph tile with the name under it. Off-category entries
 *  are dimmed. */
function renderCard(entry: FileEntry, open: (e: FileEntry) => void) {
    const enabled = viewerEnabled(entry.type);
    const dim = enabled ? "" : " dockview-fb-card--off";
    const ext = extLabel(entry.filename);

    // The visual: an image thumbnail (lazy) or the type glyph.
    let media: any;
    if (isThumbnailable(entry)) {
        // Downscaled CDN thumb — signing params preserved by thumbUrl. loading="lazy"
        // defers the request until the card nears the viewport.
        media = h("img", {
            className: "dockview-fb-thumb",
            src: thumbUrl(entry.url, 150, 150),
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

    // Grid tile.
    return h(
        "div",
        { key: entry.messageId + entry.url, className: "dockview-fb-tile" + dim, ...common },
        h("div", { className: "dockview-fb-tile-media" }, media, ext ? h("span", { className: "dockview-fb-tile-badge" }, ext) : null),
        h("div", { className: "dockview-fb-tile-name" }, entry.filename)
    );
}
