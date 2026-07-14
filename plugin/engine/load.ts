/*
 * Public orchestration — the open-a-file entry points.
 *
 * load() is the content-type router's front door (chip click / programmatic
 * open): it opens the file as a tab in the current channel (dedup-or-append), ends
 * any new-file session, routes the descriptor through showContent, opens the panel
 * chrome, and repaints. retryActiveLoad re-fetches the shown file bypassing both
 * caches; clearArtifact detaches the body to the placeholder; loadInPlace is the
 * gallery primitive that advances the SAME tab without opening a new one.
 *
 * The per-format parsing is NOT here — it's in the viewers (showContent dispatches
 * to them). This module is pure orchestration + the open/tab bookkeeping.
 *
 * (onNewFile — the empty editable markdown surface — is a cross-cutting edit/
 * concern and lands in P8; only a thin note is left here.)
 */

import { detectType } from "./detectType";
import { requestRender } from "./forceRender";
import { hostActions } from "./hostBridge";
import { showContent } from "./showContent";
import { snapshotActiveView } from "./viewState";
import { getActiveWindow, openTab } from "./window";
import type { ContentType } from "./types";

export interface LoadOptsPublic {
    name: string;
    html?: string | null;
    url?: string | null;
    type?: ContentType;
    noCache?: boolean;
    id?: string | null;
}

/** CONTENT-TYPE ROUTER front door. Load anything into the dock panel BODY and
 *  open it. Backed by the content cache: re-clicking the file already shown is a
 *  no-op; clicking a different seen file restores it from cache; only a genuinely
 *  new file fetches. The leaving file's view-state is snapshotted first. */
export function load(opts: LoadOptsPublic): void {
    // Opening a file OPENS A TAB in the current channel: dedup (if the file is already
    // a tab in the strip — pinned or channel-owned — that tab is focused, the strip
    // doesn't grow) else a new channel-owned tab is appended. A pinned tab is never
    // overwritten. The dedup identity is url + routing type (matching the descriptor
    // showContent writes). Inline html (no url) can't dedup, so it always appends.
    const type = detectType(opts);
    openTab(opts.url ?? null, type);
    // Viewing a real file ends any new-file session (the empty editable surface),
    // so the loaded file gets a fresh original baseline + the merge diff.
    getActiveWindow().isNewFile = false;
    const result = showContent({
        name: opts.name, html: opts.html, url: opts.url,
        type, noCache: opts.noCache, id: opts.id
    });

    // Open FIRST, then persist — so the saved per-channel state records open:true.
    openPanelChrome();
    // A no-op didn't change the body; everything else needs a render.
    if (result !== "noop") requestRender();
}

/** The gallery's in-place advance: replace the ACTIVE window's content with the
 *  next/prev file WITHOUT opening a new tab — so stepping a PINNED image tab advances
 *  THAT tab (the generic load() would open/focus another tab). The panel is already
 *  open during gallery nav, so we only render (no openPanelChrome). The image gallery
 *  (P4) calls this; exposed here as the engine primitive. */
export function loadInPlace(next: { name: string; url: string; type?: ContentType }): void {
    getActiveWindow().isNewFile = false;
    const result = showContent({ name: next.name, url: next.url, type: next.type ?? "image" });
    if (result !== "noop") requestRender();
}

/** The shared "make sure the dock is mounted + sealed" side-effects, run by load()
 *  (chip click) and onNewFile() (P8). The dock is always visible, so this just ensures
 *  the host is mounted and keeps the native thread/channel sidebar + member list /
 *  profile sidebar collapsed so the dock holds the exclusive right slot. Does NOT
 *  render — the caller decides if the body changed. */
export function openPanelChrome(): void {
    const host = hostActions();
    host.closeNativeChannelSidebar();
    host.ensureHost();
    host.applyOpenState();
    host.syncNativeMemberList(true); // collapse the member list like a thread
    host.syncNativeProfileSidebar(true);
}

/** Re-fetch the file currently shown, bypassing both the in-memory content cache
 *  and the HTTP cache. Invoked by the error card's "Try again" — the active
 *  descriptor (name/url/type) is re-loaded fresh so a transient/expired-link
 *  failure can recover without the user re-clicking the original chip. */
export function retryActiveLoad(): void {
    const d = getActiveWindow().activeDescriptor;
    if (!d || !d.url) return;
    load({ name: d.name || "file", url: d.url, type: d.type, noCache: true });
}

/** Clear the loaded content, returning the body to the placeholder. The file is
 *  kept in the cache (so reopening it is still instant); we just detach it. */
export function clearArtifact(): void {
    const win = getActiveWindow();
    snapshotActiveView(win);
    closeLightbox(win); // the body is going empty — drop the lightbox
    win.content.name = null;
    win.content.type = "html";
    win.content.html = null;
    win.content.frameHtml = null;
    win.content.code = null;
    win.content.codeLang = "plaintext";
    win.content.pdf = { doc: null, pages: 0, renderToken: win.content.pdf.renderToken + 1 };
    win.content.model3d = { object: null, renderToken: win.content.model3d.renderToken + 1 };
    win.content.pptx = { presentation: null, renderToken: win.content.pptx.renderToken + 1 };
    win.content.url = null;
    win.content.loading = false;
    win.content.error = null;
    win.content.binary = false;
    win.editView.mode = "view";
    win.editView.editBuffer = null;
    win.activeCacheKey = null;
    win.activeDescriptor = null;
    requestRender();
}

function closeLightbox(win = getActiveWindow()): void {
    const img = win.viewStates["image"] as { fullscreen?: boolean } | undefined;
    if (img) img.fullscreen = false;
}
