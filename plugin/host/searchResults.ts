/*
 * Discord native SearchResults relocation.
 *
 * Discord continues to own the editor, query/filter stores and result component. We only
 * remove that exact element from Channel.renderSidebar() and mount it in DockView. Search
 * is a SERVER-scoped singleton: changing text channels in the same guild keeps one tab and
 * one native result tree. Its selected state deliberately lives outside contextTab so
 * selecting a file/Channel info can hide Search without destroying the native query.
 */

import { getContextView, type ContextView } from "../engine/contextTab";
import { requestRender } from "../engine/forceRender";
import { hostActions } from "../engine/hostBridge";
import { getCurrentChannelMemId } from "../engine/channelMemory";
import { getActiveWindow } from "../engine/window";
import { selectThreadPortal } from "../viewers/thread/threadPortal";
import { captureProviderStack, getProviderStack } from "./slotComponents";
import { getChannelById, getCurrentChannelId } from "./channel";
import { findPageInnerForHost, selectDockHost } from "./hostSelection";
import {
    isSearchSurfaceActive as isScopeSearchSurfaceActive,
    SearchSurfaceRegistry,
    slateSearchEditorQuery,
    type SearchProviderEntry,
    type SearchSurfaceEntry
} from "./searchResultsRegistry";

export type SearchEntry = SearchSurfaceEntry;

export type DockContextView = ContextView | "search";

const searchRegistry = new SearchSurfaceRegistry();
const searchReopenEntries = new Map<string, SearchEntry>();
let searchReopenListenerInstalled = false;
const queuedScopes = new Set<string>();
const queuedRefreshScopes = new Set<string>();

/** Bound for the native reset fallback. The resident SearchResults tree stays mounted;
 *  this delay only confirms that Discord actually cleared its Slate editor before the
 *  fixed tab is hidden. */
const SEARCH_CLOSE_FALLBACK_MS = 1000;

function scopeForChannel(channelId: string | null): string | null {
    const guildId = getChannelById(channelId)?.guild_id;
    return guildId ? `guild:${String(guildId)}` : null;
}

function scopeForObject(channel: any): string | null {
    return channel?.guild_id ? `guild:${String(channel.guild_id)}` : null;
}

function providerStackSnapshot(): readonly SearchProviderEntry[] | null {
    // Search is captured from a live channel view, so its main chat ancestry is available.
    // Prime it before the first resident mount; adding provider wrapper types later would
    // remount Discord's SearchResults and discard its local state/scroll.
    try { captureProviderStack(); } catch { /* bare native result remains the fallback */ }
    const stack = getProviderStack();
    return stack?.length ? stack.map(provider => ({ type: provider.type, value: provider.value })) : null;
}

function currentChannelId(): string | null {
    return getCurrentChannelMemId() ?? getCurrentChannelId();
}

function nativeSearchEditor(): HTMLElement | null {
    const selector = ".dockview-unified-header [role='combobox'][data-slate-editor='true']";
    // Channel transitions can briefly keep two connected header trees. Resolve the
    // editor from the same active page tree as DockView's live host so Enter never binds
    // to or reads a cached channel instance that merely appears first in document order.
    const pageInner = findPageInnerForHost(selectDockHost());
    return pageInner?.querySelector<HTMLElement>(selector)
        ?? document.querySelector<HTMLElement>(selector);
}

function nativeSearchQueryText(): string | null {
    const editor = nativeSearchEditor();
    if (!editor) return null;
    // Discord's native search editor is a Slate editor: only its semantic slate strings
    // are a real query. A localized placeholder (data-slate-placeholder) must never be
    // read as a query via translated plain-text equality — the placeholder text and the
    // editor label differ per locale, which misread it as a query.
    return slateSearchEditorQuery(
        editor.querySelector("[data-slate-placeholder]") != null,
        Array.from(editor.querySelectorAll<HTMLElement>("[data-slate-string='true']"))
            .map(node => node.textContent)
    );
}

function isStillOnSourceChannel(sourceChannelId: string): boolean {
    const memoryChannelId = getCurrentChannelMemId();
    const selectedChannelId = getCurrentChannelId();
    return (memoryChannelId == null || memoryChannelId === sourceChannelId)
        && (selectedChannelId == null || selectedChannelId === sourceChannelId);
}

function restoreUnderlyingThreadPortal(channelId: string | null): void {
    const active = getActiveWindow();
    selectThreadPortal(
        getContextView(channelId) == null && active.content.type === "thread"
            ? active.content.threadChannelId
            : null
    );
}

function hideSearchSurface(scopeId: string, channelId: string | null): void {
    if (!searchRegistry.hide(scopeId)) return;
    try { restoreUnderlyingThreadPortal(channelId); }
    finally { requestRender(); }
}

