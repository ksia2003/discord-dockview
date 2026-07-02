/*
 * Embedded workbook CHARTS — extract + parse the DrawingML charts SheetJS ignores.
 *
 * An .xlsx is a zip. SheetJS reads the cell data but throws the charts away, so the
 * chart definitions (bar/line/pie/…) never reach the grid. They live in the zip as
 * xl/charts/chartN.xml (DrawingML), anchored onto a sheet through a two-hop rel chain:
 *
 *   xl/worksheets/sheetK.xml            (the sheet, in workbook order)
 *     └ xl/worksheets/_rels/sheetK.xml.rels   r:id → xl/drawings/drawingM.xml
 *          └ xl/drawings/drawingM.xml          each anchor's <c:chart r:id="rIdN">
 *               └ xl/drawings/_rels/drawingM.xml.rels  rIdN → xl/charts/chartN.xml
 *
 * We reproduce that chain to map every chart to its host sheet index, then parse the
 * common plot types out of each chart XML. Per series (c:ser) we read the series name,
 * the category axis strings, and the numeric values — preferring the embedded caches
 * (strCache / numCache) DrawingML always writes, and only falling back to resolving the
 * c:f formula range against the already-parsed CSV when a cache is missing.
 *
 * This module is PURE (no DOM node creation beyond DOMParser, no React, no webpack) so
 * its top level is free of the module-top-webpack ban. The heavy zip lib (fflate) is a
 * dynamic import behind the caller's loading path; the parse itself only runs when the
 * zip's central directory actually names an xl/charts/ entry (hasCharts), so a chart-
 * free workbook pays only a cheap directory scan.
 */

/** One parsed chart series: a name + parallel category / value arrays. */
export interface ChartSeries {
    name: string;
    /** category labels (x axis / pie slice labels). May be shorter than values. */
    cats: string[];
    /** numeric values; NaN for a blank/non-numeric cell (drawn as a gap). */
    values: number[];
}

/** A chart we can draw. `kind` picks the SVG renderer; `series` carry the data. */
export interface SupportedChart {
    supported: true;
    kind: "bar" | "column" | "line" | "area" | "pie" | "doughnut" | "scatter";
    title: string;
    series: ChartSeries[];
    /** true when the plot stacks series (barChart/areaChart grouping="stacked"). */
    stacked: boolean;
}

/** A chart type we recognise but do not render — shown as an honest fallback card
 *  naming the type, never a silent drop or a broken render. */
export interface UnsupportedChart {
    supported: false;
    title: string;
    /** a human label for the type, e.g. "Radar chart", "3D bar chart". */
    typeLabel: string;
}

export type ChartModel = SupportedChart | UnsupportedChart;

/** All charts anchored to one sheet, in the sheet's drawing order. */
export type SheetCharts = ChartModel[];

// ── zip / xml helpers ────────────────────────────────────────────────────────

/** DrawingML / worksheet-rels namespaces are declared per file but the local names
 *  are stable, so we match by localName and ignore prefixes (getElementsByTagName
 *  with a "*" wildcard reads across whatever prefix the writer chose). */
function els(parent: Element | Document, local: string): Element[] {
    // "*"-namespace lookup then filter by localName — robust to c: / a: / cdr: prefixes.
    const out: Element[] = [];
    const all = parent.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
        if (all[i].localName === local) out.push(all[i]);
    }
    return out;
}

/** Direct ELEMENT children (nodeType 1) — via childNodes (not .children) so the parser
 *  runs the same under a minimal XML DOM as in the browser. */
function elementChildren(parent: Element): Element[] {
    const out: Element[] = [];
    const kids = parent.childNodes;
    for (let i = 0; i < kids.length; i++) {
        const n = kids[i] as Node;
        if (n.nodeType === 1) out.push(n as Element);
    }
    return out;
}

/** Direct children matching a local name (not descendants) — used where a wrapper's
 *  own <c:val> must not be confused with a nested one. */
function childEls(parent: Element, local: string): Element[] {
    return elementChildren(parent).filter(c => c.localName === local);
}

/** The first descendant with a local name, or null. */
function firstEl(parent: Element | Document, local: string): Element | null {
    return els(parent, local)[0] ?? null;
}

function parseXml(text: string): Document | null {
    try {
        const doc = new DOMParser().parseFromString(text, "application/xml");
        // A parse error yields a <parsererror> document rather than throwing.
        if (doc.getElementsByTagName("parsererror").length) return null;
        return doc;
    } catch {
        return null;
    }
}

// ── rel-chain resolution ─────────────────────────────────────────────────────

