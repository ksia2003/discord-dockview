/*
 * The per-sheet CHARTS strip + hand-drawn SVG chart cards.
 *
 * SheetJS drops a workbook's embedded charts; XlsxCharts re-extracts them from the zip
 * and parses the common plot types. This module DRAWS them — no chart library, just SVG
 * we build ourselves (axes, gridlines, bars/lines/areas/slices, a legend, value labels
 * where they fit). Every colour is a semantic theme token (with a literal dark fallback)
 * so a chart follows the Discord / Vesktop theme like the rest of the dock; the multi-
 * series palette is derived from the brand + feedback tokens via color-mix so it stays
 * on-theme without hardcoding a rainbow.
 *
 * The strip is COLLAPSIBLE (state remembered in the xlsx view-state / cache entry, like
 * the other dock toggles) and sits above the grid's fx bar. A sheet with no charts
 * renders nothing here at all. Unsupported chart types get a small fallback card naming
 * the type — never a silent drop, never a broken render.
 *
 * No module-top React.createElement / no module-top webpack access: the element tree +
 * the SVG are built inside the component / its effect, read at call time.
 */

import { React } from "@webpack/common";

import { STRINGS } from "../../strings";
import type { ChartModel, ChartSeries, SupportedChart } from "./XlsxCharts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The multi-series palette: semantic theme tokens (brand + feedback + link + a warm
 *  accent), each with a literal dark fallback. color-mix lightens later entries so a
 *  4+-series chart stays legible on a dark ground. --text-positive / --text-danger are
 *  EMPTY in this build, so the palette leads with --text-feedback-* / --brand / --text-link. */
const PALETTE: string[] = [
    "var(--brand-500, #5865f2)",
    "var(--text-feedback-positive, #3ba55c)",
    "var(--text-feedback-critical, #ed4245)",
    "var(--text-link, #00a8fc)",
    "var(--text-feedback-warning, #e6a935)",
    "color-mix(in srgb, var(--brand-500, #5865f2) 55%, white)",
    "color-mix(in srgb, var(--text-feedback-positive, #3ba55c) 55%, white)",
    "color-mix(in srgb, var(--text-link, #00a8fc) 55%, white)"
];

function seriesColor(i: number): string {
    return PALETTE[i % PALETTE.length];
}

// Semantic tokens for the chart chrome (axes / gridlines / text), literal fallbacks.
const AXIS_COLOR = "var(--background-modifier-accent, rgba(255,255,255,0.14))";
const GRID_COLOR = "var(--background-modifier-accent, rgba(255,255,255,0.07))";
const TEXT_COLOR = "var(--text-muted, #949ba4)";
const LABEL_COLOR = "var(--text-normal, #dbdee1)";

// Card geometry (viewBox units == px at 1:1; the SVG scales to the card width).
const W = 460;
const H = 240;
const PAD = { top: 14, right: 14, bottom: 46, left: 46 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, String(attrs[k]));
    return el;
}

