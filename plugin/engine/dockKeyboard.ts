/*
 * Shared dock keyboard gate.
 * ---------------------------------------------------------------------------
 * Every viewer's keyboard shortcuts (image zoom/gallery, PDF page-nav/zoom/find,
 * code find, pptx slide-nav) ride a window-level keydown listener but must only
 * fire while the DOCK actually holds focus — never while the user is typing in the
 * Discord chat box or any other panel. The image viewer pioneered this gate
 * (`#dockview-root` contains document.activeElement); this module factors that exact
 * check out so every viewer reuses ONE gate instead of re-deriving it (and so the
 * "is a text field focused" guard — which a single-key shortcut must respect — lives
 * in one place).
 *
 * No competing global listener lives here: each viewer still binds its OWN
 * window keydown in its body effect (lifecycle-scoped, removed on unmount). This
 * module only supplies the predicates those handlers consult.
 */

// The host node id (mirrors host/mount.ts HOST_ID). The dock-focus gate asks whether
// the focused element is INSIDE this host.
const HOST_ID = "dockview-root";

/** True when the dock panel currently holds keyboard focus — i.e. the focused
 *  element is inside #dockview-root. This is the gate the image viewer's single-key
 *  shortcuts already use; a shortcut that consults it never fires while a Discord
 *  chat input (or any element outside the dock) is focused. */
export function dockHasFocus(): boolean {
    const host = document.getElementById(HOST_ID);
    const ae = document.activeElement;
    return !!host && !!ae && host.contains(ae);
}

/** True when the focused element is a TEXT-ENTRY surface (an <input>/<textarea> or a
 *  contenteditable region — e.g. the find input, or the CodeMirror editor in EDIT
 *  mode). Single-key shortcuts (+/-/0, ←/→) must NOT fire while one is focused, so a
 *  literal "+", "-" or arrow keystroke goes to the field the user is typing in.
 *  Ctrl/Cmd-chorded shortcuts (Ctrl+F) are not affected — they're never a literal
 *  character — so callers gate those on dockHasFocus() alone. */
export function isTextEntryFocused(): boolean {
    const ae = document.activeElement as HTMLElement | null;
    if (!ae) return false;
    if (ae.isContentEditable) return true; // CM edit mode (.cm-content), etc.
    const tag = ae.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return false;
}
