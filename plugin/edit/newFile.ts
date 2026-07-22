/*
 * New file — open the dock with an EMPTY editable markdown surface.
 *
 * The `+` composer-menu "New file" (index.tsx's "channel-attach" contextMenu)
 * opens a brand-new file: an EMPTY editable CM in EDIT mode (default markdown),
 * with NO original baseline (so it edits as a plain editor — no merge diff). It IS
 * a normal `content` (type markdown, empty source) rather than a separate compose
 * surface, so every viewer affordance (find, copy, the edit toggle) works on it
 * unchanged. `isNewFile` flags it so editOriginalText() returns null (no merge
 * diff) and the attach filename defaults to `message.md`. `newFileChannel` is the
 * attach target resolved at open time (the menu's props.channel, else the current
 * channel).
 *
 * No module-top work: the channel stores + the engine open path are all reached
 * inside onNewFile (at click time), never at module eval.
 */

import { getCurrentChannel } from "@vencord/types/utils";
import { ChannelStore, SelectedChannelStore } from "@vencord/types/webpack/common";

import { requestRender } from "../engine/forceRender";
import { setContextActive } from "../engine/contextTab";
import { bump } from "../engine/loadToken";
import { openPanelChrome } from "../engine/load";
import { setPendingScrollTop, snapshotActiveView } from "../engine/viewState";
import { getActiveWindow, getWindowChannelId, openTab } from "../engine/window";
import { STRINGS } from "../strings";

/** Resolve the channel a brand-new file should attach to: the menu's channel (if
 *  present), else the channel currently being viewed. */
function resolveTargetChannel(channel: any | null): any {
    return channel
        || getCurrentChannel()
        || ChannelStore.getChannel(SelectedChannelStore.getChannelId());
}

/** The `+`-menu "New file": open the dock with an EMPTY editable surface — the same
 *  CodeMirror editor every text viewer uses, in EDIT mode, default markdown. It is a
 *  normal `content` (type markdown, empty source) so find / copy / the edit toggle
 *  all apply unchanged; `isNewFile` flags it so it edits as a plain editor (NO merge
 *  diff — there is no original baseline) and the attach filename defaults to
 *  `message.md`. */
export function onNewFile(channel: any | null): void {
    // A new file OPENS A NEW channel-owned tab in the current channel. It has no url so
    // it never dedups (openTab appends a fresh tab) and never clobbers a pinned tab.
    openTab(null, "markdown");
    // The new file is the active view — yield the context tab for this channel.
    setContextActive(getWindowChannelId(), false);
    const win = getActiveWindow();
    // Leaving whatever was docked: snapshot its view-state so a later re-open of that
    // file is unaffected (mirrors showContent's switch-away bookkeeping).
    snapshotActiveView(win);
    // the body is going empty — drop any image lightbox on this window.
    const img = win.viewStates["image"] as { fullscreen?: boolean } | undefined;
    if (img) img.fullscreen = false;
    bump(); // supersede any in-flight loader

    win.isNewFile = true;
    win.newFileChannel = resolveTargetChannel(channel);

    // A fresh empty markdown content with no url (so it's never cached) in edit mode.
    // The CM seeds from the (empty) buffer; editSourceText() returns "".
    win.content.name = STRINGS.attach.defaultNewName; // header title = the default name
    win.content.type = "markdown";
    win.content.url = null;
    win.content.html = null;
    win.content.frameHtml = null;
    win.content.pdf = { doc: null, pages: 0, renderToken: win.content.pdf.renderToken + 1 };
    win.content.code = "";
    win.content.codeLang = "markdown";
    win.content.loading = false;
    win.content.error = null;
    win.content.binary = false;
    win.content.seq += 1;
    win.activeCacheKey = null;
    win.activeDescriptor = null;
    setPendingScrollTop(null);
    // open directly in edit mode (the decision: default open = view, but a NEW file =
    // edit) with an empty buffer.
    win.editView.mode = "edit";
    win.editView.editBuffer = "";

    openPanelChrome();
    requestRender();
}
