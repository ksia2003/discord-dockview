/*
 * Native media readiness belongs to the provisional TAB, not to MediaBody.
 *
 * MediaBody is mounted only for the active tab. If the user opens media A and
 * switches to B before Chromium reports loadedmetadata/error, A's body is
 * unmounted and its DOM listeners disappear. This small registry keeps one
 * metadata-only element alive until that new tab either proves playable, fails,
 * is replaced, or is removed.
 *
 * Probe identity deliberately excludes content.seq: switching A -> B -> A bumps
 * the body sequence to force a React remount, but it is still the same tab and
 * descriptor. A new cache key/source replaces the probe instead.
 */

import { requestRender } from "../../engine/forceRender";
import type { DockWindow } from "../../engine/types";
import {
    isPendingMediaOpen, markPendingMediaDecodeError, markPendingMediaLoaded
} from "./mediaError";

type MediaKind = "audio" | "video";
type ProbeEvent = "loadedmetadata" | "canplay" | "error";
type ProbeListener = () => void;

interface ProbeElement {
    src: string;
    preload: string;
    muted: boolean;
    addEventListener(type: ProbeEvent, listener: ProbeListener): void;
    removeEventListener(type: ProbeEvent, listener: ProbeListener): void;
    pause(): void;
    removeAttribute(name: "src"): void;
    load(): void;
}

export type MediaProbeFactory = (kind: MediaKind) => ProbeElement;

interface ProbeRecord {
    identity: string;
    element: ProbeElement;
    loaded: ProbeListener;
    error: ProbeListener;
    timeout: ReturnType<typeof setTimeout>;
}

const probes = new Map<DockWindow, ProbeRecord>();
const MEDIA_PROBE_TIMEOUT_MS = 30_000;

function defaultFactory(kind: MediaKind): ProbeElement {
    return document.createElement(kind);
}

function descriptorIdentity(win: DockWindow, kind: MediaKind, url: string): string {
    // activeCacheKey is the canonical attachment identity (signed query rotation is
    // intentionally ignored there). The raw URL is only a defensive fallback.
    return `${kind}\0${win.activeCacheKey ?? url}`;
}

function release(win: DockWindow, record: ProbeRecord): void {
    if (probes.get(win) === record) probes.delete(win);
    clearTimeout(record.timeout);
    record.element.removeEventListener("loadedmetadata", record.loaded);
    record.element.removeEventListener("canplay", record.loaded);
    record.element.removeEventListener("error", record.error);
    try { record.element.pause(); } catch { /* already detached */ }
    try {
        record.element.removeAttribute("src");
        record.element.load();
    } catch { /* best-effort network abort */ }
}

function stillOwnsDescriptor(win: DockWindow, record: ProbeRecord): boolean {
    const kind = win.content.type;
    const url = win.content.url;
    return (kind === "audio" || kind === "video")
        && typeof url === "string"
        && descriptorIdentity(win, kind, url) === record.identity;
}

function settle(win: DockWindow, record: ProbeRecord, outcome: "loaded" | "error"): boolean {
    if (probes.get(win) !== record || !stillOwnsDescriptor(win, record) || !isPendingMediaOpen(win)) {
        release(win, record);
        return false;
    }
    release(win, record);
    return outcome === "loaded" ? markPendingMediaLoaded(win) : markPendingMediaDecodeError(win);
}

/** Start (or retain) the one readiness observer owned by a provisional media tab. */
export function startMediaProbe(
    win: DockWindow,
    kind: MediaKind,
    url: string,
    factory: MediaProbeFactory = defaultFactory
): boolean {
    if (!url || !isPendingMediaOpen(win)) return false;

    const identity = descriptorIdentity(win, kind, url);
    const current = probes.get(win);
    if (current?.identity === identity) return true;
    if (current) release(win, current);

    let element: ProbeElement;
    try {
        element = factory(kind);
    } catch {
        if (markPendingMediaDecodeError(win)) requestRender();
        return false;
    }

    const record = {} as ProbeRecord;
    record.identity = identity;
    record.element = element;
    record.loaded = () => {
        if (settle(win, record, "loaded")) requestRender();
    };
    record.error = () => {
        if (settle(win, record, "error")) requestRender();
    };
    record.timeout = setTimeout(record.error, MEDIA_PROBE_TIMEOUT_MS);
    probes.set(win, record);

    element.preload = "metadata";
    element.muted = true;
    element.addEventListener("loadedmetadata", record.loaded);
    element.addEventListener("canplay", record.loaded);
    element.addEventListener("error", record.error);
    try {
        element.src = url;
        element.load();
    } catch {
        record.error();
    }
    return probes.get(win) === record;
}

/** Let the visible native player settle the same tab-owned probe first. */
export function settleMediaProbeFromBody(
    win: DockWindow,
    bodySeq: number,
    outcome: "loaded" | "error"
): boolean {
    if (win.content.seq !== bodySeq) return false;
    const record = probes.get(win);
    return record ? settle(win, record, outcome) : false;
}

export function cancelMediaProbe(win: DockWindow): void {
    const record = probes.get(win);
    if (record) release(win, record);
}

export function cancelAllMediaProbes(): void {
    for (const [win, record] of [...probes]) release(win, record);
}

/** Narrow observation seam used by lifecycle tests. */
export function hasMediaProbe(win: DockWindow): boolean {
    return probes.has(win);
}
