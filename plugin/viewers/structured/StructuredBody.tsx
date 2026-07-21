/*
 * The STRUCTURED (JSON / XML) tree body — an imperative collapsible tree.
 *
 * A .json/.json5/.xml file renders as an interactive collapsible tree (the default),
 * with a header Tree/Raw toggle back to the highlighted code view. The tree is built
 * IMPERATIVELY (a few-thousand-node React tree would be pathological), keyed on
 * content.seq, exactly like CsvBody/CodeBody. Each branch node (object/array/element)
 * renders a clickable disclosure row that expands/collapses its children on click
 * (event delegation off the scroll wrap). If the text can't be parsed, the body
 * auto-falls-back to the raw code view (and remembers it so the toggle reads right).
 *
 * JSON goes through JSON.parse, with a tiny tolerant pre-clean retry for the trivial
 * JSON5-ish cases (trailing commas, // and /* *​/ comments); XML goes through
 * DOMParser. Anything that still fails falls back to Raw.
 *
 * No module-top work: only imports + the helper/component declarations. React and
 * the active window are read at call time inside the component.
 */

import { React } from "@webpack/common";

import { escapeHtml } from "../../engine/html";
import { consumePendingScroll } from "../../engine/viewState";
import { getActiveWindow } from "../../engine/window";
import { requestRender } from "../../engine/forceRender";
import type { DockWindow, TreeViewState } from "../../engine/types";

const TREE_MAX_NODES = 60000; // hard cap so a pathological doc can't explode the DOM

/** The window's tree view-state slice, created on demand (the init-order edge can
 *  leave the first window without it; this back-fills). */
export function treeState(win: DockWindow = getActiveWindow()): TreeViewState {
    let tv = win.viewStates["structured"] as TreeViewState | undefined;
    if (!tv) {
        tv = { mode: "tree", kind: "json" };
        win.viewStates["structured"] = tv;
    }
    return tv;
}

/** The tree controller — only a teardown handle for the delegated click listener. */
interface TreeController {
    seq: number;
    teardown: () => void;
}
let treeCtrl: TreeController | null = null;

/** HTML-escape a JSON string value WITH its quotes for display. */
function treeQuote(s: string): string {
    return '"' + escapeHtml(s) + '"';
}

/** Build the collapsible tree DOM for a parsed JSON value into `mount`. Returns the
 *  node count built (for the cap). Objects/arrays are disclosure rows with a count
 *  badge; their children sit in a nested container toggled by the row's click. */
function buildJsonTree(value: any, mount: HTMLElement): number {
    let count = 0;
    const overflow = { hit: false };

    // Render one entry (optionally key-prefixed) into `parent`. Branches recurse.
    const render = (parent: HTMLElement, keyLabel: string | null, val: any, depth: number) => {
        if (count >= TREE_MAX_NODES) { overflow.hit = true; return; }
        count++;
        const isArr = Array.isArray(val);
        const isObj = val !== null && typeof val === "object" && !isArr;
        const row = document.createElement("div");
        row.className = "dv-tree-row";

        const keyHtml = keyLabel != null ? `<span class="dv-tree-key">${escapeHtml(keyLabel)}</span><span class="dv-tree-colon">: </span>` : "";

        if (isArr || isObj) {
            const entries: [string | null, any][] = isArr
                ? (val as any[]).map((v, i) => [String(i), v] as [string, any])
                : Object.keys(val).map(k => [k, val[k]] as [string, any]);
            const open = isArr ? "[" : "{";
            const close = isArr ? "]" : "}";
            const n = entries.length;
            const summary = n === 0
                ? `<span class="dv-tree-punct">${open}${close}</span>`
                : `<span class="dv-tree-toggle">▾</span><span class="dv-tree-punct">${open}</span><span class="dv-tree-count">${n} ${n === 1 ? "item" : "items"}</span>`;
            row.innerHTML = `${keyHtml}${summary}`;
            row.classList.add("dv-tree-branch");
            parent.appendChild(row);
            if (n === 0) return;

            const childWrap = document.createElement("div");
            childWrap.className = "dv-tree-children";
            for (const [k, v] of entries) render(childWrap, k, v, depth + 1);
            // closing bracket on its own row (aligned with the parent)
            const closeRow = document.createElement("div");
            closeRow.className = "dv-tree-close";
            closeRow.innerHTML = `<span class="dv-tree-punct">${close}</span>`;
            parent.appendChild(childWrap);
            parent.appendChild(closeRow);
            // wire toggle: clicking the branch row hides/shows its children + close.
            row.classList.add("dv-tree-clickable");
            (row as any)._dvToggle = () => {
                const collapsed = childWrap.classList.toggle("dv-collapsed");
                closeRow.classList.toggle("dv-collapsed", collapsed);
                const tg = row.querySelector(".dv-tree-toggle");
                if (tg) tg.textContent = collapsed ? "▸" : "▾";
                if (collapsed) {
                    const badge = document.createElement("span");
                    badge.className = "dv-tree-ellipsis";
                    badge.textContent = "…";
                    if (!row.querySelector(".dv-tree-ellipsis")) row.appendChild(badge);
                } else {
                    row.querySelector(".dv-tree-ellipsis")?.remove();
                }
            };
        } else {
            // leaf: type-coloured value.
            let cls = "dv-tree-null", text = "null";
            if (typeof val === "string") { cls = "dv-tree-string"; text = treeQuote(val); }
            else if (typeof val === "number") { cls = "dv-tree-number"; text = escapeHtml(String(val)); }
            else if (typeof val === "boolean") { cls = "dv-tree-boolean"; text = String(val); }
            else if (val === null) { cls = "dv-tree-null"; text = "null"; }
            row.innerHTML = `${keyHtml}<span class="${cls}">${text}</span>`;
            row.classList.add("dv-tree-leaf");
            parent.appendChild(row);
        }
    };

    render(mount, null, value, 0);
    if (overflow.hit) {
        const more = document.createElement("div");
        more.className = "dv-tree-row dv-tree-overflow";
        more.textContent = `… tree truncated at ${TREE_MAX_NODES} nodes (use Raw to see the rest)`;
        mount.appendChild(more);
    }
    return count;
}

