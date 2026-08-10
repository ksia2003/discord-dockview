/*
 * Preserve Discord's native managed-message-scroller position when a body-level chat
 * portal is resized or temporarily collapsed. Raw scrollTop is not a stable bookmark:
 * changing the portal width changes message wrapping and therefore every later offset.
 * Keep either the native bottom lock or the first visible message + its viewport offset.
 */

export interface ChatScrollAnchor {
    atBottom: boolean;
    itemId: string | null;
    itemOffset: number;
    rawScrollTop: number;
}

const retainedAnchors = new WeakMap<HTMLElement, ChatScrollAnchor>();
const restoreGeneration = new WeakMap<HTMLElement, number>();
let nextRestoreGeneration = 0;

function messageScroller(root: HTMLElement): HTMLElement | null {
    return Array.from(root.querySelectorAll<HTMLElement>("[class*=scroller]"))
        .find(node => node.scrollHeight > node.clientHeight + 10) ?? null;
}

function visibleMessage(root: HTMLElement, scroller: HTMLElement): HTMLElement | null {
    const viewport = scroller.getBoundingClientRect();
    const items = Array.from(root.querySelectorAll<HTMLElement>("[data-list-item-id]"));
    const intersects = (node: HTMLElement) => {
            const rect = node.getBoundingClientRect();
            return rect.bottom > viewport.top && rect.top < viewport.bottom;
    };
    // Date dividers and other virtual-list sentinels also carry data-list-item-id, but
    // Discord freely repositions/recycles them. Prefer an actual message row; its snowflake
    // identity is stable across width changes, Search masking and channel round-trips.
    return items.find(node =>
        node.getAttribute("data-list-item-id")?.startsWith("chat-messages___chat-messages-")
        && intersects(node)
    ) ?? items.find(intersects) ?? null;
}

export function captureChatScrollAnchor(root: HTMLElement): ChatScrollAnchor | null {
    const scroller = messageScroller(root);
    if (!scroller || scroller.clientHeight <= 0) return null;
    const bottomDistance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    const item = visibleMessage(root, scroller);
    const viewport = scroller.getBoundingClientRect();
    const itemRect = item?.getBoundingClientRect();
    return {
        atBottom: bottomDistance <= 2,
        itemId: item?.getAttribute("data-list-item-id") ?? null,
        itemOffset: itemRect ? itemRect.top - viewport.top : 0,
        rawScrollTop: scroller.scrollTop
    };
}

function restoreChatScrollAnchor(root: HTMLElement, anchor: ChatScrollAnchor): void {
    const scroller = messageScroller(root);
    if (!scroller || scroller.clientHeight <= 0) return;
    if (anchor.atBottom) {
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        return;
    }

    const item = anchor.itemId
        ? Array.from(root.querySelectorAll<HTMLElement>("[data-list-item-id]"))
            .find(node => node.getAttribute("data-list-item-id") === anchor.itemId)
        : null;
    if (!item) {
        scroller.scrollTop = anchor.rawScrollTop;
        return;
    }
    const delta = (item.getBoundingClientRect().top - scroller.getBoundingClientRect().top) - anchor.itemOffset;
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
}

/** Restore immediately (forced layout) and for the next three animation frames. Discord's
 * virtual scroller may commit a second measurement after our width write, so a one-shot
 * scrollTop assignment is insufficient. A newer geometry change cancels older retries. */
export function restoreChatScrollAnchorAcrossFrames(root: HTMLElement, anchor: ChatScrollAnchor): void {
    const generation = ++nextRestoreGeneration;
    restoreGeneration.set(root, generation);
    restoreChatScrollAnchor(root, anchor);
    let frames = 3;
    const tick = () => {
        if (restoreGeneration.get(root) !== generation) return;
        restoreChatScrollAnchor(root, anchor);
        if (--frames > 0) (window.requestAnimationFrame || ((cb: FrameRequestCallback) => window.setTimeout(cb, 16)))(tick);
    };
    (window.requestAnimationFrame || ((cb: FrameRequestCallback) => window.setTimeout(cb, 16)))(tick);
}

/** Save a semantic position immediately before display:none. */
export function retainChatScrollAnchor(root: HTMLElement): void {
    const anchor = captureChatScrollAnchor(root);
    if (anchor) retainedAnchors.set(root, anchor);
}

/** Restore and consume the last position saved before display:none. */
export function restoreRetainedChatScrollAnchor(root: HTMLElement): void {
    const anchor = retainedAnchors.get(root);
    if (!anchor) return;
    retainedAnchors.delete(root);
    restoreChatScrollAnchorAcrossFrames(root, anchor);
}
