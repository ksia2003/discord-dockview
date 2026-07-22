/*
 * DataStore-backed persistence for the dock width.
 *
 * VERBATIM HAZARD — Vencord's renderer runs in an ISOLATED context where
 * `localStorage` is undefined (both window.* and globalThis.*), so the old
 * localStorage-backed lsGet/lsSet were silent no-ops and the width never
 * survived a restart.
 *
 * We persist through Vencord's DataStore (IndexedDB, available in the isolated
 * context). DataStore is async, but the existing call sites read/write the
 * width SYNCHRONOUSLY (state init, resize). So we keep a synchronous in-memory
 * mirror (`persistCache`) that all the lsGet/lsSet sites hit, and:
 *   - load() the persisted value from DataStore once at startup, seeding the
 *     mirror + applying it to state/DOM (write-back load),
 *   - write-through every lsSet: update the mirror immediately AND fire an
 *     async DataStore.set (fire-and-forget; ordering is per-key last-write-wins).
 *
 * The dock is always open in the rewrite, so there is no open/visibility state to
 * persist — only the width (LS_WIDTH).
 */

import * as DataStore from "@vencord/types/api/DataStore";

export const LS_WIDTH = "dockview.dock.width";

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

/** The persisted width string, read once from DataStore into the mirror. The host
 *  applies it to live state + DOM (it owns `activeWindow` and the layout), so this
 *  returns the raw string rather than reaching across layers. Idempotent: a second
 *  call after the first resolved returns the already-mirrored value. */
export async function loadPersistedState(): Promise<{ widthStr: string | null }> {
    if (persistLoaded) {
        return { widthStr: lsGet(LS_WIDTH) };
    }
    let widthStr: string | null = null;
    try {
        widthStr = (await DataStore.get(LS_WIDTH)) ?? null;
    } catch {
        /* DataStore unavailable — fall through with defaults already in state */
    }
    persistLoaded = true;
    if (typeof widthStr === "string") persistCache.set(LS_WIDTH, widthStr);
    return {
        widthStr: typeof widthStr === "string" ? widthStr : null
    };
}
