import type { CacheEntry, ContentType, DockWindow, WindowCacheState } from "./types";

/** Return the mutable state owned by one window for one shared payload. */
export function getWindowCacheState(
    win: DockWindow,
    key: string,
    create = true,
): WindowCacheState | undefined {
    let state = win.cacheStates.get(key);
    if (!state && create) {
        state = { view: {} };
        win.cacheStates.set(key, state);
    }
    return state;
}

/** Project a shared payload through the window-owned view/edit/render overlay. */
export function windowCacheEntry(win: DockWindow, entry: CacheEntry): CacheEntry {
    const state = getWindowCacheState(win, entry.key)!;
    if (entry.renderType === "rasterimage" && state.renderUrl === undefined) {
        const pageUrls = entry.rasterPageUrls;
        const statePage = state.view.rasterPage;
        const stateUrl = state.renderUrl;
        const sharedIndex = pageUrls?.indexOf(entry.renderUrl) ?? -1;
        const stateIndex = stateUrl === undefined ? -1 : pageUrls?.indexOf(stateUrl) ?? -1;
        const pageIndex = statePage != null ? statePage - 1 : stateIndex >= 0 ? stateIndex : sharedIndex;
        const page = pageIndex >= 0 ? pageIndex + 1 : statePage ?? 1;
        state.view.rasterPage ??= page;
        state.renderUrl = pageUrls?.[Math.max(0, page - 1)] ?? entry.renderUrl;
    }
    return {
        ...entry,
        html: state.html !== undefined ? state.html : entry.html,
        frameHtml: state.frameHtml !== undefined ? state.frameHtml : entry.frameHtml,
        renderUrl: state.renderUrl ?? entry.renderUrl,
        view: state.view
    };
}

/** Refresh the source descriptor, carrying a source-linked render URL forward. */
export function updateSourceDescriptor(entry: CacheEntry, sourceUrl: string, sourceType: ContentType): void {
    const sourceLinked = entry.sourceType === entry.renderType && entry.sourceUrl === entry.renderUrl;
    entry.sourceUrl = sourceUrl;
    entry.sourceType = sourceType;
    entry.url = sourceUrl;
    entry.type = sourceType;
    if (sourceLinked) {
        entry.renderUrl = sourceUrl;
        entry.renderType = sourceType;
    }
}

/** Store a converted/display payload without changing the original descriptor. */
export function setRenderPayload(entry: CacheEntry, renderUrl: string, renderType: ContentType): void {
    entry.renderUrl = renderUrl;
    entry.renderType = renderType;
}