/** A short numeric tick label (trim trailing zeros, keep it compact). */
function fmtNum(n: number): string {
    if (!Number.isFinite(n)) return "";
    const abs = Math.abs(n);
    if (abs >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (abs >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    if (Number.isInteger(n)) return String(n);
    return String(Math.round(n * 100) / 100);
}

/** "nice" axis bounds + a step for ~5 ticks over [min,max]. */
function niceScale(min: number, max: number): { lo: number; hi: number; step: number } {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
        const v = Number.isFinite(max) ? max : 1;
        const pad = Math.abs(v) || 1;
        return { lo: Math.min(0, v - pad), hi: Math.max(0, v + pad), step: pad / 2 || 0.5 };
    }
    const range = max - min;
    const rawStep = range / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    return { lo, hi, step };
}

/** Draw the shared value-axis gridlines + labels into `g`, returning a y(value)→px map. */
function drawValueAxis(g: SVGElement, lo: number, hi: number, step: number): (v: number) => number {
    const y = (v: number) => PAD.top + PLOT_H - ((v - lo) / (hi - lo)) * PLOT_H;
    for (let v = lo; v <= hi + step / 2; v += step) {
        const yy = y(v);
        g.appendChild(svg("line", { x1: PAD.left, y1: yy, x2: PAD.left + PLOT_W, y2: yy, stroke: GRID_COLOR, "stroke-width": 1 }));
        const t = svg("text", { x: PAD.left - 6, y: yy + 3, "text-anchor": "end", "font-size": 9, fill: TEXT_COLOR });
        t.textContent = fmtNum(v);
        g.appendChild(t);
    }
    return y;
}

/** Category (x) labels along the bottom, thinned so they never overlap. */
function drawCatLabels(g: SVGElement, cats: string[], xCenter: (i: number) => number): void {
    const n = cats.length;
    if (!n) return;
    const maxLabels = Math.max(2, Math.floor(PLOT_W / 44));
    const stride = Math.max(1, Math.ceil(n / maxLabels));
    for (let i = 0; i < n; i++) {
        if (i % stride) continue;
        const raw = cats[i] ?? "";
        const label = raw.length > 8 ? raw.slice(0, 7) + "…" : raw;
        const t = svg("text", { x: xCenter(i), y: PAD.top + PLOT_H + 14, "text-anchor": "middle", "font-size": 9, fill: TEXT_COLOR });
        t.textContent = label;
        if (raw.length > 8) { const ti = svg("title", {}); ti.textContent = raw; t.appendChild(ti); }
        g.appendChild(t);
    }
}

/** The min/max value across every series (stacked → per-category sums). */
function valueBounds(series: ChartSeries[], stacked: boolean): { min: number; max: number } {
    let min = 0, max = 0; // include 0 so bars have a baseline
    if (stacked) {
        const catCount = Math.max(...series.map(s => s.values.length), 0);
        for (let c = 0; c < catCount; c++) {
            let pos = 0, neg = 0;
            for (const s of series) {
                const v = s.values[c];
                if (!Number.isFinite(v)) continue;
                if (v >= 0) pos += v; else neg += v;
            }
            if (pos > max) max = pos;
            if (neg < min) min = neg;
        }
    } else {
        for (const s of series) for (const v of s.values) {
            if (!Number.isFinite(v)) continue;
            if (v < min) min = v;
            if (v > max) max = v;
        }
    }
    return { min, max };
}

// ── the plot renderers ───────────────────────────────────────────────────────

function drawBars(g: SVGElement, chart: SupportedChart, horizontal: boolean): void {
    const series = chart.series;
    const cats = series[0]?.cats ?? [];
    const catCount = Math.max(cats.length, ...series.map(s => s.values.length), 1);
    const { min, max } = valueBounds(series, chart.stacked);
    const { lo, hi, step } = niceScale(min, max);

    if (horizontal) {
        // bar (rows): value on X, categories on Y. Reuse the vertical logic transposed.
        const x = (v: number) => PAD.left + ((v - lo) / (hi - lo)) * PLOT_W;
        for (let v = lo; v <= hi + step / 2; v += step) {
            const xx = x(v);
            g.appendChild(svg("line", { x1: xx, y1: PAD.top, x2: xx, y2: PAD.top + PLOT_H, stroke: GRID_COLOR, "stroke-width": 1 }));
            const t = svg("text", { x: xx, y: PAD.top + PLOT_H + 12, "text-anchor": "middle", "font-size": 9, fill: TEXT_COLOR });
            t.textContent = fmtNum(v); g.appendChild(t);
        }
        const band = PLOT_H / catCount;
        const groupPad = band * 0.2;
        const barH = chart.stacked ? (band - groupPad) : (band - groupPad) / series.length;
        for (let i = 0; i < catCount; i++) {
            const label = (cats[i] ?? "").length > 10 ? cats[i].slice(0, 9) + "…" : (cats[i] ?? "");
            const yLabel = PAD.top + i * band + band / 2;
            const lt = svg("text", { x: PAD.left - 6, y: yLabel + 3, "text-anchor": "end", "font-size": 9, fill: TEXT_COLOR });
            lt.textContent = label; g.appendChild(lt);
            let stackPos = x(0);
            for (let s = 0; s < series.length; s++) {
                const v = series[s].values[i];
                if (!Number.isFinite(v)) continue;
                const y0 = PAD.top + i * band + groupPad / 2 + (chart.stacked ? 0 : s * barH);
                if (chart.stacked) {
                    const w = x(v) - x(0);
                    g.appendChild(svg("rect", { x: Math.min(stackPos, stackPos + w), y: y0, width: Math.abs(w), height: barH, fill: seriesColor(s) }));
                    stackPos += w;
                } else {
                    const xw = x(v) - x(0);
                    g.appendChild(svg("rect", { x: Math.min(x(0), x(0) + xw), y: y0, width: Math.abs(xw), height: barH, fill: seriesColor(s) }));
                }
            }
        }
        return;
    }

    const y = drawValueAxis(g, lo, hi, step);
    const band = PLOT_W / catCount;
    const groupPad = band * 0.2;
    const barW = chart.stacked ? (band - groupPad) : (band - groupPad) / series.length;
    const xCenter = (i: number) => PAD.left + i * band + band / 2;
    for (let i = 0; i < catCount; i++) {
        let stackPosPos = 0, stackPosNeg = 0;
        for (let s = 0; s < series.length; s++) {
            const v = series[s].values[i];
            if (!Number.isFinite(v)) continue;
            const x0 = PAD.left + i * band + groupPad / 2 + (chart.stacked ? 0 : s * barW);
            if (chart.stacked) {
                const base = v >= 0 ? stackPosPos : stackPosNeg;
                const top = base + v;
                const yTop = y(Math.max(base, top));
                const yBot = y(Math.min(base, top));
                g.appendChild(svg("rect", { x: x0, y: yTop, width: barW, height: Math.max(0, yBot - yTop), fill: seriesColor(s) }));
                if (v >= 0) stackPosPos = top; else stackPosNeg = top;
            } else {
                const yTop = y(Math.max(0, v));
                const yBot = y(Math.min(0, v));
                g.appendChild(svg("rect", { x: x0, y: yTop, width: Math.max(1, barW - 1), height: Math.max(0, yBot - yTop), fill: seriesColor(s) }));
                // value label above a single-series bar if it fits.
                if (series.length === 1 && catCount <= 16) {
                    const t = svg("text", { x: x0 + barW / 2, y: yTop - 3, "text-anchor": "middle", "font-size": 9, fill: LABEL_COLOR });
                    t.textContent = fmtNum(v); g.appendChild(t);
                }
            }
        }
    }
    drawCatLabels(g, cats, xCenter);
}

function drawLineOrArea(g: SVGElement, chart: SupportedChart, area: boolean): void {
    const series = chart.series;
    const cats = series[0]?.cats ?? [];
    const catCount = Math.max(cats.length, ...series.map(s => s.values.length), 1);
    const { min, max } = valueBounds(series, false);
    const { lo, hi, step } = niceScale(min, max);
    const y = drawValueAxis(g, lo, hi, step);
    const stepX = catCount > 1 ? PLOT_W / (catCount - 1) : 0;
    const xAt = (i: number) => PAD.left + (catCount > 1 ? i * stepX : PLOT_W / 2);
    for (let s = 0; s < series.length; s++) {
        const vals = series[s].values;
        const col = seriesColor(s);
        let d = "";
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i < catCount; i++) {
            const v = vals[i];
            if (!Number.isFinite(v)) { d += ""; continue; }
            const px = xAt(i); const py = y(v);
            pts.push({ x: px, y: py });
            d += (d && !d.endsWith("M ") ? " L " : "M ") + px + " " + py;
        }
        if (area && pts.length) {
            const base = y(Math.max(lo, 0));
            let ad = "M " + pts[0].x + " " + base;
            for (const p of pts) ad += " L " + p.x + " " + p.y;
            ad += " L " + pts[pts.length - 1].x + " " + base + " Z";
            g.appendChild(svg("path", { d: ad, fill: col, "fill-opacity": 0.18, stroke: "none" }));
        }
        g.appendChild(svg("path", { d, fill: "none", stroke: col, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
        for (const p of pts) g.appendChild(svg("circle", { cx: p.x, cy: p.y, r: 2.5, fill: col }));
    }
    drawCatLabels(g, cats, xAt);
}

function drawScatter(g: SVGElement, chart: SupportedChart): void {
    const series = chart.series;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const s of series) {
        for (let i = 0; i < s.values.length; i++) {
            const yv = s.values[i]; const xv = Number(s.cats[i]);
            if (Number.isFinite(xv)) { if (xv < xmin) xmin = xv; if (xv > xmax) xmax = xv; }
            if (Number.isFinite(yv)) { if (yv < ymin) ymin = yv; if (yv > ymax) ymax = yv; }
        }
    }
    if (!Number.isFinite(xmin)) { xmin = 0; xmax = 1; }
    if (!Number.isFinite(ymin)) { ymin = 0; ymax = 1; }
    const ys = niceScale(ymin, ymax);
    const xs = niceScale(xmin, xmax);
    const y = drawValueAxis(g, ys.lo, ys.hi, ys.step);
    const x = (v: number) => PAD.left + ((v - xs.lo) / (xs.hi - xs.lo)) * PLOT_W;
    for (let v = xs.lo; v <= xs.hi + xs.step / 2; v += xs.step) {
        const xx = x(v);
        g.appendChild(svg("line", { x1: xx, y1: PAD.top, x2: xx, y2: PAD.top + PLOT_H, stroke: GRID_COLOR, "stroke-width": 1 }));
        const t = svg("text", { x: xx, y: PAD.top + PLOT_H + 12, "text-anchor": "middle", "font-size": 9, fill: TEXT_COLOR });
        t.textContent = fmtNum(v); g.appendChild(t);
    }
    for (let s = 0; s < series.length; s++) {
        const col = seriesColor(s);
        for (let i = 0; i < series[s].values.length; i++) {
            const yv = series[s].values[i]; const xv = Number(series[s].cats[i]);
            if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
            g.appendChild(svg("circle", { cx: x(xv), cy: y(yv), r: 3, fill: col, "fill-opacity": 0.85 }));
        }
    }
}

function drawPie(g: SVGElement, chart: SupportedChart): void {
    // Pie/doughnut uses the FIRST series' values; slice labels are its categories.
    const series = chart.series[0];
    if (!series) return;
    const vals = series.values.map(v => Number.isFinite(v) ? Math.max(0, v) : 0);
    const total = vals.reduce((a, b) => a + b, 0);
    const cx = PAD.left + PLOT_W / 2;
    const cy = PAD.top + PLOT_H / 2;
    const rad = Math.min(PLOT_W, PLOT_H) / 2 - 4;
    const inner = chart.kind === "doughnut" ? rad * 0.55 : 0;
    if (total <= 0) return;
    let a0 = -Math.PI / 2;
    for (let i = 0; i < vals.length; i++) {
        if (vals[i] <= 0) continue;
        const frac = vals[i] / total;
        const a1 = a0 + frac * Math.PI * 2;
        const x0 = cx + rad * Math.cos(a0), y0 = cy + rad * Math.sin(a0);
        const x1 = cx + rad * Math.cos(a1), y1 = cy + rad * Math.sin(a1);
        const large = frac > 0.5 ? 1 : 0;
        let d: string;
        if (inner > 0) {
            const ix0 = cx + inner * Math.cos(a0), iy0 = cy + inner * Math.sin(a0);
            const ix1 = cx + inner * Math.cos(a1), iy1 = cy + inner * Math.sin(a1);
            d = `M ${x0} ${y0} A ${rad} ${rad} 0 ${large} 1 ${x1} ${y1} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${large} 0 ${ix0} ${iy0} Z`;
        } else {
            d = `M ${cx} ${cy} L ${x0} ${y0} A ${rad} ${rad} 0 ${large} 1 ${x1} ${y1} Z`;
        }
        g.appendChild(svg("path", { d, fill: seriesColor(i), stroke: "var(--background-primary, #313338)", "stroke-width": 1 }));
        // % label on a big enough slice.
        if (frac >= 0.06) {
            const mid = (a0 + a1) / 2;
            const lr = inner > 0 ? (inner + rad) / 2 : rad * 0.62;
            const t = svg("text", {
                x: cx + lr * Math.cos(mid), y: cy + lr * Math.sin(mid) + 3,
                "text-anchor": "middle", "font-size": 9, fill: "#fff", "font-weight": 600
            });
            t.textContent = Math.round(frac * 100) + "%";
            g.appendChild(t);
        }
        a0 = a1;
    }
}

/** The legend row under a chart: a swatch + name per series (or per pie slice). */
function buildLegend(chart: SupportedChart): HTMLElement | null {
    const items: { name: string; color: string }[] = [];
    if (chart.kind === "pie" || chart.kind === "doughnut") {
        const s = chart.series[0];
        if (!s) return null;
        // pie legend = the slice categories (only when there are named categories).
        const named = s.cats.filter(c => c && c.length).length > 0;
        if (!named) return null;
        for (let i = 0; i < s.values.length; i++) {
            if (!Number.isFinite(s.values[i])) continue;
            items.push({ name: s.cats[i] || "—", color: seriesColor(i) });
        }
    } else {
        if (chart.series.length < 2 && !(chart.series[0]?.name)) return null;
        for (let i = 0; i < chart.series.length; i++) {
            items.push({ name: chart.series[i].name || "Series " + (i + 1), color: seriesColor(i) });
        }
    }
    if (!items.length) return null;
    const legend = document.createElement("div");
    legend.className = "dockview-xlsx-chart-legend";
    for (const it of items.slice(0, 12)) {
        const row = document.createElement("span");
        row.className = "dockview-xlsx-chart-legend-item";
        const sw = document.createElement("span");
        sw.className = "dockview-xlsx-chart-swatch";
        sw.style.background = it.color;
        const nm = document.createElement("span");
        nm.className = "dockview-xlsx-chart-legend-name";
        nm.textContent = it.name;
        nm.title = it.name;
        row.appendChild(sw); row.appendChild(nm); legend.appendChild(row);
    }
    return legend;
}

/** Build one chart card's DOM (title + SVG plot + legend) into a fresh element. */
function buildCard(chart: ChartModel): HTMLElement {
    const card = document.createElement("div");
    card.className = "dockview-xlsx-chart-card";

    if (!chart.supported) {
        card.classList.add("dockview-xlsx-chart-fallback");
        const t = document.createElement("div");
        t.className = "dockview-xlsx-chart-title";
        t.textContent = chart.title || chart.typeLabel;
        const msg = document.createElement("div");
        msg.className = "dockview-xlsx-chart-fallback-msg";
        msg.textContent = STRINGS.xlsx.chartUnsupported(chart.typeLabel);
        card.appendChild(t); card.appendChild(msg);
        return card;
    }

    if (chart.title) {
        const t = document.createElement("div");
        t.className = "dockview-xlsx-chart-title";
        t.textContent = chart.title;
        t.title = chart.title;
        card.appendChild(t);
    }

    const svgEl = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "dockview-xlsx-chart-svg", preserveAspectRatio: "xMidYMid meet" });
    const g = svg("g", {});
    // axes frame (baseline + left axis) for cartesian plots.
    if (chart.kind !== "pie" && chart.kind !== "doughnut") {
        g.appendChild(svg("line", { x1: PAD.left, y1: PAD.top, x2: PAD.left, y2: PAD.top + PLOT_H, stroke: AXIS_COLOR, "stroke-width": 1 }));
        g.appendChild(svg("line", { x1: PAD.left, y1: PAD.top + PLOT_H, x2: PAD.left + PLOT_W, y2: PAD.top + PLOT_H, stroke: AXIS_COLOR, "stroke-width": 1 }));
    }
    switch (chart.kind) {
        case "column": drawBars(g, chart, false); break;
        case "bar": drawBars(g, chart, true); break;
        case "line": drawLineOrArea(g, chart, false); break;
        case "area": drawLineOrArea(g, chart, true); break;
        case "scatter": drawScatter(g, chart); break;
        case "pie": case "doughnut": drawPie(g, chart); break;
    }
    svgEl.appendChild(g);
    card.appendChild(svgEl as unknown as Node);

    const legend = buildLegend(chart);
    if (legend) card.appendChild(legend);
    return card;
}

