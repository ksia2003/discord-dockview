/*
 * The WEB body — a PLACEHOLDER for a web page opened as a dock tab.
 *
 * A web page is just another tab (channel-scoped, accumulates, pin = global, dedup,
 * session-only) — it rides the exact same tab model as a file. This body is the
 * stand-in until the real in-dock page render (an isolated Electron <webview>) is
 * wired on the main side: it shows a neutral card with the page's host + favicon so
 * the tab is identifiable and participates in the dock like any other viewer.
 *
 * No module-top React.createElement / no module-top webpack member access — the React
 * proxy is only invoked inside the component body below (the lazy-init trap).
 */

import { React } from "@webpack/common";

import { getActiveWindow } from "../../engine/window";
import { STRINGS } from "../../strings";

/** The host of a url (e.g. "example.com"), or the raw string if it won't parse. */
function hostOf(url: string): string {
    try {
        return new URL(url, location.href).host || url;
    } catch {
        return url;
    }
}

/** Google's favicon service for a host — a best-effort icon; onError hides it so a
 *  missing icon leaves a clean card rather than a broken-image glyph. */
function faviconUrl(host: string): string {
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

/** The placeholder web body. Keyed on content.seq by the dispatcher, so opening a
 *  different page remounts it and the local `iconFailed` flag resets. */
export function WebBody() {
    const { useState } = React;
    const [iconFailed, setIconFailed] = useState(false);

    const win = getActiveWindow();
    const url = win.content.url || "";
    const host = hostOf(url);

    return React.createElement(
        "div",
        { className: "dockview-web-wrap" },
        React.createElement(
            "div",
            { className: "dockview-web-card" },
            iconFailed
                ? null
                : React.createElement("img", {
                    className: "dockview-web-favicon",
                    src: faviconUrl(host),
                    alt: "",
                    onError: () => setIconFailed(true)
                }),
            React.createElement("div", { className: "dockview-web-title" }, STRINGS.web.title),
            React.createElement("div", { className: "dockview-web-sub" }, STRINGS.web.sub(host))
        )
    );
}