/** Read an OPC .rels file into { rId → target path }. Targets are resolved relative
 *  to the part the rels belong to (base dir), so "../charts/chart1.xml" from
 *  xl/drawings/_rels resolves to xl/charts/chart1.xml. */
function parseRels(text: string, baseDir: string): Record<string, string> {
    const doc = parseXml(text);
    const map: Record<string, string> = {};
    if (!doc) return map;
    for (const rel of els(doc, "Relationship")) {
        const id = rel.getAttribute("Id");
        const target = rel.getAttribute("Target");
        if (!id || !target) continue;
        // Ignore external targets (TargetMode="External") — a chart part is internal.
        if (rel.getAttribute("TargetMode") === "External") continue;
        map[id] = resolvePath(baseDir, target);
    }
    return map;
}

/** Resolve a possibly-relative OPC target against a base directory, collapsing
 *  "./" and "../" segments. An absolute "/xl/…" target drops the leading slash. */
function resolvePath(baseDir: string, target: string): string {
    if (target.startsWith("/")) return target.slice(1);
    const parts = (baseDir ? baseDir.split("/") : []).filter(Boolean);
    for (const seg of target.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
    }
    return parts.join("/");
}

function dirOf(path: string): string {
    const i = path.lastIndexOf("/");
    return i >= 0 ? path.slice(0, i) : "";
}

/** The rels path for a part: dir/_rels/name.rels. */
function relsPathFor(part: string): string {
    const dir = dirOf(part);
    const name = part.slice(dir ? dir.length + 1 : 0);
    return (dir ? dir + "/" : "") + "_rels/" + name + ".rels";
}

// ── workbook sheet order (sheetK.xml ↔ workbook index) ───────────────────────

/** Map each worksheet PART path to its 0-based workbook order index, so a chart on a
 *  given sheet part lands on the right tab. workbook.xml lists sheets in order with an
 *  r:id; workbook.xml.rels maps that r:id → the sheetK.xml part. */
function sheetPartOrder(files: Record<string, Uint8Array>, decode: (u: Uint8Array) => string): Map<string, number> {
    const order = new Map<string, number>();
    const wbBytes = files["xl/workbook.xml"];
    const relBytes = files["xl/_rels/workbook.xml.rels"];
    if (!wbBytes || !relBytes) return order;
    const wbDoc = parseXml(decode(wbBytes));
    if (!wbDoc) return order;
    const rels = parseRels(decode(relBytes), "xl");
    let idx = 0;
    for (const sheet of els(wbDoc, "sheet")) {
        // the r:id attribute (namespaced), read by localName-insensitive scan.
        let rId: string | null = null;
        for (let i = 0; i < sheet.attributes.length; i++) {
            const a = sheet.attributes[i];
            if (a.localName === "id") { rId = a.value; break; }
        }
        const part = rId ? rels[rId] : undefined;
        if (part) order.set(part, idx);
        idx++;
    }
    return order;
}

// ── chart XML parsing ────────────────────────────────────────────────────────

/** Read the text of a strRef/numRef cache (strCache/numCache) as an ordered array by
 *  the <c:pt idx="…"> index, padding gaps so parallel cat/val arrays stay aligned. */
function readCache(ref: Element | null): { text: string[]; nums: number[] } {
    const text: string[] = [];
    const nums: number[] = [];
    if (!ref) return { text, nums };
    // strCache OR numCache under the ref; each has <c:pt idx><c:v>value</c:v></c:pt>.
    const cache = firstEl(ref, "strCache") || firstEl(ref, "numCache");
    if (!cache) return { text, nums };
    for (const pt of els(cache, "pt")) {
        const idx = Number(pt.getAttribute("idx"));
        const v = firstEl(pt, "v");
        const raw = v ? (v.textContent ?? "") : "";
        const at = Number.isFinite(idx) ? idx : text.length;
        text[at] = raw;
        nums[at] = raw === "" ? NaN : Number(raw);
    }
    // Fill holes so the array length is contiguous (a missing pt → "" / NaN).
    for (let i = 0; i < text.length; i++) { if (text[i] === undefined) text[i] = ""; }
    for (let i = 0; i < nums.length; i++) { if (nums[i] === undefined) nums[i] = NaN; }
    return { text, nums };
}

/** A1 range → the [r,c] cell coords it spans (0-based, sheet origin), used to pull a
 *  value/label out of the parsed CSV when a chart cache is missing. Handles a single
 *  cell, a row range, or a column range. Returns null for anything cross-2D or unparsable
 *  (we only resolve simple 1-D series ranges as a fallback). */
