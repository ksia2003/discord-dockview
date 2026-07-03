/*
 * The dock shell — the React component bound to the host node.
 *
 * It paints Discord's native thread-sidebar chrome (resolved CSS-module classes +
 * our own dockview-* classes) around the active window's body: the resize handle,
 * the header (top row = the tab strip on the left + a dock-level X at the far right;
 * second row = the active viewer's controls), the body-wrap, and the find slot.
 *
 * The tab strip renders one tab per REAL window (a content tab or a pinned tab). A
 * content-less transient — the F9-opened empty shell — gets NO tab: the strip is
 * empty and the body shows the empty-state card. A tab carries its own icon/name/⋯/×;
 * closing the LAST real tab via that × auto-hides the dock (it does NOT fall back to
 * an empty shell). The far-right X is dock-level: it closes the ENTIRE dock (same as
 * the F9 toggle), distinct from a tab's × which closes just that file.
 *
 * Wiring into the engine:
 *  - On mount it publishes its rerender via setRenderer(); on unmount it clears the
 *    slot GUARDED by isRenderer (a mount/unmount race: a remount registers first,
 *    then the old panel's cleanup runs — without the guard it would null the LIVE
 *    renderer the new panel just published).
 *  - The body dispatches on getActiveWindow().content.type → getViewer(type)?.Body.
 *    With no viewer for the type (or an idle body) it falls to the StateCards:
 *    loading (content.loading), empty (no file), else unsupported.
 *  - The resize drag is a PURE DOM operation decoupled from React (a rAF coalesces
 *    pointermoves into one host-width write per frame; React state is touched ONCE on
 *    drag end, which persists the width). No re-render during the drag.
 *
 * NO module-top React.createElement. The CLS map below is plain findCssClasses
 * lookups returning objects (no elements), safe at module eval per panel.tsx.
 */

import { findCssClasses } from "@webpack";
import { React } from "@webpack/common";

import { dvFetch } from "../engine/fetch";
import { getLiveController, requestRender, isRenderer, setRenderer } from "../engine/forceRender";
import { LS_WIDTH, lsSet } from "../engine/persist";
import { consumePendingScroll } from "../engine/viewState";
import { getActiveWindow } from "../engine/window";
import { applyHostWidth, clampDockDrag } from "../host/layout";
import { applyOpenState } from "../host/mount";
import { toggle } from "../host/open";
import { getViewer } from "../viewers/registry";
import type { ViewerContext } from "../engine/types";
import { getCurrentChannelId } from "../host/channel";
import { clearArtifact } from "../engine/load";
import { attachToolbar, isAttachBarOpen } from "../edit/attach";
import { DockTabs } from "./DockTabs";
import { browserFilterRow, browserHasFilterRow, browserTitleRow, FileBrowser } from "./FileBrowser";
import { FindBar } from "./FindBar";
import { HeaderControls, hasViewerControls } from "./HeaderControls";
import { LoadingBody, renderEmptyBody, renderErrorBody, renderUnsupportedBody } from "./StateCards";
import { STRINGS } from "../strings";

/** A minimal ViewerContext for the find-slot dispatch — findModel only reads
 *  window/content + requestRender; fetch is the live dvFetch in case a viewer's
 *  model ever needs it. */
function findCtx(win = getActiveWindow()): ViewerContext {
    return { window: win, content: win.content, requestRender, fetch: dvFetch };
}

/** The active viewer's find bar, or null. A find-capable viewer returns a
 *  FindBarModel from findModel() only while its find bar is open; the slot is
 *  empty otherwise (no viewer, or find closed). */
function renderFindBar() {
    const win = getActiveWindow();
    if (win.content.name == null || win.content.loading || win.content.error) return null;
    const model = getViewer(win.content.type)?.findModel?.(findCtx(win));
    return model ? React.createElement(FindBar, { model }) : null;
}

// --- Discord native class resolution (theme-aware, update-robust) -----------
// Fallbacks are the literal classes from the build we extracted on (2026-06).
type ClassMap = Record<string, string>;

function cssMod(...keys: string[]): ClassMap {
    try {
        const m = (findCssClasses as any)?.(...keys);
        if (m && typeof m === "object") return m;
    } catch {
        /* fall through to {} */
    }
    return {};
}

