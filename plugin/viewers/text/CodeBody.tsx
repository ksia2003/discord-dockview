/*
 * The CODE / TEXT body — a CodeMirror 6 editor (read in VIEW mode, editable in
 * EDIT mode).
 *
 * CM is lazy-loaded on the first text-file open (cm.ts/loadCM). React mounts an
 * empty host and the effect builds the EditorView once the modules resolve, keyed
 * on content.seq so a new file remounts fresh. While CM loads (a beat on the very
 * first open) the body shows nothing — the modules resolve a few ms after the
 * import warms.
 *
 * The body publishes its imperative controller into the forceRender "code" live-
 * controller slot (find / wrap / copy / scrollTo / setEditable); the header toolbar
 * + the find bar read it back. UNMOUNT GUARD (load-bearing): on teardown we only
 * clear the slot if we still own it — a remount can register a new controller before
 * the old body's effect cleanup runs, and a bare clear would null the LIVE
 * controller the new body just published.
 *
 * EDIT MODE (the cross-cutting edit/ capability rides this body):
 *  - the read↔edit state is a runtime COMPARTMENT reconfigure (setEditable), so the
 *    view is NOT torn down on a code toggle (scroll/find/IME survive);
 *  - the doc is seeded from editBufferText (the buffer if edited, else the pristine
 *    source) so a re-mount in either mode shows the edits;
 *  - an update listener writes edits into the temporary buffer (setEditBuffer) so the
 *    ORIGINAL source (content.code / content.html) is never mutated;
 *  - when editable AND there's an original baseline, the same compartment also adds
 *    the @codemirror/merge unifiedMergeView inline diff vs that original (the merge
 *    surface cm.ts keeps ready). A NEW file (no baseline) edits as a plain CM.
 *
 * READ mode = EditorState.readOnly (blocks edits) while the VIEW stays editable
 * (editable.of(true)), NOT EditorView.editable.of(false): editable:false sets
 * contentEditable=false, which suppresses drag-selection + CM's selection drawing,
 * so read mode would lose text selection/copy. readOnly is the CM-idiomatic read
 * surface — selection, highlight and copy work; only document mutation is blocked.
 */

import { React } from "@webpack/common";

import { clearLiveController, getLiveController, requestRender, setLiveController } from "../../engine/forceRender";
import { consumePendingScroll } from "../../engine/viewState";
import { getActiveWindow } from "../../engine/window";
import type { CodeViewState, CsvViewState, DockWindow, TreeViewState } from "../../engine/types";
import { editBufferText, editOriginalText, setEditBuffer } from "../../edit/editMode";
import { loadCM } from "./cm";
import type { CMModules } from "./cm";

// The live-controller slot name (the old `codeCtrl` module singleton).
export const CODE_CONTROLLER = "code";

/** The window's code view-state slice, created on demand. The VERY FIRST window is
 *  built at engine init BEFORE this viewer registers (the registry import that
 *  loads CodeViewer transitively evaluates window.ts, whose initial makeWindow runs
 *  with an empty viewer set), so that one window can lack the slice. Every window
 *  made at runtime already has it; this back-fills the init-order edge. */
export function codeState(win: DockWindow = getActiveWindow()): CodeViewState {
    let cv = win.viewStates[CODE_CONTROLLER] as CodeViewState | undefined;
    if (!cv) {
        cv = { findOpen: false, findQuery: "", findMatches: 0, findActive: 0, findCase: false };
        win.viewStates[CODE_CONTROLLER] = cv;
    }
    return cv;
}

// Highlight gating threshold. Files with FEWER than this many lines get the Lezer
// parser-based highlighter; files at/above it render as plain text in CM (no
// parser → no parse long-tasks), matching the old viewer's 0-long-task 50k
// profile. Tunable; the parser is the SOLE long-task source on huge files.
const HIGHLIGHT_MAX_LINES = 5000;

/** Whether the CM body for the CURRENT content should be EDITABLE on mount.
 *  - csv-raw: always editable (Raw IS the edit surface — Grid↔Raw is a body swap).
 *  - code: editable only in edit mode (Read↔Edit is one CM, flipped live).
 *  - markdown / html: the CM body only exists in edit mode, so editable.
 *  - structured-raw: READ-ONLY (it has no edit toggle, only the tree↔raw view swap),
 *    so it falls into the editView-mode branch and stays read (editView never enters
 *    edit for it). Parity with the monolith's cmEditableForContent.
 *  Read the sub-view mode straight off the window's csv view-state slice (no cross-
 *  viewer import: csv imports THIS module, so reaching back would loop). */
