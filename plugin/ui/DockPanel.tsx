/*
 * The dock shell — the React component bound to the host node.
 *
 * It paints Discord's native thread-sidebar chrome (resolved CSS-module classes +
 * our own dockview-* classes) around the active window's body: the resize handle,
 * the header (top row = the tab strip; second row = the active viewer's controls), the
 * body-wrap, and the find slot.
 *
 * The tab strip renders one tab per REAL window (a content tab). A content-less
 * transient — the empty-state shell — gets NO tab: the strip is empty and the body
 * shows the empty-state card. A tab carries its own icon/name/⋯/×; closing the LAST tab
 * leaves the dock OPEN on the empty-state body (the dock is ALWAYS visible now — it IS
 * the right rail — so there is no dock-close affordance).
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

import { findCssClasses } from "@vencord/types/webpack";
import { React } from "@vencord/types/webpack/common";

import { dvFetch } from "../engine/fetch";
import { getLiveController, requestRender, isRenderer, setRenderer } from "../engine/forceRender";
import { LS_WIDTH, lsSet } from "../engine/persist";
import { consumePendingScroll } from "../engine/viewState";
import { getActiveWindow } from "../engine/window";
import { getCurrentChannelMemId } from "../engine/channelMemory";
import { getContextView, isContextActive } from "../engine/contextTab";
import { ContextTabBody } from "./ContextTabBody";
import { VoiceChatBody } from "../viewers/voice/VoiceChatBody";
import { applyHostWidth, clampDockDrag } from "../host/layout";
import { applyOpenState } from "../host/mount";
import { getViewer } from "../viewers/registry";
import type { ViewerContext } from "../engine/types";
import { attachToolbar, isAttachBarOpen } from "../edit/attach";
import { DockTabs } from "./DockTabs";
import { FindBar } from "./FindBar";
import { HeaderControls, hasViewerControls } from "./HeaderControls";
import { LoadingBody, renderEmptyBody, renderErrorBody, renderUnsupportedBody } from "./StateCards";

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
    // The context tab (member list / profile) has no find bar.
    if (isContextActive(getCurrentChannelMemId())) return null;
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
    titleWrapper: headMod.titleWrapper || "titleWrapper__9293f",
    title: `${defaultColor} ${textMd} ${headMod.title || "title__9293f"}`
};

/** The body dispatcher. When the CONTEXT tab is the active view for the current channel,
 *  render the context body (member list / profile). Otherwise route content.type to its
 *  viewer's Body; with no viewer registered it falls to the shared state cards. The order
 *  — context, empty, error, loading, viewer/unsupported. Keyed on the channel id (via the
 *  caller) so a channel switch remounts the captured component with fresh props. */
function renderBody() {
    const channelId = getCurrentChannelMemId();
    const contextView = getContextView(channelId);
    if (contextView === "voice-chat") {
        return React.createElement(VoiceChatBody, { key: `voice-chat-${channelId ?? "none"}` });
    }
    if (contextView === "channel") {
        return React.createElement(ContextTabBody, { key: `ctx-${channelId ?? "none"}` });
    }
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

    const win = getActiveWindow();
    const ctxActive = isContextActive(getCurrentChannelMemId());
    const hasContent = win.content.name != null && !ctxActive;

    // The header grows to TWO rows for the second-row strip: the attach filename bar
    // (when the user picked "Attach to message") OVERRIDES the viewer controls strip;
    // otherwise the active viewer's controls show when it has any. An empty/loading/
    // errored body — and the context tab (member list / profile) — has no controls row.
    const showAttachBar = isAttachBarOpen() && hasContent;
    const showViewerRow = !showAttachBar && !ctxActive && hasViewerControls();
    const twoRow = showAttachBar || showViewerRow;

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
                        // The tab strip is ALWAYS rendered (empty, one, or many). Each tab
                        // carries its own icon/name/⋯/✕ in place. There is no dock-close
                        // affordance — the dock is always visible.
                        React.createElement(DockTabs, null)
                    )
                ),
                // SECOND ROW: the attach filename bar (when open) OR the active
                // viewer's controls strip. The attach bar overrides the controls.
                showAttachBar
                    ? attachToolbar()
                    : showViewerRow
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
