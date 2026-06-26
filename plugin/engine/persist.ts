/*
 * DataStore-backed persistence for the dock width + open flag.
 *
 * VERBATIM HAZARD — Vencord's renderer runs in an ISOLATED context where
 * `localStorage` is undefined (both window.* and globalThis.*), so the old
 * localStorage-backed lsGet/lsSet were silent no-ops and width/open never
 * survived a restart.
 *
 * We persist through Vencord's DataStore (IndexedDB, available in the isolated
 * context). DataStore is async, but the existing call sites read/write the
 * state SYNCHRONOUSLY (state init, toggle, resize). So we keep a synchronous
 * in-memory mirror (`persistCache`) that all the lsGet/lsSet sites hit, and:
 *   - load() the persisted values from DataStore once at startup, seeding the
 *     mirror + applying them to state/DOM (write-back load),
 *   - write-through every lsSet: update the mirror immediately AND fire an
 *     async DataStore.set (fire-and-forget; ordering is per-key last-write-wins).
 */

import * as DataStore from "@api/DataStore";

export const LS_WIDTH = "dockview.dock.width";
export const LS_OPEN = "dockview.dock.open";

const persistCache = new Map<string, string>();
let persistLoaded = false;

export function lsGet(k: string): string | null {
    return persistCache.has(k) ? persistCache.get(k)! : null;
}

export function lsSet(k: string, v: string): void {
    persistCache.set(k, v);
    // Don't write back before the initial load completes — an early write
    // (module-init defaults) must not clobber the stored value we're about to
    // read. After load, every change is durably written through.
    if (!persistLoaded) return;
    try {
        DataStore.set(k, v).catch(() => { /* ignore — best-effort persist */ });
    } catch {
        /* DataStore unavailable: stay in-memory only */
    }
}

/** The persisted width/open strings, read once from DataStore into the mirror.
 *  The host applies them to live state + DOM (it owns `activeWindow` and the
 *  layout), so this returns the raw strings rather than reaching across layers.
 *
 *  `open` is only ever forced TRUE from storage by the host — a channel switch
 *  during the async gap must not be slammed shut. Idempotent: a second call
 *  after the first resolved returns the already-mirrored values. */
export async function loadPersistedState(): Promise<{ openStr: string | null; widthStr: string | null }> {
    if (persistLoaded) {
        return { openStr: lsGet(LS_OPEN), widthStr: lsGet(LS_WIDTH) };
    }
    let openStr: string | null = null;
    let widthStr: string | null = null;
    try {
        [openStr, widthStr] = await DataStore.getMany([LS_OPEN, LS_WIDTH]);
    } catch {
        /* DataStore unavailable — fall through with defaults already in state */
    }
    persistLoaded = true;
    if (typeof openStr === "string") persistCache.set(LS_OPEN, openStr);
    if (typeof widthStr === "string") persistCache.set(LS_WIDTH, widthStr);
    return {
        openStr: typeof openStr === "string" ? openStr : null,
        widthStr: typeof widthStr === "string" ? widthStr : null
    };
}
