/* Pure thread-tab binding policy shared by the window store and lifecycle tests. */

/** A background thread reopen may only change the active binding of its parent strip. */
export function shouldBindThreadToCurrentChannel(
    parentChannelId: string | null,
    currentChannelId: string | null
): boolean {
    return parentChannelId === currentChannelId;
}