export function cmEditableForContent(win: DockWindow = getActiveWindow()): boolean {
    const t = win.content.type;
    if (t === "csv") return (win.viewStates["csv"] as CsvViewState | undefined)?.mode === "raw"; // raw = edit surface
    // code / markdown / html: editable exactly in edit mode. structured-raw never
    // enters edit mode, so it stays read-only here.
    return win.editView.mode === "edit";
}

/** Whether the CURRENT body is a CodeMirror editor (so find / Ctrl+F apply). True
 *  for plain code, a CSV/structured in raw mode, and markdown / html in edit mode. */
export function cmBodyShown(win: DockWindow = getActiveWindow()): boolean {
    const t = win.content.type;
    if (win.content.code == null && t !== "html") return false;
    if (t === "code") return true;
    if (t === "csv") return (win.viewStates["csv"] as CsvViewState | undefined)?.mode === "raw";
    if (t === "structured") return (win.viewStates["structured"] as TreeViewState | undefined)?.mode === "raw";
    if (t === "markdown" || t === "html") return win.editView.mode === "edit";
    return false;
}

/** The live code controller, backed by a CodeMirror EditorView. The header
 *  toolbar + find bar drive find / wrap / copy / scrollTo / read↔edit through it. */
export interface CodeController {
    seq: number;
    matches: { from: number; to: number }[]; // document offsets per match
    rebuildFind: (query: string) => void;
    focusMatch: (idx: number) => void;
    wrap: boolean; // live word-wrap state (default on — code never h-scrolls)
    toggleWrap: () => void; // flip wrapping via the compartment (no rebuild)
    setEditable: (on: boolean) => void; // flip read↔edit (+ diff) via the compartment
    insert: (text: string) => void; // type text at the doc end (drives the buffer)
    text: () => string; // the shown document text (for copy)
    scrollTo: (top: number) => void; // re-apply a saved scroll once mounted
    teardown: () => void;
}

/** Build a CM EditorView for the current text file and wire it to the shared find
 *  model. Word wrap is a runtime COMPARTMENT reconfigure (toggleWrap), so the view
 *  is NOT rebuilt on a toggle. The doc is seeded from editBufferText (the buffer if
 *  edited, else the pristine source); an update listener mirrors edits into the
 *  temporary buffer so the original source is never mutated. Read↔edit (plus the
 *  inline merge diff vs editOriginalText) is its OWN compartment — flipping it never
 *  rebuilds the view, so scroll/find/IME survive a code toggle. */
