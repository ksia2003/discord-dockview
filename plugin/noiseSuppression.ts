/*
 * DockView — RNNoise microphone noise suppression (opt-in).
 * ---------------------------------------------------------------------------
 * Discord's own noise suppression (Krisp) is proprietary and frequently doesn't work
 * on Linux; Vencord removed RNNoise and declined to bring it back. This adds it back as
 * an opt-in toggle: an open-source RNNoise model (via @timephy/rnnoise-wasm's AudioWorklet)
 * denoises the outgoing microphone stream before Discord ever sees it.
 *
 * THE SEAM (how we get in front of Discord's mic)
 * -----------------------------------------------
 * Discord opens the mic through navigator.mediaDevices.getUserMedia({ audio }). We wrap
 * that method: when it resolves a real audio stream and the feature is ON, we route the
 * stream through a Web Audio graph
 *
 *     createMediaStreamSource(mic) → AudioWorkletNode(rnnoise) → createMediaStreamDestination()
 *
 * and hand Discord a stream whose audio track is the DESTINATION's (the denoised) track,
 * with the raw mic track swapped out (and stopped when it's the only reference). Discord
 * gets a normal MediaStream and is none the wiser. Video-only / display captures pass
 * through untouched. On teardown we restore the original getUserMedia so a disable is a
 * clean revert.
 *
 * THE WORKLET (why a chunk, why a blob URL)
 * -----------------------------------------
 * RNNoise processes 480-sample frames at 48 kHz, but an AudioWorkletProcessor is handed
 * 128-sample blocks — the @timephy worklet accumulates 128→480 in a circular buffer sized
 * to lcm(128,480) so a frame never straddles a wrap. Its wasm is inlined as base64 and
 * instantiated SYNCHRONOUSLY (the worklet can't await during addModule, and Discord's CSP
 * would block a wasm fetch anyway). We ship that worklet as chunk-rnnoise.js (engine/
 * chunks/rnnoise.entry.ts), read its source over the readChunk IPC (like every other
 * chunk), wrap it in a blob: URL, and audioWorklet.addModule(that) — Vencord's CSP patch
 * allows blob: in worker-src, so the worklet loads with no network at all. The module is
 * NOT eval'd in the renderer (it calls registerProcessor, which only exists in the audio
 * thread), so it deliberately skips lazyLib's chunk-eval path.
 *
 * NO module-top webpack/DOM access — everything runs inside functions off start()/toggle,
 * matching the plugin's silent-death rule. The context runs at 48 kHz (RNNoise's rate) so
 * the worklet's 128↔480 framing math holds.
 */

import { settings } from "./settings";

/** RNNoise's operating sample rate. The worklet's ring buffer is sized for 48 kHz. */
const RNNOISE_SAMPLE_RATE = 48000;

/** The processor name @timephy's worklet registers itself under. */
const WORKLET_NAME = "NoiseSuppressorWorklet";

/** The chunk file the worklet ships as (matches chunkRegistry.ts chunkId "rnnoise"). */
const WORKLET_CHUNK = "chunk-rnnoise.js";

/** The original getUserMedia, captured when we install the hook so stop()/toggle-off
 *  restores it exactly. Null when the hook isn't installed. */
type GetUserMedia = (constraints?: MediaStreamConstraints) => Promise<MediaStream>;
let originalGetUserMedia: GetUserMedia | null = null;

/** Whether the feature is currently active (the hook is installed). Mirrors the setting
 *  but is the authoritative in-module flag the hook reads on each call. */
let active = false;

/** One shared, lazily-created 48 kHz AudioContext + the loaded-worklet promise, reused
 *  across every mic acquisition for the session. The worklet module is added to the
 *  context exactly once (addModule is idempotent per name but the blob fetch/compile
 *  isn't free), memoised here. */
let audioContext: AudioContext | null = null;
let workletReady: Promise<void> | null = null;

/** Every graph we've stood up, so teardown can disconnect + stop them all. One entry per
 *  active mic stream Discord holds. */
interface Graph {
    context: AudioContext;
    source: MediaStreamAudioSourceNode;
    node: AudioWorkletNode;
    destination: MediaStreamAudioDestinationNode;
    rawTrack: MediaStreamTrack;
}
const graphs = new Set<Graph>();

