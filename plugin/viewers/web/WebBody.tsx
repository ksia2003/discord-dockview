/*
 * The WEB body — a real Electron <webview> that renders the page inside the dock.
 *
 * A web page is just another tab (channel-scoped, accumulates, pin = global, dedup,
 * session-only) — it rides the exact same tab model as a file. This body embeds the
 * page with a <webview> element in a session partition ISOLATED from Discord.
 *
 * SECURITY (required, not optional):
 *  - partition="persist:dockview-web" — a persistent session SEPARATE from Discord's,
 *    so the embedded site gets NO Discord cookies/session.
 *  - nodeintegration OFF, no custom preload, webpreferences pin contextIsolation on /
 *    nodeIntegration off. The main process ALSO strips node/preload from every guest in
 *    the will-attach-webview handler (defense-in-depth). The embedded site therefore has
 *    NO access to Node / Electron / Discord.
 *
 * The <webview>'s navigation state is published to a small per-window controller (like
 * ImageBody publishes imgController) so the WebHeaderControls toolbar can drive
 * canGoBack()/goBack()/reload()/getURL() and reflect the current url. A did-fail-load is
 * surfaced as an honest error card (not a blank frame).
 *
 * No module-top React.createElement / no module-top webpack member access — the React
 * proxy is only invoked inside the component body below (the lazy-init trap).
 */

import { React } from "@webpack/common";

import { getActiveWindow } from "../../engine/window";
import type { DockWindow } from "../../engine/types";
import { STRINGS } from "../../strings";

// The isolated session partition for embedded web pages. `persist:` prefix = a
// persistent partition (survives across tabs in-session); it is a DIFFERENT session
// from the Discord renderer's default one, so no Discord cookies leak into it.
export const WEB_PARTITION = "persist:dockview-web";

/** The live navigation controller a mounted <webview> publishes for its window, so the
 *  toolbar shares the exact same webview instance. */
export interface WebController {
    canGoBack(): boolean;
    goBack(): void;
    reload(): void;
    getURL(): string;
}

// Per-window controller + current-url, keyed by window id. A remounted body republishes;
// the toolbar reads these at click/render time (the body owns the source of truth).
const controllers = new Map<string, WebController>();
const currentUrls = new Map<string, string>();
// Subscribers bumped when a window's url changes, so the toolbar re-renders its readout.
const urlListeners = new Set<() => void>();

/** The controller for a window's live <webview>, or null if none is mounted. */
export function webController(win: DockWindow): WebController | null {
    return controllers.get(win.id) || null;
}

/** The last-known url of a window's <webview> (updated on navigation). */
export function webCurrentUrl(win: DockWindow): string {
    return currentUrls.get(win.id) ?? win.content.url ?? "";
}

/** Subscribe the toolbar to url changes; returns an unsubscribe. */
export function subscribeWebUrl(fn: () => void): () => void {
    urlListeners.add(fn);
    return () => urlListeners.delete(fn);
}

function notifyUrl(): void {
    for (const fn of urlListeners) {
        try { fn(); } catch { /* a dead subscriber must not break navigation */ }
    }
}

/** The host of a url (e.g. "example.com"), or the raw string if it won't parse. */
function hostOf(url: string): string {
    try {
        return new URL(url, location.href).host || url;
    } catch {
        return url;
    }
}

/** The web body — a real isolated <webview>. Keyed on content.seq by the dispatcher, so
 *  opening a different page remounts it (a fresh <webview> at the new src). */
export function WebBody() {
    const { useEffect, useRef, useState } = React;
    const win = getActiveWindow();
    const url = win.content.url || "";
    const winId = win.id;

    const ref = useRef<any>(null);
    // Load-failure state → an honest card instead of a blank frame. code/desc come off
    // the webview's did-fail-load event.
    const [failed, setFailed] = useState<{ code: number; desc: string } | null>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const publish = () => {
            controllers.set(winId, {
                canGoBack: () => { try { return el.canGoBack(); } catch { return false; } },
                goBack: () => { try { el.goBack(); } catch { /* not attached yet */ } },
                reload: () => { try { el.reload(); } catch { /* not attached yet */ } },
                getURL: () => { try { return el.getURL(); } catch { return url; } }
            });
        };

        const onNavigate = (e: any) => {
            // did-navigate / did-navigate-in-page carry the resolved url.
            if (e && typeof e.url === "string" && e.url) currentUrls.set(winId, e.url);
            else { try { currentUrls.set(winId, el.getURL()); } catch { /* keep prior */ } }
            notifyUrl();
        };
        const onFail = (e: any) => {
            // errorCode -3 = ERR_ABORTED (a superseded/redirected load) — not a real
            // failure; ignore it. isMainFrame guards sub-resource failures.
            if (e && (e.errorCode === -3 || e.isMainFrame === false)) return;
            setFailed({ code: e?.errorCode ?? 0, desc: e?.errorDescription || "" });
        };
        const onStartLoad = () => setFailed(null);

        el.addEventListener("dom-ready", publish);
        el.addEventListener("did-navigate", onNavigate);
        el.addEventListener("did-navigate-in-page", onNavigate);
        el.addEventListener("did-start-loading", onStartLoad);
        el.addEventListener("did-fail-load", onFail);
        publish();

        return () => {
            el.removeEventListener("dom-ready", publish);
            el.removeEventListener("did-navigate", onNavigate);
            el.removeEventListener("did-navigate-in-page", onNavigate);
            el.removeEventListener("did-start-loading", onStartLoad);
            el.removeEventListener("did-fail-load", onFail);
            if (controllers.get(winId)) controllers.delete(winId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [winId, url]);

    // React does not know the <webview> intrinsic, and its security attributes are
    // string/boolean HTML attributes — set them explicitly on the element.
    //
    // KEY on the window id, not the dispatcher's content.seq: two web tabs both sit at
    // seq 1 (each loaded once), so the shared-seq WebBody instance would otherwise reuse
    // the SAME <webview> node across a tab switch and keep the previous tab's live url.
    // Keying the element on winId makes React mount a fresh <webview> per window, so
    // switching tabs shows the right page.
    const webviewProps: Record<string, any> = {
        key: winId,
        ref,
        className: "dockview-web-frame",
        src: url,
        // ISOLATED session — a persistent partition SEPARATE from Discord's session, so
        // the site gets no Discord cookies.
        partition: WEB_PARTITION,
        // No node integration, context isolation on (also enforced main-side). No preload.
        // `nodeintegration` intentionally absent (defaults to off); we pin it via
        // webpreferences too so the intent is explicit.
        webpreferences: "contextIsolation=yes,nodeIntegration=no,sandbox=yes",
        // Let the guest ask for popups; the main process routes new windows to the OS
        // browser via the existing makeLinksOpenExternally / setWindowOpenHandler path.
        allowpopups: undefined
    };

    return React.createElement(
        "div",
        { className: "dockview-web-wrap" },
        failed
            ? React.createElement(
                "div",
                { className: "dockview-web-fail" },
                React.createElement("div", { className: "dockview-web-fail-title" }, STRINGS.web.failTitle),
                React.createElement("div", { className: "dockview-web-fail-sub" }, STRINGS.web.sub(hostOf(url)))
            )
            : null,
        React.createElement("webview", webviewProps)
    );
}