function queueOpen(scopeId: string): void {
    if (queuedScopes.has(scopeId)) return;
    queuedScopes.add(scopeId);
    queueMicrotask(() => {
        queuedScopes.delete(scopeId);
        if (!searchRegistry.has(scopeId)) return;
        searchRegistry.activate(scopeId);
        selectThreadPortal(null);
        hostActions().revealDock();
        requestRender();
    });
}

function queueRefresh(scopeId: string): void {
    if (queuedRefreshScopes.has(scopeId)) return;
    queuedRefreshScopes.add(scopeId);
    queueMicrotask(() => {
        queuedRefreshScopes.delete(scopeId);
        if (searchRegistry.has(scopeId)) requestRender();
    });
}

/** A non-SEARCH render can be the old owner unmounting during a channel transition. Delay
 * hiding until the transition settles, and only the latest owner may hide the entry. */
function queueNativeClose(scopeId: string, sourceChannelId: string): void {
    const token = searchRegistry.beginClose(scopeId);
    if (!token) return;
    queueMicrotask(() => {
        if (!searchRegistry.isCurrentClose(scopeId, token)) return;
        const current = searchRegistry.get(scopeId);
        if (!current || current.sourceChannelId !== sourceChannelId) return;
        const selectedChannelId = currentChannelId();
        // Leaving the owner channel is not a native Search close. The entry is a guild
        // singleton and must remain resident for an A→B→A return.
        if (!isStillOnSourceChannel(sourceChannelId)
            || selectedChannelId !== sourceChannelId
            || scopeForChannel(selectedChannelId) !== scopeId) return;
        if (searchRegistry.isCurrentClose(scopeId, token)
            && searchRegistry.hideIfSource(scopeId, sourceChannelId)) {
            restoreUnderlyingThreadPortal(selectedChannelId);
            requestRender();
        }
    });
}

/** Patch seam around Channel.renderSidebar(). Non-guild-text surfaces are untouched. */
export function captureNativeSearchResults(sidebar: any, channelView: any): any {
    const channel = channelView?.props?.channel;
    const channelId = typeof channel?.id === "string" ? channel.id : null;
    const scopeId = scopeForObject(channel);
    if (!channelId || !scopeId || channel.type !== 0) return sidebar;

    const isSearch = channelView?.props?.section === "SEARCH";
    if (isSearch) {
        if (sidebar == null) return null;
        const searchQuery = nativeSearchQueryText();
        const { firstOpen, evictedScopeIds } = searchRegistry.capture(
            scopeId,
            channelId,
            sidebar,
            providerStackSnapshot()
        );
        for (const evictedScopeId of evictedScopeIds) clearSearchReopenListener(evictedScopeId);
        if (firstOpen || (!searchRegistry.isVisible(scopeId) && searchQuery != null)) queueOpen(scopeId);
        else queueRefresh(scopeId);
        return null;
    }

    const existing = searchRegistry.get(scopeId);
    // Only the channel that produced the search owns Discord's native close transition.
    // Ordinary renders from another channel in the guild must not discard the singleton.
    // Selecting Channel info/file makes Discord briefly render a non-SEARCH sidebar even
    // though its native query remains live. Only an actually cleared editor owns the
    // right to retire the resident Search surface (the authoritative close transition).
    if (existing?.sourceChannelId === channelId) {
        if (nativeSearchQueryText() == null) queueNativeClose(scopeId, channelId);
    }
    return sidebar;
}

export function getNativeSearchScopeId(channelId: string | null): string | null {
    return scopeForChannel(channelId);
}

export function getNativeSearchResults(channelId: string | null): any | null {
    const scopeId = scopeForChannel(channelId);
    return searchRegistry.get(scopeId)?.element ?? null;
}

export function getNativeSearchEntries(): readonly SearchEntry[] {
    return searchRegistry.all();
}

export function getNativeSearchRenderRevision(): number {
    return searchRegistry.getRenderRevision();
}

export function hasNativeSearchResults(channelId: string | null): boolean {
    const scopeId = scopeForChannel(channelId);
    return searchRegistry.isVisible(scopeId);
}

export function isNativeSearchActive(channelId: string | null): boolean {
    const scopeId = scopeForChannel(channelId);
    return searchRegistry.isActive(scopeId);
}

/** THE active-state source for the Search tab and its resident body. The fixed Search
 *  tab passes the current channel's scope; the resident body passes each entry's scope.
 *  Both surfaces must derive their active flag from this one predicate. */
export function isSearchSurfaceActive(channelId: string | null, scopeId: string | null): boolean {
    return isScopeSearchSurfaceActive(searchRegistry, getNativeSearchScopeId(channelId), scopeId);
}

/** The DOM marker is checked by embed.ts in addition to this registry ownership check. */
export function isNativeSearchSurfaceActive(scopeId: string | null, channelId: string | null): boolean {
    return scopeId != null && scopeId === scopeForChannel(channelId) && isNativeSearchActive(channelId);
}

/** Effective Dock surface. Search masks, but never overwrites, the channel's remembered
 * fixed/file selection. Leaving Search therefore returns to exactly the previous view. */
