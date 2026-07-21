/*
 * The four idle / system body states: loading, error, unsupported, empty.
 *
 * These are the bodies the dock shows when there is no live viewer content to
 * render. DockPanel's body dispatcher falls here whenever the active
 * window has no viewer for its content type: a loading file → <LoadingBody/>, a
 * resolved-but-unviewable file → renderUnsupportedBody (download / open-in-window),
 * an errored file → renderErrorBody (humanized + retry), and an empty dock →
 * renderEmptyBody.
 *
 * All four share the same centred glyph/title rhythm (.dockview-unsupported layout)
 * so the dock reads consistently across states.
 */

import { React } from "@webpack/common";

import { retryActiveLoad } from "../engine/load";
import { getActiveWindow } from "../engine/window";
import { downloadUrl, extOf, openUrlInVesktopWindow } from "../external/openExternal";
import { STRINGS } from "../strings";

/** Map a raw error string to a humane title/sub. HTTP status codes lead; a
 *  fetch reject (offline / DNS / CORS, a TypeError) and the "no source" case get
 *  their own copy; everything else falls back to the raw text. */
/** A sentinel the artifact iframe passes when it fetched fine but never rendered, so
 *  the error card reads "didn't render" rather than the generic "couldn't load" copy. */
export const ARTIFACT_RENDER_FAILURE = "dockview:artifact-render-failure";

export function humanizeError(raw: string): { title: string; sub: string } {
    const E = STRINGS.error;
    if (raw === ARTIFACT_RENDER_FAILURE) return E.artifact;
    // A decoder the user turned OFF on the Performance page (DecoderDisabledError, whose
    // message is "<label> viewer is disabled in DockView settings (Performance).") reads
    // as a deliberate NOTICE, not a load failure. Pull the label back out for the title.
    const disabled = /^(.+?) viewer is disabled in DockView settings \(Performance\)\.$/.exec(raw);
    if (disabled) {
        return { title: STRINGS.decoderDisabled.title(disabled[1]), sub: STRINGS.decoderDisabled.sub };
    }
    const status = /^(\d{3})\b/.exec(raw);
    if (status) {
        const code = status[1];
        if (code === "404" || code === "403" || code === "410") return E.gone;
        if (code === "401") return E.forbidden;
        if (code.startsWith("5")) return E.server;
        return { title: E.http.title, sub: E.http.sub(code) };
    }
    if (/failed to fetch|networkerror|load failed/i.test(raw)) return E.offline;
    if (/^no\b.*source/i.test(raw)) return E.noSource;
    return { title: E.generic.title, sub: E.generic.sub(raw) };
}

/** Error fallback: a centered card with Retry / Open-in-browser / Download. Retry
 *  re-fetches the same url bypassing the cache; the other two embed/download the
 *  url. Only shown with a url to act on (inline-html artifacts have none, and they
 *  don't take the fetch path anyway). */
export function renderErrorBody(raw: string) {
    const win = getActiveWindow();
    const { title, sub } = humanizeError(raw);
    const url = win.content.url;
    const name = win.content.name || "file";
    const actions: any[] = [];
    if (url) {
        actions.push(React.createElement(
            "button",
            {
                key: "retry",
                type: "button",
                className: "dockview-unsupported-btn dockview-unsupported-btn-primary",
                onClick: () => retryActiveLoad()
            },
            STRINGS.actions.retry
        ));
        actions.push(React.createElement(
            "button",
            {
                key: "open",
                type: "button",
                className: "dockview-unsupported-btn",
                // "Open in browser" = an in-app Vesktop window (unified path). The
                // file failed to load so there's no in-memory content; embed its url.
                onClick: () => { if (url) openUrlInVesktopWindow(url, name); }
            },
            STRINGS.actions.openInNewWindow
        ));
        actions.push(React.createElement(
            "button",
            {
                key: "dl",
                type: "button",
                className: "dockview-unsupported-btn",
                onClick: () => downloadUrl(url, name)
            },
            STRINGS.actions.download
        ));
    }
    return React.createElement(
        "div",
        { className: "dockview-unsupported dockview-error-card", key: win.content.seq },
        React.createElement(
            "svg",
            { className: "dockview-unsupported-icon dockview-error-icon", width: 48, height: 48, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", {
                fill: "currentColor",
                d: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 5h2v7h-2V7Zm0 9h2v2h-2v-2Z"
            })
        ),
        React.createElement("div", { className: "dockview-unsupported-title" }, title),
        React.createElement("div", { className: "dockview-unsupported-sub" }, sub),
        actions.length
            ? React.createElement("div", { className: "dockview-unsupported-actions" }, ...actions)
            : null
    );
}

