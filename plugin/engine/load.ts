/*
 * Public orchestration — the open-a-file entry points.
 *
 * load() is the content-type router's front door (chip click / programmatic
 * open): it focuses the channel's transient window, ends any new-file session,
 * routes the descriptor through showContent, opens the panel chrome, and repaints.
 * retryActiveLoad re-fetches the shown file bypassing both caches; clearArtifact
 * detaches the body to the placeholder; loadInPlace is the gallery primitive that
 * advances the SAME tab without spawning a transient.
 *
 * The per-format parsing is NOT here — it's in the viewers (showContent dispatches
 * to them). This module is pure orchestration + the open/transient bookkeeping.
 *
 * (onNewFile — the empty editable markdown surface — is a cross-cutting edit/
 * concern and lands in P8; only a thin note is left here.)
 */

import { getCurrentChannelId } from "../host/channel";
import { saveCurrentChannelState } from "./channelMemory";
import { detectType } from "./detectType";
import { requestRender } from "./forceRender";
import { hostActions } from "./hostBridge";
import { LS_OPEN, lsSet } from "./persist";
import { showContent } from "./showContent";
import { snapshotActiveView } from "./viewState";
import {
    addWindow, getActiveWindow, makeWindow, setActiveWindow, transientWindow
} from "./window";
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
    // Opening a file always lands in the TRANSIENT window of the current channel
    // (created if none) and never overwrites a pinned tab — pin-driven tabs.
    focusTransientForOpen();
    // Viewing a real file ends any new-file session (the empty editable surface),
    // so the loaded file gets a fresh original baseline + the merge diff.
    getActiveWindow().isNewFile = false;
    const result = showContent({
        name: opts.name, html: opts.html, url: opts.url,
        type: detectType(opts), noCache: opts.noCache, id: opts.id
    });

    // Open FIRST, then persist — so the saved per-channel state records open:true.
    openPanelChrome();
    // A no-op didn't change the body; everything else needs a render.
    if (result !== "noop") requestRender();
}

/** The gallery's in-place advance: replace the ACTIVE window's content with the
 *  next/prev file WITHOUT acquiring/spawning the transient — so stepping a PINNED
 *  image tab advances THAT tab (the generic load() would route through
 *  focusTransientForOpen and silently jump to another window). The panel is
 *  already open during gallery nav, so we only render (no openPanelChrome). The
 *  image gallery (P4) calls this; exposed here as the engine primitive. */
export function loadInPlace(next: { name: string; url: string; type?: ContentType }): void {
    getActiveWindow().isNewFile = false;
    const result = showContent({ name: next.name, url: next.url, type: next.type ?? "image" });
    if (result !== "noop") requestRender();
}

/** Make the ACTIVE window the current channel's TRANSIENT window, ready to take a
 *  freshly-opened file (so a chip click replaces the transient content and NEVER
 *  clobbers a pinned tab). If a transient already exists it is re-bound to the
 *  current channel and focused; otherwise a new one is appended. Before swapping
 *  away from a pinned active window we snapshot its live view-state. */
export function focusTransientForOpen(): void {
    const channelId = getCurrentChannelId();
    let t = transientWindow();
    if (!t) {
        // No transient slot (every window is pinned) → create one for this channel.
        snapshotActiveView(getActiveWindow());
        t = makeWindow({ pinned: false, ownerChannelId: channelId });
        addWindow(t);
    } else {
        // Re-bind the lone transient to the channel we're opening in.
        t.ownerChannelId = channelId;
    }
    if (getActiveWindow() !== t) {
        snapshotActiveView(getActiveWindow());
        setActiveWindow(t);
    }
}

/** The shared "open the panel into the right slot" side-effects, run by load()
 *  (chip click) and onNewFile() (P8). Opens FIRST then persists, so the per-
 *  channel save records open:true; collapses the native thread/channel sidebar +
 *  member list / profile sidebar so the dock holds the exclusive right slot like
 *  a real thread. Does NOT render — the caller decides if the body changed. */
export function openPanelChrome(): void {
    const host = hostActions();
    host.closeNativeChannelSidebar();
    getActiveWindow().state.open = true;
    lsSet(LS_OPEN, "1");
    saveCurrentChannelState();
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
    win.content.url = null;
    win.content.loading = false;
    win.content.error = null;
    win.content.binary = false;
    win.editView.mode = "view";
    win.editView.editBuffer = null;
    win.activeCacheKey = null;
    win.activeDescriptor = null;
    saveCurrentChannelState();
    requestRender();
}

function closeLightbox(win = getActiveWindow()): void {
    const img = win.viewStates["image"] as { fullscreen?: boolean } | undefined;
    if (img) img.fullscreen = false;
}
