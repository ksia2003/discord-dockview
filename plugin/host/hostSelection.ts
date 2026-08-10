/*
 * Dock host selection shared by the mount and layout modules.
 *
 * mount.ts owns the React root binding, while layout.ts is called by settings and
 * resize handlers that cannot import mount.ts without creating a cycle. Keep the
 * binding marker here so every DOM write chooses the same live host during Discord's
 * short-lived duplicate channel-view overlap.
 */

export const HOST_ID = "dockview-root";

let boundHost: HTMLElement | null = null;

/** Publish the host currently carrying DockView's live React root. */
export function setLiveHost(host: HTMLElement | null): void {
    boundHost = host;
}

function computedLayoutStyle(el: HTMLElement): CSSStyleDeclaration | null {
    try {
        const view = el.ownerDocument?.defaultView;
        const getStyle = view?.getComputedStyle?.bind(view) ?? globalThis.getComputedStyle;
        return typeof getStyle === "function" ? getStyle(el) : null;
    } catch {
        return null;
    }
}

function isHiddenLayoutElement(el: HTMLElement): boolean {
    if (el.hidden || el.style?.display === "none" || el.style?.visibility === "hidden") return true;
    const style = computedLayoutStyle(el);
    return style?.display === "none" || style?.visibility === "hidden";
}

/**
 * The host is intentionally display:none until DockView opens it, so its own layout
 * box cannot tell us whether Discord's owning channel-view is active. Walk only the
 * containing tree and ignore the host itself. This keeps F9 (host hidden, tree live)
 * distinct from a cached channel-view (an ancestor hidden by Discord).
 */
export function isDockHostTreeActive(host: HTMLElement | null): boolean {
    if (!host?.isConnected) return false;
    let parent = host.parentElement;
    let hops = 0;
    while (parent && hops++ < 100) {
        if (isHiddenLayoutElement(parent)) return false;
        parent = parent.parentElement;
    }
    return true;
}

function hasClassFragment(el: HTMLElement, fragment: string): boolean {
    const className = typeof el.className === "string" ? el.className : "";
    return className.split(/\s+/).some(name => name.includes(fragment));
}

function hasDirectChatChild(el: HTMLElement): boolean {
    return Array.from(el.children ?? []).some(child =>
        (typeof HTMLElement !== "undefined" && child instanceof HTMLElement)
            ? hasClassFragment(child, "chat_")
            : typeof (child as any)?.className === "string" && (child as any).className.includes("chat_")
    );
}

/** Resolve the page-inner that owns a particular host, without a document-wide query. */
export function findPageInnerForHost(host: HTMLElement | null): HTMLElement | null {
    if (!host?.isConnected) return null;
    let parent = host.parentElement;
    let hops = 0;
    while (parent && hops++ < 100) {
        if (hasClassFragment(parent, "dockview-page-inner") || hasDirectChatChild(parent)) return parent;
        parent = parent.parentElement;
    }
    return null;
}

/** Remove only DockView's host state; Discord-owned classes/styles remain untouched. */
export function clearDockHostState(host: HTMLElement | null): void {
    if (!host) return;
    host.classList?.remove(
        "dockview-open",
        "dockview-host--compact",
        "dockview-host--floating"
    );
    if (typeof host.style?.removeProperty === "function") {
        host.style.removeProperty("flex");
        host.style.removeProperty("width");
    } else if (host.style) {
        host.style.flex = "";
        host.style.width = "";
    }
}

/**
 * Pick the host for imperative DOM state and geometry writes.
 *
 * A connected live binding wins only while its containing channel-view tree is active.
 * Otherwise prefer an active connected placeholder over the first (possibly stale /
 * hidden) duplicate.
 */
export function selectDockHost(): HTMLElement | null {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(`#${HOST_ID}`));
    if (boundHost?.isConnected && isDockHostTreeActive(boundHost)) return boundHost;
    const active = nodes.find(isDockHostTreeActive);
    if (active) return active;
    // There may be no active tree during a transition. Preserve the live root if it is
    // still connected; otherwise keep the old document-order fallback for bootstrap.
    return boundHost?.isConnected ? boundHost : nodes.find(host => host.isConnected) ?? null;
}
