/* Discord's exact SearchResults surface, relocated from Channel.renderSidebar(). */

import { React } from "@vencord/types/webpack/common";

import { getCurrentChannelMemId } from "../engine/channelMemory";
import { subscribeRender } from "../engine/forceRender";
import { getNativeSearchEntries, isSearchSurfaceActive, type SearchEntry } from "../host/searchResults";

let BoundaryClass: any = null;
function searchProviderBoundary(): any {
    if (BoundaryClass) return BoundaryClass;
    class SearchProviderBoundary extends (React.Component as any) {
        declare props: any;
        state = { failed: false };
        static getDerivedStateFromError() { return { failed: true }; }
        componentDidCatch() { /* bare native result remains the safe fallback */ }
        render() {
            return this.state.failed ? this.props.fallback : this.props.children;
        }
    }
    BoundaryClass = SearchProviderBoundary;
    return SearchProviderBoundary;
}

function withCapturedProviders(bare: any, stack: SearchEntry["providerStack"]): any {
    if (!stack?.length) return bare;
    let tree = bare;
    for (const provider of stack) {
        tree = React.createElement(provider.type, { value: provider.value }, tree);
    }
    return React.createElement(searchProviderBoundary(), { fallback: bare }, tree);
}

export function SearchResultsBody() {
    const { useCallback, useLayoutEffect, useState } = React;
    const [, bump] = useState(0);
    const rerender = useCallback(() => bump((n: number) => n + 1), []);
    // The Search tab repaints itself on the engine repaint signal (UnifiedHeaderTabs
    // subscribes). The resident body must repaint on that SAME signal instead of only
    // through the panel's single renderer slot, or its active marker can stay stale
    // while the tab already shows active. The subscription attaches in the commit-
    // synchronous layout phase on purpose: the first-open activation arrives in a
    // queueMicrotask right after the capture render, before any passive effect runs.
    useLayoutEffect(() => subscribeRender(rerender), [rerender]);
    const channelId = getCurrentChannelMemId();
    const entries = getNativeSearchEntries();
    if (!entries.length) return null;
    return React.createElement(
        React.Fragment,
        null,
        ...entries.map(entry => {
            const active = isSearchSurfaceActive(channelId, entry.scopeId);
            return React.createElement(
                "div",
                {
                    key: entry.scopeId,
                    className: "dockview-search-results-body"
                        + (active ? " dockview-search-results-body--active" : " dockview-search-results-body--inactive"),
                    "data-dockview-search-scope": entry.scopeId,
                    "data-dockview-search-active": active ? "true" : "false",
                    "aria-hidden": !active,
                    inert: !active
                },
                withCapturedProviders(entry.element, entry.providerStack)
            );
        })
    );
}
