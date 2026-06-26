/*
 * The dock shell — the React component bound to the host node.
 *
 * It paints Discord's native thread-sidebar chrome (resolved CSS-module classes +
 * our own dockview-* classes) around the active window's body: the resize handle,
 * the header (top row = icon/name/⋯/X or the tab strip; second row = the active
 * viewer's controls), the body-wrap, and the find slot.
 *
 * Wiring into the engine:
 *  - On mount it publishes its rerender via setRenderer(); on unmount it clears the
 *    slot GUARDED by isRenderer (a mount/unmount race: a remount registers first,
 *    then the old panel's cleanup runs — without the guard it would null the LIVE
 *    renderer the new panel just published).
 *  - The body dispatches on getActiveWindow().content.type → getViewer(type)?.Body.
 *    With NO viewer registered (the Phase-2 reality for EVERY type) it falls to the
 *    StateCards: loading (content.loading), empty (no file), else unsupported.
 *  - The resize drag is a PURE DOM operation decoupled from React (a rAF coalesces
 *    pointermoves into one host-width write per frame; React state is touched ONCE on
 *    drag end, which persists the width). No re-render during the drag.
 *
 * NO module-top React.createElement. The CLS map below is plain findCssClasses
 * lookups returning objects (no elements), safe at module eval per panel.tsx.
 */

import { findCssClasses } from "@webpack";
import { ContextMenuApi, React } from "@webpack/common";

import { requestRender, isRenderer, setRenderer } from "../engine/forceRender";
import { LS_WIDTH, lsSet } from "../engine/persist";
import { closeTab } from "../engine/tabs";
import { consumePendingScroll } from "../engine/viewState";
import { getActiveWindow, getActiveWindowId, getWindows } from "../engine/window";
import { applyHostWidth, clampDockDrag } from "../host/layout";
import { applyOpenState } from "../host/mount";
import { getViewer } from "../viewers/registry";
import { DockMoreMenu } from "./DockMoreMenu";
import { DockTabs } from "./DockTabs";
import { HeaderControls, hasViewerControls } from "./HeaderControls";
import { LoadingBody, renderEmptyBody, renderErrorBody, renderUnsupportedBody } from "./StateCards";
import { iconPaths } from "./toolbar";
import { STRINGS } from "../strings";

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
    if (win.content.name == null) return renderEmptyBody();
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
            setWidth(final); // commit to React ONCE → the [width] effect persists it
        };
        document.body.style.cursor = "ew-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    }, []);

    const close = useCallback(() => {
        // The far-right ✕ closes the ACTIVE window. With a lone window that IS the
        // dock, so closeTab falls through to the host's closePanel (member-list
        // restore etc.). With ≥2 windows it closes just the active tab.
        closeTab(getActiveWindowId());
    }, []);

    const win = getActiveWindow();
    const windows = getWindows();
    const hasContent = win.content.name != null;
    const title = hasContent ? (win.content.name as string) : "DockView";

    // Leading file-type glyph (built lazily here — React is ready now — from the
    // plain-data FILE_TYPE_ICON via iconPaths).
    const leadingIcon = hasContent
        ? React.createElement(
            "svg",
            {
                className: "dockview-header-icon",
                width: 20,
                height: 20,
                viewBox: "0 0 24 24",
                fill: "none",
                "aria-hidden": true
            },
            ...iconPaths(win.content.type)
        )
        : null;

    const headerBtn = (
        key: string,
        label: string,
        titleAttr: string,
        path: string,
        onClick: (e: any) => void,
        extraCls = ""
    ) =>
        React.createElement(
            "div",
            {
                key,
                className: `${CLS.iconWrapper} ${CLS.clickable} ${extraCls}`.trim(),
                role: "button",
                tabIndex: 0,
                "aria-label": label,
                title: titleAttr,
                onClick
            },
            React.createElement(
                "svg",
                { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                React.createElement("path", { fill: "currentColor", d: path })
            )
        );

    const moreBtn = hasContent
        ? headerBtn(
            "more",
            STRINGS.header.more,
            STRINGS.header.more,
            "M7 12.001C7 13.105 6.105 14 5 14C3.895 14 3 13.105 3 12.001C3 10.896 3.895 10.001 5 10.001C6.105 10.001 7 10.896 7 12.001ZM14 12.001C14 13.105 13.105 14 12 14C10.895 14 10 13.105 10 12.001C10 10.896 10.895 10.001 12 10.001C13.105 10.001 14 10.896 14 12.001ZM19 14C20.105 14 21 13.105 21 12.001C21 10.896 20.105 10.001 19 10.001C17.895 10.001 17 10.896 17 12.001C17 13.105 17.895 14 19 14Z",
            (e: any) => ContextMenuApi.openContextMenu(e, () => React.createElement(DockMoreMenu)),
            "dockview-more"
        )
        : null;

    const closeBtn = headerBtn(
        "close",
        STRINGS.header.close,
        STRINGS.header.closeHint,
        "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z",
        close,
        "dockview-close"
    );

    // The header grows to TWO rows whenever there's a viewer's relocated controls
    // strip below the top row. With zero viewers hasViewerControls() is false, so the
    // header stays one row. (The attach bar second row rides P8.)
    const showViewerRow = hasViewerControls();
    const twoRow = showViewerRow;

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
                        className: `${CLS.upper} dockview-header-upper`
                            + (windows.length >= 2 ? " dockview-header-upper--tabs" : "")
                    },
                    React.createElement(
                        "div",
                        {
                            className: `${CLS.headerChildren} dockview-header-children`
                                + (windows.length >= 2 ? " dockview-header-children--tabs" : "")
                        },
                        // Lone window → plain [glyph]+title. ≥2 windows → the flat tabs
                        // (each carrying its own ⋯/✕ in place, so no shared cluster).
                        ...(windows.length >= 2
                            ? [React.createElement(DockTabs, { onCloseActive: close })]
                            : [
                                leadingIcon,
                                React.createElement(
                                    "h2",
                                    { className: `${CLS.title} dockview-title`, title },
                                    title
                                )
                            ])
                    ),
                    // The shared far-right ⋯/✕ cluster exists ONLY for the lone window.
                    windows.length >= 2
                        ? null
                        : React.createElement(
                            "div",
                            { className: `${CLS.toolbar} dockview-header-actions` },
                            moreBtn,
                            closeBtn
                        )
                ),
                // SECOND ROW: the active viewer's controls strip (none in P2).
                showViewerRow
                    ? React.createElement(
                        "div",
                        { className: "dockview-viewer-toolbar" },
                        React.createElement(HeaderControls, null)
                    )
                    : null
            ),
            (() => {
                // The find box is a floating browser-style Ctrl+F panel positioned
                // top-right OVER the body. Each find-capable viewer supplies a model
                // via findModel(); with no viewer registered (P2) there is no model, so
                // the slot is empty. The box sits last inside the (relative) body-wrap.
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
                    )
                );
            })()
        )
    );
}