function buildCmController(host: HTMLElement, mods: CMModules): CodeController {
    const win = getActiveWindow();
    const cv = codeState(win);
    // Seed from the buffer (= edits if any, else the pristine source). For markdown
    // the source is the raw md (stored in content.code by the loader), for html/
    // .artifact it's the html source — editBufferText() resolves the right one.
    const code = editBufferText(win);
    // The highlight gate uses the file's natural language. Markdown source edits get
    // the markdown grammar; html source gets the html grammar.
    const lang = win.content.type === "html" ? "html" : win.content.codeLang;
    const startEditable = cmEditableForContent(win);

    // Line count for the highlight gate (same trailing-newline convention as the
    // old viewer: a single trailing newline is not its own line).
    const bodyText = code.endsWith("\n") ? code.slice(0, -1) : code;
    const lineCount = bodyText.length ? (bodyText.split("\n").length) : 1;
    const langSupport = lineCount < HIGHLIGHT_MAX_LINES ? mods.languageFor(lang) : null;

    // A compartment for line wrapping so the wrap toggle reconfigures it in place
    // rather than rebuilding the EditorView (preserves scroll + find state). Wrap
    // defaults ON (locked Discord grammar: code never horizontally scrolls); the
    // toggle lets a user drop to a single-line view for wide tabular text.
    let wrapped = true;
    const wrapCompartment = new mods.Compartment();
    const wrapExt = (on: boolean) => (on ? mods.EditorView.lineWrapping : []);

    // The pristine original = the unifiedMergeView baseline. NULL for a new file (no
    // original ever existed) → it edits as a plain CM with no diff. For an existing
    // file it's the loaded source (code/csv/markdown source, or the artifact html).
    // Captured once; the original never changes across the editor's life.
    const original = editOriginalText(win);

    // A compartment for editable/readOnly so the Read↔Edit toggle reconfigures it in
    // place (preserves scroll, find state, and the Korean IME composition surface).
    const editCompartment = new mods.Compartment();

    // unifiedMergeView's change-gutter (the colored per-line stripe) adds a SECOND
    // gutter inside .cm-gutters, ~3px wide. It only exists in EDIT mode (and only
    // when there's an original to diff against), so without compensation the divider
    // line between the line-number gutter and the code body would JUMP RIGHT by ~3px
    // when toggling read→edit (선인: "그 흰 줄이 움직여"). To keep the divider
    // PERFECTLY still, RESERVE the change-gutter's footprint as right-padding on
    // .cm-gutters whenever the real change-gutter is ABSENT (read mode, or a new
    // file's edit mode with no original). Padding sits inside the border-right, so
    // the divider x is identical in both modes.
    const CHANGE_GUTTER_RESERVE = "3px";
    const reserveGutterTheme = mods.EditorView.theme({
        ".cm-gutters": { paddingRight: CHANGE_GUTTER_RESERVE }
    });
    // The editable/readOnly state PLUS (when editable + there's an original) the
    // inline colored diff vs that original. Bundling the merge view into the SAME
    // compartment means the read↔edit toggle adds/removes the diff in step: read =
    // no diff (just the read-only source); edit = the live diff. A new file
    // (original==null) never gets the diff. unifiedMergeView highlights ranges where
    // the editor doc differs from `original`; when they're equal (no edits yet) it
    // shows nothing — a clean editor.
    const editableExt = (on: boolean) => {
        const base = [
            mods.EditorView.editable.of(true),
            mods.EditorState.readOnly.of(!on)
        ];
        if (on && original != null) {
            base.push(mods.unifiedMergeView({
                original,
                // hide the per-chunk accept/reject buttons — heavy on a narrow side
                // panel; the colored add/change/delete display is the point.
                mergeControls: false,
                // keep the change-gutter stripe (a thin colored marker per changed
                // line) — it's a quiet locator, not noise.
                gutter: true,
                highlightChanges: true,
                // a fragment-only original can mis-highlight deleted lines under the
                // editor language; off is safer + lighter.
                syntaxHighlightDeletions: false
            }));
        } else {
            // No real change-gutter here → reserve its width so the gutter/body
            // divider stays at the SAME x as edit mode (no shift on toggle).
            base.push(reserveGutterTheme);
        }
        return base;
    };

    // Push edits into the temporary buffer (never the original). Only real document
    // changes count, so a pure selection/scroll dispatch doesn't churn the buffer.
    const editListener = mods.EditorView.updateListener.of((u: any) => {
        if (u.docChanged) setEditBuffer(u.state.doc.toString(), win);
    });

    const extensions: any[] = [
        mods.lineNumbers(), // GitHub/VS-Code-style line-number gutter
        editCompartment.of(editableExt(startEditable)), // read↔edit (+ diff)
        editListener, // edits -> temporary buffer
        wrapCompartment.of(wrapExt(wrapped)),
        mods.theme,
        mods.mergeTheme, // diff colours (added/changed green, deleted red)
        mods.findField
    ];
    if (langSupport) {
        // gated ON: parser-based syntax highlighting (Lezer). The parser is the
        // SOLE long-task source on huge files, so it's only added under the gate.
        extensions.push(langSupport, mods.syntaxHighlighting(mods.highlightStyle));
    }

    const state = mods.EditorState.create({ doc: code, extensions });
    const view = new mods.EditorView({ state, parent: host });

    const ctrl: CodeController = {
        seq: win.content.seq,
        matches: [],
        rebuildFind: () => { /* set below */ },
        focusMatch: () => { /* set below */ },
        wrap: wrapped,
        toggleWrap: () => {
            wrapped = !wrapped;
            ctrl.wrap = wrapped;
            view.dispatch({ effects: wrapCompartment.reconfigure(wrapExt(wrapped)) });
            requestRender(); // repaint the toolbar's active state
        },
        setEditable: (on: boolean) => {
            view.dispatch({ effects: editCompartment.reconfigure(editableExt(on)) });
            if (on) view.focus();
        },
        // Insert text at the document end via a real CM transaction (drives an edit
        // through the same path a keystroke takes — the update listener then mirrors
        // it into the temporary buffer). Used by the CDP harness.
        insert: (text: string) => {
            const at = view.state.doc.length;
            view.dispatch({ changes: { from: at, insert: text } });
        },
        text: () => view.state.doc.toString(),
        scrollTo: (top: number) => { const sc = view.scrollDOM; if (sc) sc.scrollTop = top; },
        teardown: () => { /* set below */ }
    };

    const pushDeco = () => {
        const activeIdx = cv.findActive - 1;
        const ranges = ctrl.matches.map((m, i) => ({ from: m.from, to: m.to, active: i === activeIdx }));
        view.dispatch({ effects: mods.setFindEffect.of(ranges) });
    };

    ctrl.rebuildFind = (query: string) => {
        ctrl.matches = [];
        cv.findMatches = 0;
        cv.findActive = 0;
        if (!query) { pushDeco(); requestRender(); return; }
        // SearchCursor over the whole doc. caseInsensitive normalises both sides.
        const cur = cv.findCase
            ? new mods.SearchCursor(view.state.doc, query)
            : new mods.SearchCursor(view.state.doc, query, 0, view.state.doc.length,
                (s: string) => s.toLowerCase());
        while (!cur.next().done) {
            ctrl.matches.push({ from: cur.value.from, to: cur.value.to });
        }
        cv.findMatches = ctrl.matches.length;
        cv.findActive = ctrl.matches.length ? 1 : 0;
        pushDeco();
        if (ctrl.matches.length) ctrl.focusMatch(0);
        else requestRender();
    };

    ctrl.focusMatch = (idx: number) => {
        const m = ctrl.matches[idx];
        if (!m) return;
        cv.findActive = idx + 1;
        pushDeco();
        // scroll the active match into the centre of the viewport.
        view.dispatch({
            effects: mods.EditorView.scrollIntoView(m.from, { y: "center" })
        });
        requestRender();
    };

    ctrl.teardown = () => {
        try { view.destroy(); } catch { /* ignore */ }
    };

    setLiveController(CODE_CONTROLLER, ctrl);
    return ctrl;
}

