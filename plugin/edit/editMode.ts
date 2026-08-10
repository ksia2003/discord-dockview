/*
 * Edit-mode — the cross-cutting editable-text capability (NOT a viewer).
 *
 * A text-family file (code / csv-raw / structured-raw / markdown / html) opens in
 * its VIEW mode; a single state-colour toggle enters EDIT over a TEMPORARY in-
 * memory buffer (never the original file / the Discord message). This module owns
 * that buffer plumbing + the view↔edit toggle; the text viewers opt in via
 * `capabilities.editable` and delegate the toggle here. The ENGINE never asks
 * "is it editing" — edit-mode rides over the viewers, it isn't one.
 *
 *   `editBuffer` is the live edit text (null = unedited; the CM shows the original
 *   source). It is mirrored into the active cache entry's view so it survives both
 *   mode toggles AND a cache return (re-open lands on the edited text). Inline
 *   artifacts (no cache key) keep the buffer here only, which is fine — they live
 *   exactly as long as the dock is open.
 *
 *   `editOriginalText` is the PRISTINE source = the unifiedMergeView baseline. Every
 *   editable type keeps its original source in `content.code`, SEPARATE from the
 *   rendered/view payload (`content.html`), so it's immutable across view↔edit
 *   toggles. A NEW file has no original (null) → it edits as a plain CM, no diff.
 *
 * No module-top work: only imports + function decls. The active window / cache /
 * render are all read at call time; the markdown re-render pulls renderMarkdownDoc
 * (which itself lazily registers marked) only inside toggleEditMode.
 */

import { getActiveCacheEntry, getWindowCacheState } from "../engine/cache";
import { requestRender } from "../engine/forceRender";
import { setArtifactHtml } from "../engine/nonce";
import { setPendingScrollTop } from "../engine/viewState";
import { getActiveWindow } from "../engine/window";
import type { CacheEntry, DockWindow } from "../engine/types";
import { codeController, codeState } from "../viewers/text/CodeBody";
import { toggleCodeFind } from "../viewers/text/CodeHeaderControls";
import { renderMarkdownDoc } from "../viewers/doc/MarkdownViewer";

/** Reset the editView slot for a fresh file: VIEW mode, unedited (no buffer). */
export function resetEditView(w: DockWindow = getActiveWindow()): void {
    w.editView.mode = "view"; // a fresh file always opens in the view mode
    w.editView.editBuffer = null; // and unedited (no buffer yet)
}

/** The PRISTINE (unedited) source text for the current editable type — also the
 *  merge-diff baseline. Every editable type keeps its original source in
 *  `content.code`, SEPARATE from the rendered/view payload (`content.html`):
 *   - code / csv-raw / structured-raw: content.code is the file text;
 *   - markdown: content.code is the raw md source (NOT the rendered html);
 *   - html/.artifact: content.code is the original html source. Leaving edit
 *     overwrites content.html (the rendered view) via setArtifactHtml but NEVER
 *     content.code, so re-entering edit still diffs against the true original. */
export function editSourceText(w: DockWindow = getActiveWindow()): string {
    return w.content.code || ""; // code / csv-raw / markdown-source / artifact-html
}

/** The current EDITABLE text = the buffer if the user has edited, else the
 *  original source. This is what the editable CM is seeded from and what the
 *  renderers (markdown re-render, artifact re-render, CSV grid re-parse) derive
 *  from on a toggle back to the view mode. */
export function editBufferText(w: DockWindow = getActiveWindow()): string {
    return w.editView.editBuffer != null ? w.editView.editBuffer : editSourceText(w);
}

/** Record a CM edit into the temporary buffer + mirror it into the active cache
 *  entry so it survives mode toggles and a cache return. Never touches the
 *  original source field (content.code / content.html stay the pristine file). */
export function setEditBuffer(text: string, w: DockWindow = getActiveWindow()): void {
    w.editView.editBuffer = text;
    if (w.activeCacheKey != null) {
        const state = getWindowCacheState(w, w.activeCacheKey);
        if (state) state.view.editBuffer = text;
    }
}

