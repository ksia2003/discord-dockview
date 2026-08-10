/*
 * Pure lifecycle registry for Discord's native SearchResults elements.
 *
 * The host module owns Discord integration and close semantics. This small registry owns
 * only the resident element identity, guild scope, provider snapshot, active flag, and
 * the Slate editor query judgment so those transitions can be exercised without booting
 * Discord's webpack runtime.
 */

export type SearchProviderEntry = { type: any; value: any; };

export type SearchSurfaceEntry = {
    scopeId: string;
    sourceChannelId: string;
    element: any;
    providerStack: readonly SearchProviderEntry[] | null;
};

export const MAX_RESIDENT_SEARCH_SURFACES = 3;

/** Judge the native Slate search editor's semantic content: only actual slate strings are
 *  a real query. A localized placeholder (data-slate-placeholder) must never count — the
 *  editor's translated placeholder text and aria-label differ per locale, so comparing
 *  them misreads the placeholder as a query and blocks the native close confirmation. */
export function slateSearchEditorQuery(
    placeholderPresent: boolean,
    slateStringTexts: readonly (string | null)[]
): string | null {
    if (placeholderPresent) return null;
    const text = slateStringTexts.map(text => text ?? "").join("").trim();
    return text || null;
}

/** THE active-state source shared by the fixed Search tab and its resident body: a
 *  resident surface is active exactly when the current channel's scope is the active
 *  scope AND the surface IS that scope. DockTabs and SearchResultsBody both call this
 *  (through host/searchResults.ts) so the tab and the body can never disagree. */
export function isSearchSurfaceActive(
    registry: { isActive(scopeId: string | null): boolean },
    channelScopeId: string | null,
    scopeId: string | null
): boolean {
    return scopeId != null && scopeId === channelScopeId && registry.isActive(scopeId);
}

function reconcileProviderStack(
    current: readonly SearchProviderEntry[] | null,
    next: readonly SearchProviderEntry[] | null
): readonly SearchProviderEntry[] | null {
    if (!current?.length) return current;
    if (!next?.length) return current;

    const nextValues = new Map(next.map(provider => [provider.type, provider.value]));
    return current.map(provider => ({
        type: provider.type,
        value: nextValues.has(provider.type) ? nextValues.get(provider.type) : undefined
    }));
}

export class SearchSurfaceRegistry {
    private readonly entryMap = new Map<string, SearchSurfaceEntry>();
    private readonly activeScopes = new Set<string>();
    private readonly visibleScopes = new Set<string>();
    private readonly closeTokens = new Map<string, symbol>();

    constructor(private readonly maxEntries = MAX_RESIDENT_SEARCH_SURFACES) { }

    private touch(scopeId: string, entry: SearchSurfaceEntry): void {
        this.entryMap.delete(scopeId);
        this.entryMap.set(scopeId, entry);
    }

    private evictOverflow(): string[] {
        const evicted: string[] = [];
        while (this.entryMap.size > Math.max(1, this.maxEntries)) {
            const oldest = this.entryMap.keys().next().value as string | undefined;
            if (oldest == null) break;
            this.remove(oldest);
            evicted.push(oldest);
        }
        return evicted;
    }

    /** Capture the latest exact element for a guild while keeping its resident scope key. */
    capture(
        scopeId: string,
        sourceChannelId: string,
        element: any,
        providerStack: readonly SearchProviderEntry[] | null
    ): { entry: SearchSurfaceEntry; firstOpen: boolean; evictedScopeIds: readonly string[]; } {
        // A fresh SEARCH render supersedes any previously queued native-close callback.
        this.invalidateClose(scopeId);
        const existing = this.entryMap.get(scopeId);
        if (existing) {
            // SearchResults props/stores must follow Discord's latest render. The caller's
            // scope-keyed wrapper keeps the child at one stable position, so React can
            // reconcile its local state whenever Discord preserves the same type/key.
            existing.element = element;
            existing.sourceChannelId = sourceChannelId;
            // Provider TYPES are part of the mounted React ancestry and therefore stay
            // fixed for the lifetime of this resident surface. Compatible live values are
            // refreshed without inserting/removing wrappers and remounting SearchResults.
            existing.providerStack = reconcileProviderStack(existing.providerStack, providerStack);
            this.touch(scopeId, existing);
            return { entry: existing, firstOpen: false, evictedScopeIds: this.evictOverflow() };
        }

        const entry: SearchSurfaceEntry = {
            scopeId,
            sourceChannelId,
            element,
            providerStack
        };
        this.entryMap.set(scopeId, entry);
        return { entry, firstOpen: true, evictedScopeIds: this.evictOverflow() };
    }

    get(scopeId: string | null): SearchSurfaceEntry | null {
        return scopeId == null ? null : this.entryMap.get(scopeId) ?? null;
    }

    all(): SearchSurfaceEntry[] {
        return [...this.entryMap.values()];
    }

    has(scopeId: string | null): boolean {
        return scopeId != null && this.entryMap.has(scopeId);
    }

    activate(scopeId: string | null): boolean {
        if (!this.has(scopeId)) return false;
        this.visibleScopes.add(scopeId!);
        this.activeScopes.add(scopeId!);
        return true;
    }

    isVisible(scopeId: string | null): boolean {
        return scopeId != null && this.entryMap.has(scopeId) && this.visibleScopes.has(scopeId);
    }

    /** Hide the tab/body without unmounting Discord's native SearchResults tree. */
    hide(scopeId: string | null): boolean {
        if (scopeId == null || !this.entryMap.has(scopeId)) return false;
        this.activeScopes.delete(scopeId);
        return this.visibleScopes.delete(scopeId);
    }

    deactivate(scopeId: string | null): boolean {
        return scopeId != null && this.activeScopes.delete(scopeId);
    }

    isActive(scopeId: string | null): boolean {
        return scopeId != null && this.entryMap.has(scopeId) && this.activeScopes.has(scopeId);
    }

    remove(scopeId: string | null): boolean {
        if (scopeId == null) return false;
        this.invalidateClose(scopeId);
        this.activeScopes.delete(scopeId);
        this.visibleScopes.delete(scopeId);
        return this.entryMap.delete(scopeId);
    }

    beginClose(scopeId: string): symbol | null {
        if (!this.has(scopeId)) return null;
        const token = Symbol(scopeId);
        this.closeTokens.set(scopeId, token);
        return token;
    }

    isCurrentClose(scopeId: string, token: symbol): boolean {
        return this.closeTokens.get(scopeId) === token;
    }

    finishClose(scopeId: string, token: symbol): boolean {
        if (!this.isCurrentClose(scopeId, token)) return false;
        this.closeTokens.delete(scopeId);
        return this.remove(scopeId);
    }

    invalidateClose(scopeId: string): void {
        this.closeTokens.delete(scopeId);
    }

    /** Remove only when the callback still belongs to the latest native owner. */
    removeIfSource(scopeId: string | null, sourceChannelId: string): boolean {
        const entry = this.get(scopeId);
        return !!entry && entry.sourceChannelId === sourceChannelId && this.remove(scopeId);
    }

    hideIfSource(scopeId: string | null, sourceChannelId: string): boolean {
        const entry = this.get(scopeId);
        return !!entry && entry.sourceChannelId === sourceChannelId && this.hide(scopeId);
    }

    clear(): void {
        this.entryMap.clear();
        this.activeScopes.clear();
        this.visibleScopes.clear();
        this.closeTokens.clear();
    }
}
