/*
 * URL-level external actions used by the dock chrome: download a file, open a url
 * in a real in-app Vesktop window, open a link in the external browser, and the
 * url helpers (absolute resolution, extension sniff) those share.
 *
 * This is the URL-only slice the state cards (error / unsupported) need now: they
 * have NO in-memory content, only a working url, so they download it or embed it
 * in a full-bleed in-app window. The richer per-content-type "open in browser"
 * popout (vesktopWindowHtml — building a markdown/code/<embed> shell from the live
 * content + edit buffer) rides the render pipelines that land in P4/P5; it lives
 * in external/vesktopWindow.ts then. Keeping these primitives split lets P2 wire
 * the state-card actions without dragging in the unported render code.
 */

/** Resolve a url to its absolute form against the host page (for download / embed). */
export function absUrl(href: string): string {
    try {
        return new URL(href, location.href).href;
    } catch {
        return href;
    }
}

/** The file extension (no dot, lowercased) of a name or url, or null. */
export function extOf(s: string | null | undefined): string | null {
    if (!s) return null;
    let path = s;
    try {
        path = new URL(s, location.href).pathname;
    } catch {
        /* keep raw */
    }
    const m = /\.([a-z0-9]+)(?:$|\?|#)/i.exec(path.split("/").pop() || "");
    return m ? m[1].toLowerCase() : null;
}

/** Clipboard fallback for environments where navigator.clipboard is blocked. */
function fallbackCopy(text: string, done: () => void): void {
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        done();
    } catch {
        /* ignore */
    }
}

/** Copy text to the clipboard (async API first, textarea fallback). */
export function copyText(text: string | null | undefined): void {
    if (!text) return;
    try {
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(() => fallbackCopy(text, () => { }));
            return;
        }
    } catch {
        /* fall through */
    }
    fallbackCopy(text, () => { });
}

/** Trigger a browser download of `url` (best-effort filename = `name`). */
export function downloadUrl(url: string | null | undefined, name?: string | null): void {
    if (!url) return;
    const a = document.createElement("a");
    a.href = absUrl(url);
    a.download = name || "";
    a.rel = "noopener";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    a.remove();
}

// Minimal dark page chrome shared by the in-app "open in browser" shells so the
// popped-out window reads like the dock (dark bg, no margins, fills the viewport).
const VESKTOP_WINDOW_CSS =
    "html,body{margin:0;padding:0;height:100%;background:#1e1f22;color:#dbdee1;"
    + "font-family:'gg sans','Noto Sans',Helvetica,Arial,sans-serif;}";

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Open `html` in a real, IN-APP Vesktop window. The empty-window + document.write
 *  path rides Chromium's always-allowed about:blank window.open rule in the Vesktop
 *  fork's setWindowOpenHandler, so it opens an in-app BrowserWindow RELIABLY,
 *  independent of the user's "Open Links in app" setting. Best-effort: a null
 *  return (popup blocked) is a silent no-op. */
export function openVesktopWindow(html: string, name: string): void {
    const w = window.open("", name, "width=900,height=700,menubar=no,toolbar=no");
    if (!w) return;
    try {
        w.document.open();
        w.document.write(html);
        w.document.close();
        w.document.title = name;
    } catch {
        /* the window opened but writing failed — leave it (it's still in-app) */
    }
}

/** Open an arbitrary file URL in a real in-app Vesktop window. Used by the state
 *  cards (error / unsupported), where there is NO in-memory content but there is a
 *  working url. The url is embedded in a full-bleed <iframe>; the browser falls
 *  back to a download for non-renderable types, exactly like opening the link. */
export function openUrlInVesktopWindow(url: string, name: string): void {
    const abs = absUrl(url);
    const body = `<iframe src="${escapeHtml(abs)}" `
        + `style="position:fixed;inset:0;width:100%;height:100%;border:none;background:#1e1f22;"></iframe>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${VESKTOP_WINDOW_CSS}</style></head><body>${body}</body></html>`;
    openVesktopWindow(html, name);
}

/** Open a web/mailto link in the external OS browser (markdown/artifact sandbox
 *  link clicks postMessage up to us; we route them here instead of navigating
 *  inside the sandbox). Only http(s)/mailto pass — no javascript:/file:/etc. */
export function openExternalLink(href: string): void {
    if (!href) return;
    let url: string;
    try {
        url = new URL(href, location.href).href;
    } catch {
        url = href;
    }
    if (!/^(https?:|mailto:)/i.test(url)) return;
    try {
        const native = (window as any).VencordNative?.native?.openExternal;
        if (typeof native === "function") {
            native(url);
            return;
        }
    } catch {
        /* fall through to window.open */
    }
    try {
        window.open(url, "_blank", "noopener,noreferrer");
    } catch {
        /* ignore */
    }
}