/** The pristine original text of the CURRENTLY-shown editable file, used as the
 *  unifiedMergeView baseline. A NEW file has none (it never had an original) →
 *  null, so the editor mounts as a plain CM with no diff. Otherwise it's
 *  editSourceText() (artifact html / code / csv-raw / markdown source). */
export function editOriginalText(w: DockWindow = getActiveWindow()): string | null {
    if (w.isNewFile) return null;
    return editSourceText(w);
}

/** Flip the editable text family between its VIEW mode and EDIT mode. The CSV /
 *  structured grid/raw toggle is a SEPARATE path (it IS its own edit entry — raw =
 *  the editable CM) — this drives code, markdown and html/.artifact.
 *   - code: ONE CodeMirror instance, flipped read↔edit live via the compartment
 *     (no remount — scroll/find/IME survive). The doc already shows the buffer.
 *   - markdown / html: the body SWITCHES (rendered iframe ↔ editable CM over the
 *     source). Toggling back to VIEW RE-RENDERS from the edited buffer (md
 *     re-marked, html re-nonce-stamped) so your edits are reflected in the render. */
export function toggleEditMode(): void {
    const win = getActiveWindow();
    if (win.content.type !== "code" && win.content.type !== "markdown" && win.content.type !== "html") return;
    const entering = win.editView.mode === "view";
    win.editView.mode = entering ? "edit" : "view";

    if (win.content.type === "code") {
        // Same CM instance: just reconfigure editability. No seq bump, no remount.
        codeController()?.setEditable(entering);
        requestRender(); // repaint the toggle's active state (row 2)
        return;
    }

    // markdown / html = a body swap (iframe <-> CM). When LEAVING edit, rebuild the
    // rendered doc from the edited buffer so the render reflects the edits.
    if (!entering) {
        const src = editBufferText(win);
        const fullHtml = win.content.type === "markdown" ? renderMarkdownDoc(src) : src;
        setArtifactHtml(win.content, fullHtml);
        // keep the cache entry's rendered payload in sync so a re-open shows edits.
        if (win.activeCacheKey != null) {
            const e = getActiveCacheEntry(win);
            const state = e ? getWindowCacheState(win, e.key) : undefined;
            if (state) {
                state.html = win.content.html;
                state.frameHtml = win.content.frameHtml;
            }
        }
    }
    // close any find bar from the edit CM so it doesn't linger over the render.
    if (!entering && codeState(win).findOpen) toggleCodeFind();
    win.content.seq += 1; // new body identity -> iframe/CM remount fresh
    setPendingScrollTop(null, win); // each mode opens at its own top
    requestRender();
}

// --- cross-cutting cache save/restore --------------------------------------
// edit-mode is NOT viewer-owned, so the per-viewer snapshot/restore can't carry
// it. The editable viewers' snapshot/restore delegate the edit mode + buffer here
// (keeping the ENGINE's viewState dispatch agnostic of editing). The buffer is
// also written through on every keystroke by setEditBuffer; this catches the mode.

/** Park the edit mode + buffer onto the cache entry (called from an editable
 *  viewer's snapshot). CSV/structured carry their grid/raw choice in their own
 *  view-state; here we only persist the edit mode + the shared buffer. */
export function snapshotEditState(win: DockWindow, e: CacheEntry): void {
    e.view.editMode = win.editView.mode;
    e.view.editBuffer = win.editView.editBuffer;
}

/** Restore the edit mode + buffer from the cache entry (called from an editable
 *  viewer's restore). CSV's view mode rides its csv view-state; for it we restore
 *  only the buffer and force VIEW (its raw editing shares the buffer but the
 *  grid/raw choice is the csv slice's job). */
export function restoreEditState(win: DockWindow, e: CacheEntry): void {
    win.editView.editBuffer = e.view.editBuffer ?? null;
    // CSV is a render surface here (an XLSX entry can be retyped to CSV); the
    // source routing type is not the viewer whose edit mode is being restored.
    win.editView.mode = e.renderType === "csv" ? "view" : (e.view.editMode ?? "view");
}