/**
 * The per-sheet Charts strip: a collapsible header ("Charts (N)") + a row of chart
 * cards, built imperatively (like the CSV grid) so the SVG stays out of React's tree.
 * `charts` is the ACTIVE sheet's chart list (empty → this component isn't rendered by
 * the body). `collapsed` + `onToggle` drive the remembered collapse state.
 */
export function XlsxChartStrip({ charts, collapsed, onToggle }: {
    charts: ChartModel[];
    collapsed: boolean;
    onToggle: () => void;
}) {
    const { useEffect, useRef } = React;
    const mountRef = useRef(null as HTMLElement | null);

    useEffect(() => {
        const m = mountRef.current;
        if (!m) return;
        m.textContent = "";
        if (collapsed) return; // don't build the (heavier) SVG while collapsed
        for (const chart of charts) m.appendChild(buildCard(chart));
    }, [charts, collapsed]);

    const count = charts.length;
    return React.createElement(
        "div",
        { className: "dockview-xlsx-charts" + (collapsed ? " dockview-xlsx-charts-collapsed" : "") },
        React.createElement(
            "button",
            {
                type: "button",
                className: "dockview-xlsx-charts-head",
                onClick: onToggle,
                "aria-expanded": !collapsed
            },
            React.createElement("span", { className: "dockview-xlsx-charts-caret" }, collapsed ? "▸" : "▾"),
            React.createElement("span", { className: "dockview-xlsx-charts-title" }, STRINGS.xlsx.chartsHeading(count))
        ),
        React.createElement("div", {
            ref: mountRef,
            className: "dockview-xlsx-charts-row",
            hidden: collapsed || undefined
        })
    );
}