/** Read the worklet chunk's source text off disk (same IPC the heavy-lib chunks use) and
 *  return a blob: URL for it. addModule needs a URL and can't take inline source; the CSP
 *  patch allows blob: in worker-src, so this loads with no network. */
async function workletBlobUrl(): Promise<string> {
    const w = window as any;
    const dir: string | null = (() => {
        try {
            const d = w.VesktopNative?.fileManager?.getVencordDir?.();
            return typeof d === "string" && d ? d : null;
        } catch {
            return null;
        }
    })();
    if (!dir) throw new Error("DockView: cannot locate Vencord files dir for the noise-suppression worklet");

    const native = w.VencordNative?.pluginHelpers?.DockView;
    if (!native || typeof native.readChunk !== "function") {
        throw new Error("DockView: readChunk IPC unavailable for the noise-suppression worklet");
    }

    const src: string | null = await native.readChunk(dir, WORKLET_CHUNK);
    if (typeof src !== "string" || !src) {
        throw new Error("DockView: noise-suppression worklet chunk missing or empty");
    }
    return URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
}

/** The shared 48 kHz context, created on first use. */
function ensureContext(): AudioContext {
    if (!audioContext || audioContext.state === "closed") {
        audioContext = new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE });
    }
    return audioContext;
}

/** Load the worklet module into the shared context exactly once (memoised). A failure
 *  clears the memo so a later mic open retries instead of poisoning the session. */
function ensureWorklet(context: AudioContext): Promise<void> {
    if (!workletReady) {
        workletReady = (async () => {
            const url = await workletBlobUrl();
            try {
                await context.audioWorklet.addModule(url);
            } finally {
                URL.revokeObjectURL(url);
            }
        })().catch(err => {
            workletReady = null;
            throw err;
        });
    }
    return workletReady;
}

/** True when the constraints ask for audio (an audio-less getUserMedia — a screenshare or
 *  camera-only capture — is left completely alone). */
function wantsAudio(constraints?: MediaStreamConstraints): boolean {
    return !!constraints && constraints.audio !== undefined && constraints.audio !== false;
}

/**
 * Run one mic stream through the RNNoise graph and return a MediaStream Discord can use:
 * the original stream with its raw audio track replaced by the denoised destination track
 * (any video tracks are carried over untouched). Throws if the graph can't be built — the
 * caller falls back to the raw stream so the mic never breaks because denoising failed.
 */
async function denoise(stream: MediaStream): Promise<MediaStream> {
    const rawTrack = stream.getAudioTracks()[0];
    if (!rawTrack) return stream; // no audio track to process

    // Discord re-acquires the mic on a voice reconnect / device change and doesn't always
    // fire "ended" on the old denoised track, which would leave the previous graph's context
    // nodes + raw mic track hot forever (an open AudioContext + a live worklet burning CPU).
    // A new mic acquisition supersedes the old one, so reap stale graphs before standing up
    // the replacement: any graph whose raw track has already died (Discord dropped it), plus
    // — since a silently-swapped old track can stay "live" — a hard cap so graphs can never
    // accumulate across reconnects. The current call's graph isn't in the set yet, so this
    // only ever reaps prior ones.
    reapStaleGraphs();

    const context = ensureContext();
    await ensureWorklet(context);
    if (context.state === "suspended") await context.resume();

    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, WORKLET_NAME, {
        channelCount: 1,
        channelCountMode: "explicit",
        numberOfInputs: 1,
        numberOfOutputs: 1
    });
    const destination = context.createMediaStreamDestination();
    source.connect(node);
    node.connect(destination);

    const graph: Graph = { context, source, node, destination, rawTrack };
    graphs.add(graph);

    const denoisedTrack = destination.stream.getAudioTracks()[0];
    // Carry the raw track's enabled (mute) state onto the output track, then hand the
    // enabled flag ownership to the output — Discord toggles enabled on the track it holds.
    denoisedTrack.enabled = rawTrack.enabled;

    // A source node keeps its input stream alive on its own; the raw track no longer needs
    // to be in the stream Discord sees. Swap it for the denoised track in place so callers
    // that inspect the SAME stream object (Discord keeps the reference) see the new track.
    stream.removeTrack(rawTrack);
    stream.addTrack(denoisedTrack);

    // When the denoised track ends (Discord stops the stream), tear this graph down so the
    // context nodes + the raw mic track don't leak.
    denoisedTrack.addEventListener("ended", () => teardownGraph(graph), { once: true });

    return stream;
}