/** Unsupported-format fallback: a clean centered card for a file we can't preview,
 *  with Download + Open-in-browser actions (no raw-byte iframe dump). Reached for a
 *  binary "unknown" file, or any content type with no registered viewer. */
export function renderUnsupportedBody() {
    const win = getActiveWindow();
    const url = win.content.url;
    const name = win.content.name || "file";
    const ext = extOf(name) || extOf(url);
    return React.createElement(
        "div",
        { className: "dockview-unsupported", key: win.content.seq },
        React.createElement(
            "svg",
            { className: "dockview-unsupported-icon", width: 48, height: 48, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", {
                fill: "currentColor",
                d: "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-7-7Zm0 2.5L17.5 9H14a1 1 0 0 1-1-1V4.5ZM8 13h8v1.5H8V13Zm0 3.5h8V18H8v-1.5Z"
            })
        ),
        React.createElement("div", { className: "dockview-unsupported-title" }, STRINGS.unsupported.title),
        React.createElement(
            "div",
            { className: "dockview-unsupported-sub" },
            STRINGS.unsupported.sub(ext)
        ),
        url
            ? React.createElement(
                "div",
                { className: "dockview-unsupported-actions" },
                React.createElement(
                    "button",
                    {
                        type: "button",
                        className: "dockview-unsupported-btn dockview-unsupported-btn-primary",
                        onClick: () => downloadUrl(url, name)
                    },
                    STRINGS.actions.download
                ),
                React.createElement(
                    "button",
                    {
                        type: "button",
                        className: "dockview-unsupported-btn",
                        onClick: () => { if (url) openUrlInVesktopWindow(url, name); }
                    },
                    STRINGS.actions.openInNewWindow
                )
            )
            : null
    );
}

/** Loading state — a spinner glyph + one title line, no actions. Visibility is
 *  DELAYED ~150ms so a fast cache hit or quick fetch never flashes a spinner; only
 *  a genuinely slow load shows it. The title is content.loadingLabel when a viewer
 *  is spinning up a heavy library (set via engine/lazyLib withLibLoading, e.g.
 *  "Loading HEIC decoder…"), else the generic "Loading…". */
export function LoadingBody() {
    const { useState, useEffect } = React;
    const [show, setShow] = useState(false);
    useEffect(() => {
        const t = setTimeout(() => setShow(true), 150);
        return () => clearTimeout(t);
    }, []);
    if (!show) {
        // Hold an empty body for the first ~150ms (no flicker on fast loads).
        return React.createElement("div", { className: "dockview-status" });
    }
    const label = getActiveWindow().content.loadingLabel || STRINGS.loading.title;
    return React.createElement(
        "div",
        { className: "dockview-loading" },
        React.createElement("div", {
            className: "dockview-loading-spinner",
            "aria-hidden": true
        }),
        React.createElement(
            "div",
            { className: "dockview-loading-title", role: "status", "aria-live": "polite" },
            label
        )
    );
}

/** Empty-dock state: a centred muted glyph + one restrained line of guidance. The
 *  body the dock shows when it is open with no file loaded. */
export function renderEmptyBody() {
    return React.createElement(
        "div",
        { className: "dockview-empty" },
        React.createElement(
            "svg",
            { className: "dockview-empty-icon", width: 48, height: 48, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("path", {
                fill: "currentColor",
                d: "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-7-7Zm0 2.5L17.5 9H14a1 1 0 0 1-1-1V4.5ZM8 13h8v1.5H8V13Zm0 3.5h8V18H8v-1.5Z"
            })
        ),
        React.createElement("div", { className: "dockview-empty-text" }, STRINGS.empty.text)
    );
}