/** The CODE/TEXT body. Keyed on content.seq by the dispatcher; the effect builds
 *  the EditorView once CM's modules resolve, then restores any open find (a cache
 *  return) or the saved scroll. */
export function CodeBody() {
    const { useRef, useEffect } = React;
    const hostRef = useRef(null as HTMLElement | null);
    const seq = getActiveWindow().content.seq;
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        let ctrl: CodeController | null = null;
        let cancelled = false;
        loadCM().then(mods => {
            if (cancelled || !host.isConnected) return;
            ctrl = buildCmController(host, mods);
            // restore find if it was open for this file (a cache return), else
            // restore the saved scroll once the editor exists.
            const cv = codeState(getActiveWindow());
            if (cv.findOpen && cv.findQuery) ctrl.rebuildFind(cv.findQuery);
            else consumePendingScroll(getActiveWindow());
        });
        return () => {
            cancelled = true;
            ctrl?.teardown();
            // UNMOUNT GUARD: only clear the slot if it's still ours (a remount may
            // have already published a new controller — don't null the live one).
            if (ctrl) clearLiveController(CODE_CONTROLLER, ctrl);
        };
    }, [seq]);
    return React.createElement("div", {
        key: seq,
        ref: hostRef,
        className: "dockview-cm",
        // focusable so a click into the code body gives the panel keyboard focus —
        // Ctrl+F / find keys are gated on that focus (never on hover). CM's own
        // content is focusable too; this wraps it for the gate.
        tabIndex: 0
    });
}

/** Read the live code controller (header + find bar reach for it). */
export function codeController(): CodeController | null {
    return getLiveController<CodeController>(CODE_CONTROLLER);
}
