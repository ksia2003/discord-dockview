/*
 * The reusable floating find bar.
 *
 * A browser-style Ctrl+F box anchored top-right over the body: a text input with a
 * live cur/total counter, a case toggle (Aa), prev/next, and a divided-off close.
 * It is fully driven by a FindBarModel (engine/types.ts) — the component owns no
 * find state; whichever viewer is active supplies the model (query/matches/active/
 * case + the setQuery/next/prev/toggleCase/close verbs). PDF and every CodeMirror
 * surface share this one component.
 *
 * A find-capable viewer supplies the model via its findModel() ONLY while its find
 * bar is open (PDF + every CodeMirror surface do); DockPanel renders nothing in the
 * find slot otherwise. The bar is opened by the magnifier button OR Ctrl+F (each
 * viewer's body wires that keyboard shortcut to the same toggle).
 */

import { React } from "@webpack/common";

import { STRINGS } from "../strings";
import type { FindBarModel } from "../engine/types";
import { toolBtn } from "./toolbar";

export function FindBar({ model }: { model: FindBarModel }) {
    const { useRef, useEffect } = React;
    const inputRef = useRef(null as HTMLInputElement | null);
    // focus the input when the bar opens
    useEffect(() => { inputRef.current?.focus(); }, []);
    const counter = model.matches > 0
        ? `${model.active}/${model.matches}`
        : (model.query ? "0/0" : "");
    // Browser/VS Code look: the query input holds the cur/total counter pinned at
    // its right edge (a `.dockview-find-field` wrapper), then a trailing control
    // cluster (Aa case · prev · next) and a divided-off close.
    return React.createElement(
        "div",
        { className: "dockview-find" },
        React.createElement(
            "div",
            { className: "dockview-find-field" },
            React.createElement("input", {
                ref: inputRef,
                className: "dockview-find-input",
                type: "text",
                placeholder: model.placeholder,
                "aria-label": model.placeholder,
                value: model.query,
                onChange: (e: any) => model.setQuery(e.target.value),
                onKeyDown: (e: any) => {
                    e.stopPropagation();
                    if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) model.prev(); else model.next(); }
                    else if (e.key === "Escape") { e.preventDefault(); model.close(); }
                }
            }),
            React.createElement("span", { className: "dockview-find-count" }, counter)
        ),
        React.createElement(
            "div",
            { className: "dockview-find-actions" },
            // Case-sensitivity toggle (default off). Text "Aa" rather than an icon —
            // the universal find-bar convention (browsers, VS Code, Acrobat).
            React.createElement("button", {
                key: "find-case",
                type: "button",
                className: "dockview-tool-btn dockview-find-case" + (model.caseSensitive ? " dockview-tool-btn-active" : ""),
                "aria-label": STRINGS.find.matchCase,
                "aria-pressed": model.caseSensitive,
                title: STRINGS.find.matchCase,
                onMouseDown: (e: any) => e.preventDefault(), // keep focus in the input
                onClick: () => model.toggleCase()
            }, "Aa"),
            toolBtn("find-prev", STRINGS.find.prevMatch,
                "M15.3 5.3a1 1 0 0 1 0 1.4L10 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0Z",
                () => model.prev()),
            toolBtn("find-next", STRINGS.find.nextMatch,
                "M8.7 5.3a1 1 0 0 0 0 1.4L14 12l-5.3 5.3a1 1 0 0 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z",
                () => model.next()),
            // a hairline divides the match-nav cluster from the close, like a browser
            React.createElement("span", { key: "find-sep", className: "dockview-find-sep" }),
            toolBtn("find-close", STRINGS.find.close,
                "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z",
                () => model.close())
        )
    );
}