const wrapMod = cssMod("chatLayerWrapper", "resizeHandle", "container", "notFloating");
const headMod = cssMod("upperContainer", "toolbar", "children", "container", "themed", "title", "titleWrapper");
const textMd = cssMod("text-md/medium")["text-md/medium"] || "text-md/medium_cf4812";
const defaultColor = cssMod("defaultColor")["defaultColor"] || "defaultColor__4bd52";

const CLS = {
    wrapper: wrapMod.chatLayerWrapper || "chatLayerWrapper__01ae2",
    resizeHandle: wrapMod.resizeHandle || "resizeHandle__01ae2",
    card: wrapMod.container || "container__01ae2",
    headerSection: `${headMod.container || "container__9293f"} ${headMod.themed || "themed__9293f"}`,
    upper: headMod.upperContainer || "upperContainer__9293f",
    headerChildren: headMod.children || "children__9293f",
    toolbar: headMod.toolbar || "toolbar__9293f",
    titleWrapper: headMod.titleWrapper || "titleWrapper__9293f",
    title: `${defaultColor} ${textMd} ${headMod.title || "title__9293f"}`,
    iconWrapper: "iconWrapper__9293f",
    clickable: "clickable__9293f"
};

/** The body dispatcher. Routes content.type to its viewer's Body; with no viewer
 *  registered (Phase 2) it falls to the shared state cards. The order — empty, then
 *  error, then loading, then viewer/unsupported — matches the old renderBody. */
function renderBody() {
    const win = getActiveWindow();
    if (win.content.name == null) {
        // The dock's HOME: an open-but-empty shell (F9, or the last tab closed) shows
        // the CURRENT channel's file browser instead of a bare "open a file" card. The
        // browser reads the live channel itself, so a channel switch (which rebuilds
        // this shell) shows the new channel's files. Off a real channel — the dock
        // never mounts there, but guard anyway — fall back to the plain empty card.
        return getCurrentChannelId() ? React.createElement(FileBrowser, null) : renderEmptyBody();
    }
    if (win.content.error != null) return renderErrorBody(win.content.error);
    if (win.content.loading) return React.createElement(LoadingBody, null);
    const viewer = getViewer(win.content.type);
    if (viewer) return React.createElement(viewer.Body, { key: win.content.seq });
    // No viewer for this type yet → the unsupported/download card (every type, P2).
    return renderUnsupportedBody();
}