/** Most concurrent denoise graphs we'll ever keep alive. Discord holds one mic at a time,
 *  so anything beyond a small margin is an orphan from a track-swap that never fired "ended".
 *  Set is insertion-ordered, so the leading entries are the oldest — reap those. */
const MAX_GRAPHS = 2;

/** Reap graphs that a track-swap orphaned, without relying on the "ended" event: any whose
 *  raw mic track already ended, then the oldest ones over the cap. Called before each new
 *  mic acquisition so an open AudioContext + hot mic can't pile up across voice reconnects. */
function reapStaleGraphs(): void {
    for (const g of [...graphs]) {
        if (g.rawTrack.readyState === "ended") teardownGraph(g);
    }
    while (graphs.size >= MAX_GRAPHS) {
        const oldest = graphs.values().next().value;
        if (!oldest) break;
        teardownGraph(oldest);
    }
}

/** Disconnect one graph's nodes and stop its raw mic track. */
function teardownGraph(graph: Graph): void {
    if (!graphs.delete(graph)) return;
    try { graph.source.disconnect(); } catch { /* already gone */ }
    try { graph.node.disconnect(); } catch { /* already gone */ }
    try { graph.node.port.close(); } catch { /* already gone */ }
    try { graph.destination.disconnect(); } catch { /* already gone */ }
    try { graph.rawTrack.stop(); } catch { /* already stopped */ }
}

/** Install the getUserMedia wrapper (idempotent). The wrapper defers to the captured
 *  original, then denoises the result when active + audio was requested. Any failure in
 *  the graph falls back to the raw stream so the mic still works. */
function installHook(): void {
    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== "function" || originalGetUserMedia) return;

    // Capture the ORIGINAL function itself (not a bound copy) so uninstall restores the
    // exact reference we replaced — a bound copy would be functionally equal but break an
    // identity check another getUserMedia patcher might do. We call it back with the right
    // receiver (mediaDevices) below.
    originalGetUserMedia = md.getUserMedia;
    const orig = originalGetUserMedia;

    md.getUserMedia = async function (this: MediaDevices, constraints?: MediaStreamConstraints): Promise<MediaStream> {
        const stream = await orig.call(md, constraints);
        if (!active || !wantsAudio(constraints)) return stream;
        try {
            return await denoise(stream);
        } catch {
            // Denoising failed (worklet load, context, etc.) — hand back the untouched mic
            // stream so a broken suppressor never costs the user their microphone.
            return stream;
        }
    };
}

/** Restore the original getUserMedia + tear down every live graph + close the context. */
function uninstallHook(): void {
    if (originalGetUserMedia) {
        try { (navigator.mediaDevices as any).getUserMedia = originalGetUserMedia; } catch { /* ignore */ }
        originalGetUserMedia = null;
    }
    for (const graph of [...graphs]) teardownGraph(graph);
    workletReady = null;
    if (audioContext) {
        const ctx = audioContext;
        audioContext = null;
        ctx.close().catch(() => { /* already closed */ });
    }
}

/** Start noise suppression if the setting is on (called from plugin start()). Installs the
 *  getUserMedia hook so the NEXT mic acquisition is denoised. Streams already open before
 *  this (a call already in progress) aren't retro-filtered — the user reconnects to voice
 *  or the next getUserMedia picks it up, which is when Discord re-acquires the mic anyway. */
export function startNoiseSuppression(): void {
    if (settings.store.noiseSuppression !== true) return;
    active = true;
    installHook();
}

/** Stop noise suppression (called from plugin stop()). Full teardown + restore. */
export function stopNoiseSuppression(): void {
    active = false;
    uninstallHook();
}

/** Apply the live setting on a Performance-panel flip. ON installs the hook (takes effect
 *  on the next mic acquisition); OFF restores getUserMedia and tears every graph down so
 *  the raw mic flows again on the next reconnect. */
export function syncNoiseSuppression(enabled: boolean): void {
    if (enabled) {
        active = true;
        installHook();
    } else {
        stopNoiseSuppression();
    }
}

/** Whether the getUserMedia hook is currently installed — for the CDP debug surface. */
export function noiseSuppressionActive(): boolean {
    return active && originalGetUserMedia !== null;
}