function rangeCells(a1: string): { r: number; c: number }[] | null {
    // Strip a leading sheet ref ("Sheet1!$A$1:$A$5" → "$A$1:$A$5").
    const bang = a1.lastIndexOf("!");
    const body = (bang >= 0 ? a1.slice(bang + 1) : a1).replace(/\$/g, "");
    const m = body.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
    if (!m) return null;
    const c0 = colToIdx(m[1]); const r0 = Number(m[2]) - 1;
    const c1 = m[3] ? colToIdx(m[3]) : c0; const r1 = m[4] ? Number(m[4]) - 1 : r0;
    const cells: { r: number; c: number }[] = [];
    if (r0 === r1) { for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) cells.push({ r: r0, c }); }
    else if (c0 === c1) { for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) cells.push({ r, c: c0 }); }
    else return null; // a 2-D block isn't a single series
    return cells;
}

function colToIdx(col: string): number {
    let n = 0;
    for (let i = 0; i < col.length; i++) n = n * 26 + (col.toUpperCase().charCodeAt(i) - 64);
    return n - 1;
}

/** Resolves a formula's referenced sheet name (or null for the host sheet) to that
 *  sheet's parsed CSV matrix — so a chart whose data lives on a DIFFERENT sheet than it
 *  is anchored to still resolves. Returns null when the sheet isn't parsed. */
export type MatrixResolver = (sheetName: string | null) => string[][] | null;

/** The sheet name a formula names ("'Sales'!$A$2" → "Sales"), or null when unqualified.
 *  Handles the single-quote form (quotes stripped, "''" un-escaped). */
function sheetNameOf(a1: string): string | null {
    const bang = a1.lastIndexOf("!");
    if (bang < 0) return null;
    let name = a1.slice(0, bang);
    if (name.startsWith("'") && name.endsWith("'")) name = name.slice(1, -1).replace(/''/g, "'");
    return name || null;
}

/** Resolve a c:f range against the referenced sheet's parsed CSV matrix, returning the
 *  cell texts. Uses the formula's sheet name if present, else the host sheet's matrix. */
function resolveRange(a1: string, resolve: MatrixResolver): string[] | null {
    const matrix = resolve(sheetNameOf(a1));
    if (!matrix) return null;
    const cells = rangeCells(a1);
    if (!cells) return null;
    return cells.map(({ r, c }) => (matrix[r] && matrix[r][c] != null) ? matrix[r][c] : "");
}

/** Read a c:cat or c:val: prefer its cache, else resolve its c:f against the sheet. */
function readAxis(node: Element | null, resolve: MatrixResolver): { text: string[]; nums: number[] } {
    if (!node) return { text: [], nums: [] };
    const ref = firstEl(node, "strRef") || firstEl(node, "numRef") || firstEl(node, "multiLvlStrRef");
    const cache = readCache(ref);
    if (cache.text.length) return cache;
    // No cache → resolve the formula range against the parsed CSV.
    const f = ref ? firstEl(ref, "f") : null;
    const range = f ? (f.textContent ?? "") : "";
    const resolved = resolveRange(range, resolve);
    if (!resolved) return { text: [], nums: [] };
    return { text: resolved, nums: resolved.map(v => v === "" ? NaN : Number(v)) };
}

/** The series name: c:tx cache/formula, else "". */
function readSeriesName(ser: Element, resolve: MatrixResolver): string {
    const tx = firstEl(ser, "tx");
    if (!tx) return "";
    // A literal <c:v> under tx (rare) or a strRef cache.
    const strRef = firstEl(tx, "strRef");
    if (strRef) {
        const c = readCache(strRef);
        if (c.text.length && c.text[0]) return c.text[0];
        const f = firstEl(strRef, "f");
        const resolved = f ? resolveRange(f.textContent ?? "", resolve) : null;
        if (resolved && resolved[0]) return resolved[0];
    }
    const v = childEls(tx, "v")[0] || firstEl(tx, "v");
    return v ? (v.textContent ?? "") : "";
}

/** Parse one plot-type element (c:barChart, c:lineChart, …) into series. cats come from
 *  the FIRST series that carries them (all series in a plot share categories); values
 *  are per-series. Scatter reads xVal/yVal instead of cat/val. */
