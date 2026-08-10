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
 *  - Width is deliberately absent from this component. F9 applies the ordered presets;
 *    there is no edge-drag state competing with those settings.
 *
 * NO module-top React.createElement. The CLS map below is plain findCssClasses
 * lookups returning objects (no elements), safe at module eval per panel.tsx.
 */

import { findCssClasses } from "@vencord/types/webpack";
import { React } from "@vencord/types/webpack/common";

import { hasFileActionSurface } from "../engine/dockEligibility";
import { dvFetch } from "../engine/fetch";
import { requestRender, isRenderer, setRenderer } from "../engine/forceRender";
import { consumePendingScroll } from "../engine/viewState";
import { getActiveWindow } from "../engine/window";
import { getCurrentChannelMemId } from "../engine/channelMemory";
import { settlePendingOpens } from "../engine/openRollback";
import { ContextTabBody } from "./ContextTabBody";
import { SearchResultsBody } from "./SearchResultsBody";
import { getDockContextView } from "../host/searchResults";
import { VoiceChatBody } from "../viewers/voice/VoiceChatBody";
import { getViewer } from "../viewers/registry";
import type { ViewerContext } from "../engine/types";
import { attachToolbar, isAttachBarOpen } from "../edit/attach";
import { DockTabs } from "./DockTabs";
import { FindBar } from "./FindBar";
import { HeaderControls, hasViewerControls } from "./HeaderControls";
import { DockMoreButton } from "./DockMoreMenu";
import { LoadingBody, renderEmptyBody, renderErrorBody, renderUnsupportedBody } from "./StateCards";
import { holdPendingMediaOpen, isPendingMediaOpen } from "../viewers/media/mediaError";

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
    if (getDockContextView(getCurrentChannelMemId()) != null) return null;
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
    card: wrapMod.container || "container__01ae2",
    headerSection: `${headMod.container || "container__9293f"} ${headMod.themed || "themed__9293f"}`,
    upper: headMod.upperContainer || "upperContainer__9293f",
    headerChildren: headMod.children || "children__9293f",
    titleWrapper: headMod.titleWrapper || "titleWrapper__9293f",
    title: `${defaultColor} ${textMd} ${headMod.title || "title__9293f"}`
};

/** The body dispatcher. SearchResultsBody is a keyed resident sibling for every opened
 *  guild scope; only its active surface is visible. The ordinary dock body remains beside
 *  that resident layer so switching Search → file/context never unmounts native results. */
function renderBody() {
    const channelId = getCurrentChannelMemId();
    const contextView = getDockContextView(channelId);
    const residentSearch = React.createElement(SearchResultsBody, { key: "search-resident" });
    let body: any = null;
    if (contextView === "voice-chat") {
        body = React.createElement(VoiceChatBody, { key: `voice-chat-${channelId ?? "none"}` });
    } else if (contextView === "channel") {
        body = React.createElement(ContextTabBody, { key: `ctx-${channelId ?? "none"}` });
    } else if (contextView !== "search") {
        const win = getActiveWindow();
        if (win.content.name == null) body = renderEmptyBody();
        else if (win.content.error != null) body = win.openRollback ? null : renderErrorBody(win.content.error);
        else if (win.content.loading && !isPendingMediaOpen(win)) body = React.createElement(LoadingBody, null);
        else {
            const viewer = getViewer(win.content.type);
            // No viewer for the type yet → shared unsupported/download card.
            body = viewer ? React.createElement(viewer.Body, { key: win.content.seq }) : renderUnsupportedBody();
        }
    }
    return React.createElement(React.Fragment, null, residentSearch, body);
}

export function DockPanel() {
    const { useState, useCallback, useEffect, useLayoutEffect } = React;

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

    // After a cache RESTORE of a non-pdf file, re-apply the saved scroll once the
    // body DOM is committed. (A pdf body restores its OWN scroll after its lazy page
    // boxes exist, so a pdf viewer opts out via scrollerSelector / its own restore;
    // the generic consume here is a no-op when there's no pending scroll.)
    useEffect(() => {
        if (getActiveWindow().content.type !== "pdf") consumePendingScroll(getActiveWindow());
    });
    useLayoutEffect(() => {
        // switchToWindow may reconcile a ready cache entry over a still-provisional
        // media window. Re-apply the window-only pending state before settle scans it.
        const activeWindow = getActiveWindow();
        if (isPendingMediaOpen(activeWindow)) holdPendingMediaOpen(activeWindow);
        settlePendingOpens();
    });

    const win = getActiveWindow();
    const channelId = getCurrentChannelMemId();
    const contextView = getDockContextView(channelId);
    const ctxActive = contextView != null;
    const nativeRailContextActive = contextView === "channel" || contextView === "search";
    const hasContent = win.content.name != null && !ctxActive;

    // The header grows to TWO rows for the second-row strip: the attach filename bar
    // (when the user picked "Attach to message") OVERRIDES the viewer controls strip;
    // otherwise the active viewer's controls show when it has any. An empty/loading/
    // errored body — and the context tab (member list / profile) — has no controls row.
    const showAttachBar = isAttachBarOpen() && hasContent;
    const viewerHasControls = !ctxActive && hasViewerControls();
    const hasFileActions = !ctxActive && hasFileActionSurface(win.content.type) && win.content.name != null
        && !win.content.loading && !win.content.error;
    const showViewerRow = !showAttachBar && (viewerHasControls || hasFileActions);
    const twoRow = showAttachBar || showViewerRow;

    return React.createElement(
        "div",
        { className: `${CLS.wrapper} dockview-wrapper` },
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
                            viewerHasControls ? React.createElement(HeaderControls, null) : null,
                            hasFileActions ? React.createElement(DockMoreButton, null) : null
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
                                + (nativeRailContextActive ? " dockview-body--context" : "")
                        },
                        renderBody()
                    ),
                    renderFindBar()
                );
            })()
        )
    );
}
