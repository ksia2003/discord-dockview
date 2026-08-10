export type CacheKeyed = { key: string };

export type SettledCacheEntry = { loading: boolean; error?: string | null };

export function settleDetachedEntry(entry: SettledCacheEntry | null, error: string): void {
    if (!entry) return;
    entry.loading = false;
    entry.error = error;
}

export function revokeUniqueBlobUrls(
    urls: Iterable<string | null | undefined>,
    revoke: (url: string) => void,
): void {
    const seen = new Set<string>();
    for (const url of urls) {
        if (!url || !url.startsWith("blob:") || seen.has(url)) continue;
        seen.add(url);
        revoke(url);
    }
}

export function discardStaleBlob(
    entry: SettledCacheEntry | null,
    blobUrl: string,
    revoke: (url: string) => void,
    error: string,
): void {
    revokeUniqueBlobUrls([blobUrl], revoke);
    settleDetachedEntry(entry, error);
}

const trackedLoadingEntries = new WeakSet<object>();

/** Observe the existing loading contract and collect retired ownership after settle. */
export function trackLoading<T extends { loading: boolean }>(entry: T, onSettled: () => void): void {
    if (trackedLoadingEntries.has(entry)) return;
    trackedLoadingEntries.add(entry);
    let loading = entry.loading;
    const enqueue = () => {
        if (typeof queueMicrotask === "function") queueMicrotask(onSettled);
        else void Promise.resolve().then(onSettled);
    };
    Object.defineProperty(entry, "loading", {
        configurable: true,
        enumerable: true,
        get: () => loading,
        set: (next: boolean) => {
            loading = next;
            if (!next) enqueue();
        }
    });
}

/** Retire a replaced entry without disposing it while another owner may use it. */
export function replaceCacheEntry<T extends CacheKeyed>(
    current: Map<string, T>,
    retired: Set<T>,
    entry: T,
): void {
    const previous = current.get(entry.key);
    if (previous && previous !== entry) retired.add(previous);
    current.set(entry.key, entry);
}

/** Reorder only the current entry; a retired exact entry must never be reinserted. */
export function touchCurrentCacheEntry<T extends CacheKeyed>(current: Map<string, T>, entry: T): boolean {
    if (current.get(entry.key) !== entry) return false;
    current.delete(entry.key);
    current.set(entry.key, entry);
    return true;
}

/** Dispose retired entries exactly once after their live/pending owners release them. */
export function collectRetiredEntries<T>(
    retired: Set<T>,
    live: ReadonlySet<T>,
    dispose: (entry: T) => void,
): void {
    for (const entry of [...retired]) {
        if (live.has(entry)) continue;
        retired.delete(entry);
        dispose(entry);
    }
}

/** During plugin shutdown, keep pending entries in a separate set until settlement. */
export function moveToShutdown<T>(
    entries: Iterable<T>,
    shutdown: Set<T>,
    dispose: (entry: T) => void,
    isPending: (entry: T) => boolean,
): void {
    for (const entry of entries) {
        if (isPending(entry)) shutdown.add(entry);
        else dispose(entry);
    }
}