/** Build the collapsible tree DOM for an XML element into `mount`. Elements are
 *  disclosure rows (<tag attrs>) whose children (sub-elements + text) sit in a nested
 *  container; clicking the row toggles them. Mirrors buildJsonTree's interaction. */
function buildXmlTree(node: Node, mount: HTMLElement): number {
    let count = 0;
    const overflow = { hit: false };

    const renderEl = (parent: HTMLElement, el: Element, depth: number) => {
        if (count >= TREE_MAX_NODES) { overflow.hit = true; return; }
        count++;
        // collect renderable children: element nodes + non-whitespace text.
        const kids: Node[] = [];
        el.childNodes.forEach(c => {
            if (c.nodeType === 1) kids.push(c);
            else if (c.nodeType === 3 && (c.textContent || "").trim().length) kids.push(c);
        });
        const attrs = Array.from(el.attributes || [])
            .map(a => ` <span class="dv-tree-key">${escapeHtml(a.name)}</span>=<span class="dv-tree-string">${treeQuote(a.value)}</span>`)
            .join("");
        const tag = escapeHtml(el.tagName);

        const row = document.createElement("div");
        row.className = "dv-tree-row dv-tree-branch";

        // a single text child renders inline (<tag>value</tag>), no disclosure.
        if (kids.length === 1 && kids[0].nodeType === 3) {
            const txt = escapeHtml((kids[0].textContent || "").trim());
            row.innerHTML = `<span class="dv-tree-punct">&lt;</span><span class="dv-tree-tag">${tag}</span>${attrs}<span class="dv-tree-punct">&gt;</span><span class="dv-tree-xmltext">${txt}</span><span class="dv-tree-punct">&lt;/</span><span class="dv-tree-tag">${tag}</span><span class="dv-tree-punct">&gt;</span>`;
            parent.appendChild(row);
            return;
        }
        if (kids.length === 0) {
            row.innerHTML = `<span class="dv-tree-punct">&lt;</span><span class="dv-tree-tag">${tag}</span>${attrs}<span class="dv-tree-punct"> /&gt;</span>`;
            parent.appendChild(row);
            return;
        }
        row.innerHTML = `<span class="dv-tree-toggle">▾</span><span class="dv-tree-punct">&lt;</span><span class="dv-tree-tag">${tag}</span>${attrs}<span class="dv-tree-punct">&gt;</span>`;
        row.classList.add("dv-tree-clickable");
        parent.appendChild(row);

        const childWrap = document.createElement("div");
        childWrap.className = "dv-tree-children";
        for (const k of kids) {
            if (k.nodeType === 1) renderEl(childWrap, k as Element, depth + 1);
            else {
                if (count >= TREE_MAX_NODES) { overflow.hit = true; break; }
                count++;
                const t = document.createElement("div");
                t.className = "dv-tree-row dv-tree-leaf";
                t.innerHTML = `<span class="dv-tree-xmltext">${escapeHtml((k.textContent || "").trim())}</span>`;
                childWrap.appendChild(t);
            }
        }
        const closeRow = document.createElement("div");
        closeRow.className = "dv-tree-close";
        closeRow.innerHTML = `<span class="dv-tree-punct">&lt;/</span><span class="dv-tree-tag">${tag}</span><span class="dv-tree-punct">&gt;</span>`;
        parent.appendChild(childWrap);
        parent.appendChild(closeRow);
        (row as any)._dvToggle = () => {
            const collapsed = childWrap.classList.toggle("dv-collapsed");
            closeRow.classList.toggle("dv-collapsed", collapsed);
            const tg = row.querySelector(".dv-tree-toggle");
            if (tg) tg.textContent = collapsed ? "▸" : "▾";
        };
    };

    if (node.nodeType === 1) renderEl(mount, node as Element, 0);
    if (overflow.hit) {
        const more = document.createElement("div");
        more.className = "dv-tree-row dv-tree-overflow";
        more.textContent = `… tree truncated at ${TREE_MAX_NODES} nodes (use Raw to see the rest)`;
        mount.appendChild(more);
    }
    return count;
}

