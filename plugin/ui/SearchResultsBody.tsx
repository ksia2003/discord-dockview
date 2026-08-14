/* Discord's exact SearchResults surface, relocated from Channel.renderSidebar(). */

import { React } from "@vencord/types/webpack/common";

import { getCurrentChannelMemId } from "../engine/channelMemory";
import { subscribeRender } from "../engine/forceRender";
import {
    getNativeSearchEntries,
    getNativeSearchRenderRevision,
    isSearchSurfaceActive,
    type SearchEntry
} from "../host/searchResults";

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
    const { useCallback, useLayoutEffect, useMemo, useRef, useState } = React;
    const [, bump] = useState(0);
    const channelId = getCurrentChannelMemId();
    const revision = getNativeSearchRenderRevision();
    const rendered = useRef({ channelId, revision });
    const rerender = useCallback(() => {
        const next = { channelId: getCurrentChannelMemId(), revision: getNativeSearchRenderRevision() };
        if (next.channelId === rendered.current.channelId && next.revision === rendered.current.revision) return;
        rendered.current = next;
        bump((n: number) => n + 1);
    }, []);
    // The Search tab repaints itself on the engine repaint signal (UnifiedHeaderTabs
    // subscribes). The resident body listens to that SAME signal instead of only through
    // the panel's single renderer slot, but skips state updates unless Search or the active
    // channel actually changed. The subscription attaches in the commit-
    // synchronous layout phase on purpose: the first-open activation arrives in a
    // queueMicrotask right after the capture render, before any passive effect runs.
    useLayoutEffect(() => subscribeRender(rerender), [rerender]);
    // Advance the acknowledged snapshot only after this render commits. An interrupted
    // concurrent render must not make a later engine signal look already painted.
    useLayoutEffect(() => {
        rendered.current = { channelId, revision };
    }, [channelId, revision]);
    const entries = getNativeSearchEntries();
    // Every entry/visibility/provider mutation advances revision, so returning this exact
    // tree for unrelated Dock repaints lets React skip reconciling native SearchResults.
    return useMemo(() => {
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
    }, [channelId, revision]);
}