function parseSeries(plot: Element, kind: SupportedChart["kind"], resolve: MatrixResolver): ChartSeries[] {
    const out: ChartSeries[] = [];
    let sharedCats: string[] = [];
    for (const ser of childEls(plot, "ser")) {
        const name = readSeriesName(ser, resolve);
        if (kind === "scatter") {
            // scatter: xVal = categories (numeric), yVal = values.
            const xv = readAxis(firstEl(ser, "xVal"), resolve);
            const yv = readAxis(firstEl(ser, "yVal"), resolve);
            out.push({ name, cats: xv.text, values: yv.nums });
            continue;
        }
        const cat = readAxis(firstEl(ser, "cat"), resolve);
        const val = readAxis(firstEl(ser, "val"), resolve);
        if (cat.text.length && !sharedCats.length) sharedCats = cat.text;
        out.push({ name, cats: cat.text.length ? cat.text : sharedCats, values: val.nums });
    }
    // Back-fill categories onto series that lacked their own from the shared set.
    for (const s of out) if (!s.cats.length) s.cats = sharedCats;
    return out;
}

/** The chart title from c:title's text runs, else "". */
function readTitle(chartDoc: Document): string {
    const title = firstEl(chartDoc, "title");
    if (!title) return "";
    // Title text is in <a:t> runs; join them. Skip an auto-title that only references
    // a series (c:title with no <a:t>) — then there's no explicit title text.
    const runs = els(title, "t").map(t => t.textContent ?? "").join("");
    return runs.trim();
}

/** A friendly label for an unsupported plot element's local name. */
function unsupportedLabel(local: string): string {
    switch (local) {
        case "radarChart": return "Radar chart";
        case "stockChart": return "Stock chart";
        case "surfaceChart": case "surface3DChart": return "Surface chart";
        case "bubbleChart": return "Bubble chart";
        case "bar3DChart": return "3D bar chart";
        case "line3DChart": return "3D line chart";
        case "pie3DChart": return "3D pie chart";
        case "area3DChart": return "3D area chart";
        case "ofPieChart": return "Pie-of-pie chart";
        default: return "Chart"; // generic — the caller adds the "not supported" copy
    }
}

/** Parse one chartN.xml document into a ChartModel. Recognised plot types render;
 *  everything else becomes an honest fallback naming the type. A chart with more than
 *  one plot type (a combo) is treated as unsupported (we don't overlay axes). */
function parseChartDoc(chartDoc: Document): ChartModel {
    const title = readTitle(chartDoc);
    const plotArea = firstEl(chartDoc, "plotArea");
    if (!plotArea) return { supported: false, title, typeLabel: "Chart" };

    // The plot-type elements present, in document order. c:barDir tells column vs bar.
    const PLOT_LOCALS = new Set([
        "barChart", "lineChart", "pieChart", "doughnutChart", "areaChart", "scatterChart",
        "radarChart", "stockChart", "surfaceChart", "surface3DChart", "bubbleChart",
        "bar3DChart", "line3DChart", "pie3DChart", "area3DChart", "ofPieChart"
    ]);
    const plots: Element[] = [];
    for (const c of elementChildren(plotArea)) {
        if (PLOT_LOCALS.has(c.localName)) plots.push(c);
    }
    if (!plots.length) return { supported: false, title, typeLabel: "Chart" };
    // A combo chart (two plot types) — we don't render overlaid axes; be honest.
    if (plots.length > 1) return { supported: false, title, typeLabel: "Combo chart" };

    const plot = plots[0];
    const local = plot.localName;
    let kind: SupportedChart["kind"] | null = null;
    let stacked = false;
    const grouping = firstEl(plot, "grouping")?.getAttribute("val") ?? "";
    if (grouping === "stacked" || grouping === "percentStacked") stacked = true;

    switch (local) {
        case "barChart": {
            const dir = firstEl(plot, "barDir")?.getAttribute("val") ?? "col";
            kind = dir === "bar" ? "bar" : "column";
            break;
        }
        case "lineChart": kind = "line"; break;
        case "areaChart": kind = "area"; break;
        case "pieChart": kind = "pie"; break;
        case "doughnutChart": kind = "doughnut"; break;
        case "scatterChart": kind = "scatter"; break;
        default:
            return { supported: false, title, typeLabel: unsupportedLabel(local) };
    }
    return { supported: true, kind, title, series: [], stacked };
    // series filled by the caller (it holds the sheet matrix) — see buildSheetCharts.
}

// ── public: extract every chart, mapped to its sheet ─────────────────────────

/** Cheap gate: does the zip's file list name any xl/charts/chartN.xml entry? A chart-
 *  free workbook returns false and the caller never runs the full parse. */
export function hasCharts(files: Record<string, Uint8Array>): boolean {
    for (const name in files) {
        if (name.startsWith("xl/charts/chart") && name.endsWith(".xml")) return true;
    }
    return false;
}