/** A tiny best-effort JSON5→JSON cleaner for the trivial cases (tolerate JSON5 if
 *  trivial, else fall back to Raw): strip // and /* *​/ comments and trailing
 *  commas. We DON'T attempt single-quote or unquoted-key rewriting (too error-prone)
 *  — those fall back to Raw. Strings are preserved (the comment strip skips content
 *  inside double-quoted strings). */
function looseJsonClean(text: string): string {
    let out = "";
    let inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i], n = text[i + 1];
        if (inStr) {
            out += c;
            if (esc) esc = false;
            else if (c === "\\") esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; out += c; continue; }
        if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
        if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
        out += c;
    }
    // strip trailing commas before } or ]
    return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Build the tree DOM into `mount` for the current structured file. Returns true on
 *  success, false if the text couldn't be parsed (caller falls back to Raw). */
function buildStructuredTree(mount: HTMLElement): boolean {
    const win = getActiveWindow();
    const text = win.content.code || "";
    if (treeState(win).kind === "xml") {
        try {
            const doc = new DOMParser().parseFromString(text, "application/xml");
            // a parsererror element means malformed XML.
            if (doc.querySelector("parsererror")) return false;
            const root = doc.documentElement;
            if (!root) return false;
            buildXmlTree(root, mount);
            return true;
        } catch {
            return false;
        }
    }
    // json / json5: try strict JSON.parse first. (JSON5 isn't bundled; for the common
    // JSON5-ish cases — trailing commas, // comments — we do a tiny tolerant pre-clean
    // and retry. Anything that still fails falls back to Raw.)
    let val: any;
    try {
        val = JSON.parse(text);
    } catch {
        try {
            val = JSON.parse(looseJsonClean(text));
        } catch {
            return false;
        }
    }
    buildJsonTree(val, mount);
    return true;
}

/** The STRUCTURED tree body: an imperatively-built collapsible tree inside a
 *  scrollable column, keyed on content.seq so a new file (or a raw->tree toggle)
 *  remounts it fresh. A click on a branch row toggles its children (event
 *  delegation). If the parse fails, auto-fall back to the raw code view. */
export function StructuredBody() {
    const { useRef, useEffect } = React;
    const mountRef = useRef(null as HTMLElement | null);
    const seq = getActiveWindow().content.seq;
    useEffect(() => {
        const m = mountRef.current;
        if (!m) return;
        const ok = buildStructuredTree(m);
        if (!ok) {
            // unparseable: drop into the raw code view (and remember it so the toggle
            // shows the right state). A microtask defer avoids a setState-in-render.
            treeState(getActiveWindow()).mode = "raw";
            Promise.resolve().then(() => { getActiveWindow().content.seq += 1; requestRender(); });
            return;
        }
        const onClick = (e: MouseEvent) => {
            let el = e.target as HTMLElement | null;
            for (let i = 0; i < 6 && el && el !== m; i++) {
                if (el.classList.contains("dv-tree-clickable")) {
                    (el as any)._dvToggle?.();
                    return;
                }
                el = el.parentElement;
            }
        };
        m.addEventListener("click", onClick);
        const ctrl: TreeController = { seq: getActiveWindow().content.seq, teardown: () => m.removeEventListener("click", onClick) };
        treeCtrl = ctrl;
        consumePendingScroll(getActiveWindow());
        return () => {
            ctrl.teardown();
            // UNMOUNT GUARD: only clear the slot if it's still ours (a remount may
            // have already published a new controller).
            if (treeCtrl === ctrl) treeCtrl = null;
        };
    }, [seq]);
    return React.createElement(
        "div",
        {
            key: seq,
            className: "dockview-tree-scroll",
            // focusable so a click into the tree gives the panel keyboard focus.
            tabIndex: 0
        },
        React.createElement("div", { ref: mountRef, className: "dockview-tree-mount" })
    );
}