export function DockPanel() {
    const { useState, useCallback, useEffect, useRef } = React;

    const [, bump] = useState(0);
    const rerender = useCallback(() => bump((n: number) => n + 1), []);
    // Publish our repaint on mount; clear it on unmount GUARDED by isRenderer (the
    // mount/unmount race — see the forceRender slot's note).
    useEffect(() => {
        setRenderer(rerender);
        return () => {
            if (isRenderer(rerender)) setRenderer(null);
        };
    }, [rerender]);

    const [width, setWidth] = useState(getActiveWindow().state.width);
    const resizing = useRef(false);

    useEffect(() => {
        getActiveWindow().state.width = width;
        lsSet(LS_WIDTH, String(Math.round(width)));
        applyOpenState();
    }, [width]);

    // After a cache RESTORE of a non-pdf file, re-apply the saved scroll once the
    // body DOM is committed. (A pdf body restores its OWN scroll after its lazy page
    // boxes exist, so a pdf viewer opts out via scrollerSelector / its own restore;
    // the generic consume here is a no-op when there's no pending scroll.)
    useEffect(() => {
        if (getActiveWindow().content.type !== "pdf") consumePendingScroll(getActiveWindow());
    });

    const onResizeStart = useCallback((e: any) => {
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        resizing.current = true;
        const startX = e.clientX;
        const startWidth = getActiveWindow().state.width;

        const handle: HTMLElement | null = e.currentTarget || null;
        handle?.classList.add("dockview-resizing");

        const overlay = document.createElement("div");
        overlay.className = "dockview-drag-overlay";
        document.body.appendChild(overlay);

        // If a PDF body is mounted, drive its CSS live-scale preview through the drag
        // (and pause its ResizeObserver via setResizeDragging) so the pages follow the
        // width smoothly and re-raster crisply ONCE on release — never mid-drag. Any
        // other body reflows for free from the host's CSS width, so this is a no-op
        // unless the "pdf" controller is published; the dock stays viewer-agnostic.
        const pdf = getLiveController<{
            setResizeDragging(on: boolean): void;
            beginLiveScale(): void;
            liveScale(ratio: number): void;
            endLiveScale(): void;
        }>("pdf");
        let pdfScaled = false;
        pdf?.setResizeDragging(true);
        pdf?.beginLiveScale();

        // The drag is a PURE DOM operation, fully decoupled from React: every
        // pointermove records the latest pixel and a single rAF coalesces them into
        // one host-width write per frame. We deliberately do NOT touch React state
        // (no setWidth / requestRender) DURING the drag — a re-render would re-run
        // renderBody() (and, once viewers exist, re-highlight / re-raster the whole
        // body every frame). The content reflows purely from the host's CSS width,
        // so no render is needed to make the body follow. We commit to React ONCE on
        // drag end (setWidth → the [width] effect persists it).
        let pendingX = startX;
        let rafId = 0;
        const flush = () => {
            rafId = 0;
            if (!resizing.current) return;
            const delta = startX - pendingX; // drag left edge: leftward = wider
            const next = clampDockDrag(startWidth + delta);
            if (next !== getActiveWindow().state.width) {
                getActiveWindow().state.width = next;
                applyHostWidth(); // direct inline-style write, no React
                if (pdf) { pdf.liveScale(next / startWidth); pdfScaled = true; }
            }
        };
        const onMove = (ev: MouseEvent) => {
            if (!resizing.current) return;
            pendingX = ev.clientX;
            if (!rafId) rafId = requestAnimationFrame(flush);
        };
        const onUp = () => {
            resizing.current = false;
            if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            handle?.classList.remove("dockview-resizing");
            overlay.remove();
            const delta = startX - pendingX;
            const final = clampDockDrag(startWidth + delta);
            getActiveWindow().state.width = final;
            applyHostWidth();
            // Drag settled: let the PDF body re-raster crisply at the final width.
            // Clear the drag flag FIRST (endLiveScale's queue pump checks it).
            pdf?.setResizeDragging(false);
            if (pdfScaled) pdf?.endLiveScale();
            setWidth(final); // commit to React ONCE → the [width] effect persists it
        };
        document.body.style.cursor = "ew-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    }, []);

    const closeDock = useCallback(() => {
        // The far-right X is DOCK-level: it closes the ENTIRE dock, exactly like the
        // F9 toggle / shortcut while open (every tab dropped, native sidebars
        // restored). Distinct from a tab's ✕, which closes just that one file and
        // leaves the dock open. toggle() closes because the dock is open here.
        toggle();
    }, []);

    const backToFiles = useCallback(() => {
        // Return from an open viewer to the channel's file browser: clearArtifact()
        // detaches the body (content.name → null), which makes renderBody() show the
        // FileBrowser home. The file stays cached, so reopening it from the browser is
        // instant. Only meaningful while a file is shown (the button hides otherwise).
        clearArtifact();
    }, []);

    const win = getActiveWindow();
    const hasContent = win.content.name != null;
    // The dock's HOME: an open-but-empty shell on a real channel shows the file
    // browser. Its identity is HOISTED into the header — the title + layout toggle take
    // the tab-strip slot (row 1, wasted before) and the type filter takes the second-row
    // slot a viewer's controls use — so the browser and the viewer share one two-row
    // header and the top row is never empty. Off a real channel the browser never
    // mounts (the plain empty card shows), so this is false there too.
    const isBrowserHome = !hasContent && getCurrentChannelId() != null;

    // "Back to files" — return from an open viewer to the channel's file browser. A
    // native icon button (left-arrow), shown only while a file is open (the browser is
    // already the empty-shell body). Sits left of the dock-close X in the actions area.
    const backBtn = hasContent
        ? React.createElement(
            "div",
            {
                className: `${CLS.iconWrapper} ${CLS.clickable} dockview-back-to-files`,
                role: "button",
                tabIndex: 0,
                "aria-label": STRINGS.browser.back,
                title: STRINGS.browser.backHint,
                onClick: backToFiles
            },
            React.createElement(
                "svg",
                { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                React.createElement("path", {
                    fill: "currentColor",
                    d: "M20 11H7.83l4.88-4.88a1 1 0 1 0-1.42-1.41l-6.58 6.58a1 1 0 0 0 0 1.42l6.58 6.58a1 1 0 0 0 1.42-1.41L7.83 13H20a1 1 0 0 0 0-2Z"
                })
            )
        )
        : null;

    // The dock-level close (the far-right X). A plain icon button in Discord's
    // native iconWrapper/clickable grammar, parked at the header's right edge.
    const closeBtn = React.createElement(
        "div",
        {
            className: `${CLS.iconWrapper} ${CLS.clickable} dockview-close`,
            role: "button",
            tabIndex: 0,
            "aria-label": STRINGS.header.closeDock,
            title: STRINGS.header.closeDockHint,
            onClick: closeDock
        },
        React.createElement(
            "svg",
            { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", {
                fill: "currentColor",
                d: "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z"
            })
        )
    );

    // The header grows to TWO rows for the second-row strip: the attach filename bar
    // (when the user picked "Attach to message") OVERRIDES the viewer controls strip;
    // otherwise the active viewer's controls show when it has any. An empty/loading/
    // errored body has no controls row.
    const showAttachBar = isAttachBarOpen() && hasContent;
    const showViewerRow = !showAttachBar && hasViewerControls();
    // The browser home takes the SAME second row for its type filter (only when the
    // channel has more than one openable category — a single-category channel needs no
    // filter), so the header grammar is identical whether a file or the browser is up.
    const showBrowserFilterRow = isBrowserHome && browserHasFilterRow();
    const twoRow = showAttachBar || showViewerRow || showBrowserFilterRow;

    return React.createElement(
        "div",
        { className: `${CLS.wrapper} dockview-wrapper` },
        React.createElement("div", {
            className: `${CLS.resizeHandle} dockview-resize`,
            onMouseDown: onResizeStart
        }),
        React.createElement(
            "div",
            { className: `${CLS.card} dockview-card` },
            React.createElement(
                "section",
                {
                    className: `${CLS.headerSection} dockview-header`
                        + (twoRow ? " dockview-header--tworow" : "")
                },
                React.createElement(
                    "div",
                    {
                        className: `${CLS.upper} dockview-header-upper dockview-header-upper--tabs`
                    },
                    React.createElement(
                        "div",
                        {
                            className: `${CLS.headerChildren} dockview-header-children`
                                + " dockview-header-children--tabs"
                        },
                        // On browser home the tab-strip slot carries the browser's title
                        // + layout toggle (row 1, wasted before); otherwise the tab strip
                        // (each tab carries its own icon/name/⋯/✕ in place).
                        isBrowserHome ? browserTitleRow() : React.createElement(DockTabs, null)
                    ),
                    // The right-edge actions: "back to files" (while a file is open) +
                    // the far-right DOCK X (closes the whole dock, not a tab).
                    React.createElement(
                        "div",
                        { className: `${CLS.toolbar} dockview-header-actions` },
                        backBtn,
                        closeBtn
                    )
                ),
                // SECOND ROW: the attach filename bar (when open) OR the active
                // viewer's controls strip OR — on browser home — the type filter. The
                // attach bar overrides the controls; the browser filter only shows when
                // there's no file open (mutually exclusive with the viewer row).
                showAttachBar
                    ? attachToolbar()
                    : showViewerRow
                        ? React.createElement(
                            "div",
                            { className: "dockview-viewer-toolbar" },
                            React.createElement(HeaderControls, null)
                        )
                        : showBrowserFilterRow
                            ? React.createElement(
                                "div",
                                { className: "dockview-viewer-toolbar dockview-fb-toolbar" },
                                browserFilterRow()
                            )
                            : null
            ),
            (() => {
                // The find box is a floating browser-style Ctrl+F panel positioned
                // top-right OVER the body. Each find-capable viewer supplies a model
                // via findModel(); a viewer with no open find bar returns null, so the
                // slot is empty. The box sits last inside the (relative) body-wrap.
                return React.createElement(
                    "div",
                    { className: "dockview-body-wrap" },
                    React.createElement(
                        "div",
                        {
                            className: "dockview-body"
                                + (hasContent && win.content.type === "pdf" ? " dockview-body-pdf" : "")
                        },
                        renderBody()
                    ),
                    renderFindBar()
                );
            })()
        )
    );
}