/**
 * Parse every chart in the (already-unzipped) workbook and bucket them by 0-based sheet
 * index. `sheetNames[i]` / `sheetMatrices[i]` are sheet i's name + parsed CSV matrix
 * (rows of cells), used to resolve a chart range whose embedded cache is missing — a
 * range names its sheet ("'Sales'!$A$2"), resolved via sheetNames; an unqualified range
 * falls back to the host sheet. Returns a parallel array `charts[i]` = the charts
 * anchored to sheet i (empty if none).
 *
 * fflate + DOMParser only; no webpack, no React. Safe to call off the render path.
 */
export function extractCharts(
    files: Record<string, Uint8Array>,
    strFromU8: (u: Uint8Array) => string,
    sheetCount: number,
    sheetMatrices: (string[][] | null)[],
    sheetNames: string[]
): SheetCharts[] {
    const decode = (u: Uint8Array) => strFromU8(u);
    const result: SheetCharts[] = Array.from({ length: sheetCount }, () => []);

    // sheet name → its matrix, so a formula's named sheet resolves regardless of the
    // chart's host sheet. (Case-sensitive; workbook names are unique.)
    const byName = new Map<string, string[][] | null>();
    for (let i = 0; i < sheetNames.length; i++) byName.set(sheetNames[i], sheetMatrices[i] ?? null);

    const order = sheetPartOrder(files, decode);
    // Walk each worksheet part → its drawing → the charts on it.
    for (const part of Object.keys(files)) {
        if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(part)) continue;
        const sheetIdx = order.get(part);
        if (sheetIdx == null || sheetIdx < 0 || sheetIdx >= sheetCount) continue;
        const hostMatrix = sheetMatrices[sheetIdx] ?? null;
        // A formula's named sheet wins; an unqualified range uses the host sheet.
        const resolve: MatrixResolver = (name: string | null) =>
            (name != null && byName.has(name)) ? (byName.get(name) ?? null) : hostMatrix;

        // sheet → drawing(s) via the sheet's rels.
        const sheetRelsBytes = files[relsPathFor(part)];
        if (!sheetRelsBytes) continue;
        const sheetRels = parseRels(decode(sheetRelsBytes), dirOf(part));
        for (const rId in sheetRels) {
            const drawingPart = sheetRels[rId];
            if (!/^xl\/drawings\/drawing\d+\.xml$/.test(drawingPart)) continue;
            const drawingBytes = files[drawingPart];
            if (!drawingBytes) continue;
            const drawingDoc = parseXml(decode(drawingBytes));
            if (!drawingDoc) continue;
            const drawingRelsBytes = files[relsPathFor(drawingPart)];
            const drawingRels = drawingRelsBytes ? parseRels(decode(drawingRelsBytes), dirOf(drawingPart)) : {};

            // Each <c:chart r:id="rIdN"> in the drawing references a chart part.
            for (const chartRef of els(drawingDoc, "chart")) {
                let cRid: string | null = null;
                for (let i = 0; i < chartRef.attributes.length; i++) {
                    const a = chartRef.attributes[i];
                    if (a.localName === "id") { cRid = a.value; break; }
                }
                const chartPart = cRid ? drawingRels[cRid] : undefined;
                if (!chartPart || !files[chartPart]) continue;
                const chartDoc = parseXml(decode(files[chartPart]));
                if (!chartDoc) continue;
                const model = parseChartDoc(chartDoc);
                if (model.supported) {
                    // Fill series now that we have the sheet matrix for cache fallback.
                    const plotArea = firstEl(chartDoc, "plotArea");
                    const plotEl = plotArea ? plotElementFor(plotArea, model.kind) : null;
                    if (plotEl) model.series = parseSeries(plotEl, model.kind, resolve);
                    // A chart that parsed to zero drawable series → an honest fallback
                    // rather than a blank card.
                    const drawable = model.series.some(s => s.values.some(v => Number.isFinite(v)));
                    if (!drawable) {
                        result[sheetIdx].push({ supported: false, title: model.title, typeLabel: "Chart" });
                        continue;
                    }
                }
                result[sheetIdx].push(model);
            }
        }
    }
    return result;
}

/** Re-find the plot element matching a resolved kind, so parseSeries reads the right
 *  one (parseChartDoc already validated there's exactly one plot type). */
function plotElementFor(plotArea: Element, kind: SupportedChart["kind"]): Element | null {
    const want = kind === "column" || kind === "bar" ? "barChart"
        : kind === "line" ? "lineChart"
            : kind === "area" ? "areaChart"
                : kind === "pie" ? "pieChart"
                    : kind === "doughnut" ? "doughnutChart"
                        : "scatterChart";
    for (const c of elementChildren(plotArea)) {
        if (c.localName === want) return c;
    }
    return null;
}
