/*
 * The THREAD body — the dock-side controller for a thread tab's chat.
 *
 * The chat itself does NOT render here: a full channel-view chat rendered inside the dock's
 * React root (nested in Discord's tree) wedges the renderer (see viewers/thread/threadPortal
 * for the why + the proof). So the chat lives in an ISOLATED createRoot on a `document.body`
 * node, positioned as a fixed overlay over the dock body. This body component is just the
 * controller: while it's mounted (this thread tab is the active dock view) it SHOWS that
 * thread's portal over the dock body; on unmount / switch away the portal is hidden. It also
 * drives the priming-free chat capture (from the always-rendered main chat) and re-renders
 * the portal once the type lands.
 *
 * The visible dock-body element this component renders is just a thin backdrop under the
 * overlay (so the dock body isn't empty behind the fixed portal during a repaint frame).
 *
 * NO module-top React.createElement / webpack access.
 */

import { React } from "@webpack/common";

import { requestRender } from "../../engine/forceRender";
import { getActiveWindow } from "../../engine/window";
import { captureChat, getChannelObject, getChatType } from "../../host/slotComponents";
import {
    ensureThreadPortal, hideThreadPortals, refreshThreadPortal, showThreadPortal
} from "./threadPortal";

/** The thread body controller. On mount (this thread tab became the active view) it shows
 *  the thread's isolated chat portal over the dock body; on unmount it hides all portals.
 *  Captures the chat type priming-free and refreshes the portal once it lands. */
export function ThreadBody() {
    const { useEffect } = React;
    const win = getActiveWindow();
    const threadId = win.content.threadChannelId;

    useEffect(() => {
        let alive = true;
        // Everything here touches the ISOLATED portal roots (document.body); a throw must
        // NEVER escape this effect and unmount ThreadBody (which would cascade to the dock
        // root). Guard the whole body — a portal hiccup degrades to "no chat this frame",
        // never a blank dock.
        try {
            if (!threadId) { hideThreadPortals(); return () => { alive = false; }; }
            // Self-heal the tab label: a thread opened the instant it was created may have
            // got the fallback "Thread" name (its channel wasn't in the store yet). If the
            // channel now resolves with a real name, adopt it + repaint the strip.
            const ch = getChannelObject(threadId);
            if (ch && ch.name && win.content.name !== ch.name) { win.content.name = ch.name; requestRender(); }
            // Ensure the portal exists + show it over the dock body.
            ensureThreadPortal(threadId);
            showThreadPortal(threadId);

            // Capture is priming-free (the main chat is always in the tree). If it isn't
            // ready this frame (main chat mid-mount), poll a few frames and refresh the
            // portal once the type lands so the chat paints.
            if (!getChatType()) {
                const raf = (window as any).requestAnimationFrame || ((cb: any) => setTimeout(cb, 16));
                let tries = 0;
                const tick = () => {
                    if (!alive) return;
                    try { if (captureChat()) { refreshThreadPortal(threadId); return; } } catch { /* ignore */ }
                    if (++tries >= 20) return;
                    raf(tick);
                };
                raf(tick);
            }
        } catch { /* a portal op failed — the dock stays intact, the chat just won't paint */ }

        // On unmount / thread switch: hide the portals (the outgoing thread's portal stays
        // mounted with its draft/scroll — it's just display:none until shown again).
        return () => { alive = false; try { hideThreadPortals(); } catch { /* ignore */ } };
    }, [threadId]);

    // A thin backdrop under the fixed overlay. The portal (document.body) draws the chat on
    // top; this keeps the dock body from flashing empty behind it during a repaint.
    return React.createElement("div", { className: "dockview-thread-body dockview-thread-backdrop" });
}
