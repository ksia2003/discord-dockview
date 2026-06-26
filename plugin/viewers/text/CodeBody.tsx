/*
 * The CODE / TEXT body — a read-only CodeMirror 6 editor.
 *
 * CM is lazy-loaded on the first text-file open (cm.ts/loadCM). React mounts an
 * empty host and the effect builds the EditorView once the modules resolve, keyed
 * on content.seq so a new file remounts fresh. While CM loads (a beat on the very
 * first open) the body shows nothing — the modules resolve a few ms after the
 * import warms.
 *
 * The body publishes its imperative controller into the forceRender "code" live-
 * controller slot (find / wrap / copy / scrollTo); the header toolbar + the find
 * bar read it back. UNMOUNT GUARD (load-bearing): on teardown we only clear the
 * slot if we still own it — a remount can register a new controller before the old
 * body's effect cleanup runs, and a bare clear would null the LIVE controller the
 * new body just published.
 *
 * VIEW MODE only this phase: the editor is read-only (EditorState.readOnly), so
 * selection + highlight + copy work while document mutation is blocked. Edit-mode
 * (the temporary buffer + the merge-diff baseline) is the cross-cutting edit/
 * concern that lands in P8; the merge surface assembled in cm.ts is left ready for
 * it but unused here.
 */

import { React } from "@webpack/common";

import { clearLiveController, getLiveController, requestRender, setLiveController } from "../../engine/forceRender";
import { consumePendingScroll } from "../../engine/viewState";
import { getActiveWindow } from "../../engine/window";
import type { CodeViewState, DockWindow } from "../../engine/types";
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

/** The live code controller, backed by a CodeMirror EditorView. The header
 *  toolbar + find bar drive find / wrap / copy / scrollTo through this surface. */
export interface CodeController {
    seq: number;
    matches: { from: number; to: number }[]; // document offsets per match
    rebuildFind: (query: string) => void;
    focusMatch: (idx: number) => void;
    wrap: boolean; // live word-wrap state (default on — code never h-scrolls)
    toggleWrap: () => void; // flip wrapping via the compartment (no rebuild)
    text: () => string; // the shown document text (for copy)
    scrollTo: (top: number) => void; // re-apply a saved scroll once mounted
    teardown: () => void;
}

/** Build a read-only CM EditorView for the current text file and wire it to the
 *  shared find model. Word wrap is a runtime COMPARTMENT reconfigure (toggleWrap),
 *  so the view is NOT rebuilt on a toggle. The doc is seeded straight from
 *  content.code (view mode = the pristine source; edit-mode's buffer lands P8). */
function buildCmController(host: HTMLElement, mods: CMModules): CodeController {
    const win = getActiveWindow();
    const cv = codeState(win);
    const code = win.content.code ?? "";
    const lang = win.content.codeLang;

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

    const extensions: any[] = [
        mods.lineNumbers(), // GitHub/VS-Code-style line-number gutter
        // READ mode = EditorState.readOnly (blocks edits) while the VIEW stays
        // editable (editable.of(true)), NOT EditorView.editable.of(false).
        // editable:false sets contentEditable=false, which suppresses drag-selection
        // and CM's selection drawing — so read mode would lose text selection/copy.
        // readOnly is the CM-idiomatic read surface: selection, highlight and copy
        // all work; only document mutation is blocked.
        mods.EditorView.editable.of(true),
        mods.EditorState.readOnly.of(true),
        wrapCompartment.of(wrapExt(wrapped)),
        mods.theme,
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