export function getDockContextView(channelId: string | null): DockContextView | null {
    return isNativeSearchActive(channelId) ? "search" : getContextView(channelId);
}

export function activateNativeSearchResults(channelId: string | null): void {
    const scopeId = scopeForChannel(channelId);
    if (!searchRegistry.activate(scopeId)) return;
    selectThreadPortal(null);
    hostActions().revealDock();
    requestRender();
}

/** Host bridge action used by any explicit non-Search Dock selection. */
export function deactivateNativeSearchView(): void {
    const scopeId = scopeForChannel(getCurrentChannelMemId());
    if (!searchRegistry.deactivate(scopeId)) return;
    requestRender();
}

export function isCurrentNativeSearchActive(): boolean {
    return isNativeSearchActive(getCurrentChannelMemId());
}

export function activateCurrentNativeSearchView(): void {
    activateNativeSearchResults(getCurrentChannelMemId());
}

function nativeSearchControlButton(): HTMLElement | null {
    const editor = nativeSearchEditor();
    const bar = editor?.parentElement;
    if (!bar) return null;
    for (const child of Array.from(bar.children)) {
        if (child !== editor && child instanceof HTMLElement && child.getAttribute("role") === "button") return child;
    }
    return null;
}

function clearSearchReopenListener(scopeId: string, entry?: SearchEntry): void {
    const armed = searchReopenEntries.get(scopeId);
    if (!armed || (entry != null && armed !== entry)) return;
    searchReopenEntries.delete(scopeId);
    if (searchReopenEntries.size === 0 && searchReopenListenerInstalled) {
        document.removeEventListener("keydown", onSearchEditorKeyDown, true);
        searchReopenListenerInstalled = false;
    }
}

function onSearchEditorKeyDown(event: Event): void {
    if (!(event instanceof KeyboardEvent) || event.key !== "Enter") return;
    const editor = nativeSearchEditor();
    if (!editor || !(event.target instanceof Node) || !editor.contains(event.target)) return;
    const scopeId = scopeForChannel(currentChannelId());
    const entry = scopeId ? searchReopenEntries.get(scopeId) : null;
    if (!scopeId || !entry) return;
    queueMicrotask(() => {
        if (searchRegistry.get(scopeId) !== entry || nativeSearchQueryText() == null) return;
        searchRegistry.activate(scopeId);
        selectThreadPortal(null);
        hostActions().revealDock();
        requestRender();
        clearSearchReopenListener(scopeId, entry);
    });
}

function armSearchReopenOnEnter(scopeId: string, entry: SearchEntry): void {
    clearSearchReopenListener(scopeId);
    searchReopenEntries.set(scopeId, entry);
    if (!searchReopenListenerInstalled) {
        document.addEventListener("keydown", onSearchEditorKeyDown, true);
        searchReopenListenerInstalled = true;
    }
    while (searchReopenEntries.size > 1) {
        const oldest = searchReopenEntries.keys().next().value as string | undefined;
        if (oldest == null) break;
        clearSearchReopenListener(oldest);
    }
}

/** Hide the fixed Search tab through Discord's original reset control. The native
 * SearchResults tree remains mounted but inert, preserving its stores and scroll. A later
 * Enter with real Slate text reactivates that same tree before Discord handles the query. */
export function closeNativeSearchResults(channelId: string | null): void {
    const scopeId = scopeForChannel(channelId);
    if (!scopeId || !searchRegistry.isVisible(scopeId)) return;
    const closeButton = nativeSearchControlButton();
    // Do not mutate our resident state unless Discord's authoritative close control is
    // available. A missing control must leave a working Search tab, not a poisoned scope.
    if (!closeButton) return;
    const entryAtClose = searchRegistry.get(scopeId)!;
    armSearchReopenOnEnter(scopeId, entryAtClose);
    closeButton.click();
    const hideIfCleared = () => {
        if (searchRegistry.get(scopeId) !== entryAtClose || nativeSearchQueryText() != null) return;
        hideSearchSurface(scopeId, channelId);
    };
    queueMicrotask(() => {
        hideIfCleared();
    });
    setTimeout(() => {
        hideIfCleared();
        if (nativeSearchQueryText() != null) clearSearchReopenListener(scopeId, entryAtClose);
    }, SEARCH_CLOSE_FALLBACK_MS);
}

export function getNativeSearchQuery(channelId: string | null): string | null {
    if (!hasNativeSearchResults(channelId)) return null;
    return nativeSearchQueryText();
}

export function clearNativeSearchResults(): void {
    const hadEntries = searchRegistry.all().length > 0;
    searchRegistry.clear();
    for (const scopeId of [...searchReopenEntries.keys()]) clearSearchReopenListener(scopeId);
    queuedScopes.clear();
    queuedRefreshScopes.clear();
    if (hadEntries) requestRender();
}
