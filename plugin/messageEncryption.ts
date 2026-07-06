/*
 * DockView — message encryption wiring (renderer).
 * ---------------------------------------------------------------------------
 * The renderer half of the Privacy page's StegCloak message encryption. The crypto
 * itself lives in MAIN (native-crypto.ts, reached over IPC); this module owns the
 * three seams that touch Discord:
 *
 *   SEND  — a ChatBar toggle button. While it's ON, MessageEvents pre-send /
 *           pre-edit listeners rewrite msg.content = encrypt(content) before Discord
 *           uploads it, so the server only ever stores the cover-with-hidden-stream.
 *   RECEIVE — a FluxDispatcher.dispatch monkey-patch intercepts MESSAGE_CREATE /
 *           MESSAGE_UPDATE / LOAD_MESSAGES_SUCCESS / SEARCH_FINISH. For any message
 *           whose content is cloaked, it kicks off an async decrypt (IPC) and, once
 *           it resolves, re-renders that message with the plaintext (marker-prefixed)
 *           via MessageUpdater.updateMessage.
 *
 * WHY RECEIVE IS ASYNC (and how it stays clean). GoofCord runs its crypto lib
 * synchronously inside the renderer, so it decrypts in-place during dispatch. Our
 * crypto is main-side (node:crypto), reached over an async IPC — a dispatch handler
 * can't await. So the patch does a CHEAP synchronous gate in the renderer (a
 * zero-width-char scan, no crypto, no IPC), and only for a cloaked message does it
 * fire the async decrypt + re-render. A per-ciphertext cache means each message is
 * decrypted once, not on every re-dispatch, and the re-render is a no-op fast-path
 * when the plaintext is already cached.
 *
 * DEFAULT OFF / INERT (the non-negotiable). With the master setting off OR no
 * passwords loaded, `active` is false: the dispatch patch is a pure passthrough
 * (one boolean check, then the original dispatch), the send listeners no-op, and
 * the button reflects "off". stop() restores FluxDispatcher.dispatch to the exact
 * original reference, removes the listeners, removes the button, and clears state —
 * so a disabled/stopped feature leaves Discord's internals untouched. This is the
 * fragile item; it must not risk the client when unused.
 *
 * NO module-top webpack/DOM access — the button component and the Vencord API grabs
 * all happen inside functions off start()/toggle, matching the plugin's silent-death
 * rule. The zero-width gate (ZWC scan) is the only crypto-adjacent thing done in the
 * renderer, and it's pure string work.
 */

import { addChatBarButton, ChatBarButton, ChatBarButtonFactory, removeChatBarButton } from "@api/ChatButtons";
import { addMessagePreEditListener, addMessagePreSendListener, MessageEditListener, MessageSendListener, removeMessagePreEditListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { updateMessage } from "@api/MessageUpdater";
import { FluxDispatcher, React } from "@webpack/common";

import { settings } from "./settings";

/** The six StegCloak zero-width chars — the renderer-side gate scans for these so it
 *  never fires an IPC for a plain (non-cloaked) message. Must match native-crypto.ts. */
const ZWC = ["‌", "‍", "⁡", "⁢", "⁣", "⁤"];
function looksCloaked(str: string): boolean {
    if (!str) return false;
    for (const z of ZWC) if (str.includes(z)) return true;
    return false;
}

/** The ChatBar button id (addChatBarButton / removeChatBarButton key). */
const BUTTON_ID = "dockview-encryption";

// ── module state (all cleared on stop) ──────────────────────────────────────

/** The per-send toggle: while true, outgoing messages are encrypted. This is NOT
 *  persisted — each session starts with it off, so a message is never silently
 *  encrypted after a restart the user forgot about. Flipped by the button. */
let sendEnabled = false;

/** Whether the receive path is armed: the master setting is on AND we have at least
 *  one password. When false the dispatch patch is a pure passthrough. Recomputed on
 *  start, on every setting flip, and after passwords load. */
let receiveActive = false;

/** The decrypted passwords, loaded from the safeStorage blob over IPC on start and
 *  refreshed when the panel changes them. Held only in renderer memory. */
let passwords: string[] = [];

/** The captured original FluxDispatcher.dispatch, restored EXACTLY on stop. Null when
 *  the patch isn't installed. */
let originalDispatch: ((payload: any) => any) | null = null;

/** The live send/edit listeners, held so stop() removes the exact references. */
let preSendListener: MessageSendListener | null = null;
let preEditListener: MessageEditListener | null = null;

/** A React state setter the mounted button registers, so a programmatic toggle (or a
 *  master-off) repaints the icon. Null when no button is mounted. */
let setButtonState: ((on: boolean) => void) | null = null;

/** Per-ciphertext decrypt cache: cloaked content → resolved plaintext (marker-prefixed)
 *  or null (tried, no password matched). Stops the async re-render loop from
 *  re-decrypting the same message on every re-dispatch. Bounded so it can't grow
 *  unboundedly over a long session. */
const decryptCache = new Map<string, string | null>();
/** Ciphertexts a decrypt is currently in flight for (dedupe concurrent dispatches). */
const inFlight = new Set<string>();
const CACHE_MAX = 500;

function native(): any {
    return (window as any).VencordNative?.pluginHelpers?.DockView;
}

// ── settings snapshot ────────────────────────────────────────────────────────

function coverText(): string {
    const c = settings.store.encryptionCover;
    return typeof c === "string" && c.trim().split(" ").length >= 2 ? c : "This is a confidential message";
}
function marker(): string {
    const m = settings.store.encryptionMark;
    return typeof m === "string" ? m : "";
}

/** Recompute whether the receive path should be armed and refresh the button state. */
function recomputeActive(): void {
    receiveActive = settings.store.messageEncryption === true && passwords.length > 0;
    // If the master is off, force the send toggle off too so a leftover-on button
    // can't encrypt with a disabled feature.
    if (settings.store.messageEncryption !== true) {
        sendEnabled = false;
        setButtonState?.(false);
    }
}

// ── SEND path ────────────────────────────────────────────────────────────────

/** Encrypt one outgoing content string, or return null on any failure (the caller
 *  then leaves the message untouched rather than sending a broken payload). Uses the
 *  FIRST password as the encryption key (the receive side tries them all). */
async function encryptOutgoing(content: string): Promise<string | null> {
    const helpers = native();
    if (!helpers?.encryptMessage || passwords.length === 0) return null;
    try {
        const res = await helpers.encryptMessage(content, passwords[0], coverText());
        return res?.ok && typeof res.text === "string" ? res.text : null;
    } catch {
        return null;
    }
}

// ── RECEIVE path ─────────────────────────────────────────────────────────────

function cachePut(key: string, val: string | null): void {
    if (decryptCache.size >= CACHE_MAX) {
        const first = decryptCache.keys().next().value;
        if (first !== undefined) decryptCache.delete(first);
    }
    decryptCache.set(key, val);
}

/** For a message whose content is cloaked: resolve the plaintext (from cache or a
 *  fresh IPC decrypt) and, when it lands, re-render that message with the marker-
 *  prefixed plaintext. A no-op when already cached or when a decrypt is in flight. */
function scheduleDecrypt(channelId: string | undefined, message: any): void {
    const content: string = message?.content;
    if (!channelId || !message?.id || !looksCloaked(content)) return;

    const cached = decryptCache.get(content);
    if (cached !== undefined) {
        if (cached) applyPlaintext(channelId, message.id, cached);
        return;
    }
    if (inFlight.has(content)) return;
    inFlight.add(content);

    const helpers = native();
    if (!helpers?.decryptMessage) { inFlight.delete(content); return; }

    Promise.resolve(helpers.decryptMessage(content, passwords))
        .then((res: any) => {
            if (res?.ok && typeof res.text === "string") {
                const shown = marker() + res.text;
                cachePut(content, shown);
                applyPlaintext(channelId, message.id, shown);
            } else {
                // notCloaked / noMatch / integrity — remember the miss so we don't
                // keep retrying this ciphertext on every re-dispatch.
                cachePut(content, null);
            }
        })
        .catch(() => cachePut(content, null))
        .finally(() => inFlight.delete(content));
}

/** Re-render a message with decrypted content. updateMessage merges the field and
 *  triggers Discord's own re-render; wrapped so a transient store miss can't throw
 *  out of the dispatch path. */
function applyPlaintext(channelId: string, messageId: string, content: string): void {
    try {
        updateMessage(channelId, messageId, { content });
    } catch {
        /* message not in store yet / gone — ignore */
    }
}

/** The dispatch interception, run BEFORE the original dispatch. Cheap and total: a
 *  disabled feature returns immediately; an enabled one only schedules async work for
 *  messages that pass the synchronous zero-width gate. Never throws into dispatch. */
function handleDispatch(payload: any): void {
    if (!receiveActive || !payload) return;
    switch (payload.type) {
        case "MESSAGE_CREATE":
        case "MESSAGE_UPDATE":
            scheduleDecrypt(payload.channelId ?? payload.message?.channel_id, payload.message);
            break;
        case "LOAD_MESSAGES_SUCCESS":
            if (Array.isArray(payload.messages)) {
                for (const m of payload.messages) scheduleDecrypt(m?.channel_id ?? payload.channelId, m);
            }
            break;
        case "SEARCH_FINISH":
        case "MOD_VIEW_SEARCH_FINISH":
            if (Array.isArray(payload.messages)) {
                for (const group of payload.messages) {
                    const arr = Array.isArray(group) ? group : [group];
                    for (const m of arr) scheduleDecrypt(m?.channel_id ?? payload.channelId, m);
                }
            }
            break;
    }
}

/** Install the dispatch patch once, capturing the original reference. FluxDispatcher is
 *  the @webpack/common live binding (resolved by the time start() runs). We keep the
 *  ORIGINAL bound reference so uninstall restores it exactly. */
function installDispatchPatch(): void {
    if (originalDispatch) return;
    const flux: any = FluxDispatcher;
    if (!flux || typeof flux.dispatch !== "function") return;
    const orig: (payload: any) => any = flux.dispatch.bind(flux);
    originalDispatch = orig;
    flux.dispatch = function (payload: any) {
        try {
            handleDispatch(payload);
        } catch {
            /* never let our interception break Discord's dispatch */
        }
        return orig(payload);
    };
}

/** Restore FluxDispatcher.dispatch to the exact original and drop the reference. */
function uninstallDispatchPatch(): void {
    if (!originalDispatch) return;
    try {
        (FluxDispatcher as any).dispatch = originalDispatch;
    } catch {
        /* ignore */
    }
    originalDispatch = null;
}

// ── ChatBar button ───────────────────────────────────────────────────────────

const h = (...args: any[]) => (React.createElement as any)(...args);

function LockGlyph({ open }: { open: boolean; }) {
    // A simple padlock; open (danger-coloured) = encryption off, closed = on.
    return h(
        "svg",
        { width: 22, height: 22, viewBox: "0 0 24 24", "aria-hidden": true },
        open
            ? h("path", {
                fill: "var(--status-danger, #f23f43)",
                d: "M12 2a5 5 0 0 0-5 5v2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-9V7a3 3 0 0 1 6 0 1 1 0 1 0 2 0 5 5 0 0 0-5-5Z"
            })
            : h("path", {
                fill: "currentColor",
                d: "M12 2a5 5 0 0 0-5 5v2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm3 7H9V7a3 3 0 0 1 6 0v2Z"
            })
    );
}

const EncryptionButton: ChatBarButtonFactory = ({ isMainChat }) => {
    const [on, setOn] = React.useState(sendEnabled);
    // Register this instance's setter so a master-off / programmatic toggle repaints.
    React.useEffect(() => {
        setButtonState = setOn;
        return () => { if (setButtonState === setOn) setButtonState = null; };
    }, []);

    if (!isMainChat) return null;

    const hasPasswords = passwords.length > 0;
    const masterOn = settings.store.messageEncryption === true;

    const onClick = () => {
        if (!masterOn || !hasPasswords) return; // inert until configured
        const next = !on;
        sendEnabled = next;
        setOn(next);
    };

    const tooltip = !masterOn
        ? "Message encryption is off (enable it in DockView → Privacy)"
        : !hasPasswords
            ? "Add an encryption password in DockView → Privacy"
            : on
                ? "Encryption on — messages you send are encrypted"
                : "Encryption off — click to encrypt messages you send";

    const glyph = h(LockGlyph, { open: !(masterOn && hasPasswords && on) });
    return h(ChatBarButton, { tooltip, onClick }, glyph);
};

// ── SEND listeners ────────────────────────────────────────────────────────────

function addSendListeners(): void {
    if (preSendListener) return;
    preSendListener = addMessagePreSendListener(async (_channelId, msg) => {
        if (!sendEnabled || !msg?.content) return;
        const enc = await encryptOutgoing(msg.content);
        if (enc) msg.content = enc; // failure → send untouched (never a broken payload)
    });
    preEditListener = addMessagePreEditListener(async (_channelId, _id, msg) => {
        if (!sendEnabled || !msg?.content) return;
        const enc = await encryptOutgoing(msg.content);
        if (enc) msg.content = enc;
    });
}

function removeSendListeners(): void {
    if (preSendListener) { removeMessagePreSendListener(preSendListener); preSendListener = null; }
    if (preEditListener) { removeMessagePreEditListener(preEditListener); preEditListener = null; }
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

/** Start the message-encryption wiring (called from plugin start()). Always installs
 *  the button + listeners + dispatch patch, but the patch/listeners are INERT until
 *  `receiveActive`/`sendEnabled` are true — so the feature costs nothing when unused
 *  and needs no reload to become active once the user configures a password. */
export function startMessageEncryption(): void {
    // Load stored passwords async; arm the receive path once they land.
    void refreshPasswords();
    recomputeActive();

    try { addChatBarButton(BUTTON_ID, EncryptionButton, LockGlyph as any); } catch { /* API not ready */ }
    addSendListeners();
    installDispatchPatch();
}

/** Stop + full teardown (called from plugin stop()). Restores FluxDispatcher.dispatch
 *  to the exact original, removes the listeners + button, and clears all state, so a
 *  stopped plugin leaves Discord's internals exactly as found. */
export function stopMessageEncryption(): void {
    uninstallDispatchPatch();
    removeSendListeners();
    try { removeChatBarButton(BUTTON_ID); } catch { /* already gone */ }
    sendEnabled = false;
    receiveActive = false;
    passwords = [];
    decryptCache.clear();
    inFlight.clear();
    setButtonState = null;
}

/** Reload the password list from the safeStorage blob over IPC, then re-arm. Called on
 *  start and whenever the Privacy panel changes the passwords. */
export async function refreshPasswords(): Promise<void> {
    const helpers = native();
    if (helpers?.loadPasswords) {
        try {
            const list = await helpers.loadPasswords();
            passwords = Array.isArray(list) ? list.filter((p: any) => typeof p === "string" && p) : [];
        } catch {
            passwords = [];
        }
    }
    decryptCache.clear();
    recomputeActive();
    setButtonState?.(sendEnabled);
}

/** Persist a new password list (encrypted at rest), update the in-memory copy, re-arm.
 *  Returns the native result so the panel can surface a safeStorage-unavailable error. */
export async function saveEncryptionPasswords(list: string[]): Promise<{ ok: boolean; error?: string; }> {
    const helpers = native();
    if (!helpers?.savePasswords) return { ok: false, error: "Secure storage bridge unavailable" };
    const clean = list.filter(p => typeof p === "string" && p);
    const res = await helpers.savePasswords(clean);
    if (res?.ok) {
        passwords = clean;
        decryptCache.clear();
        recomputeActive();
    }
    return res ?? { ok: false, error: "Unknown error saving passwords" };
}

/** The current password COUNT (the panel shows count, never the values). */
export function encryptionPasswordCount(): number {
    return passwords.length;
}

/** Apply a master-setting flip live (Privacy panel). Re-arms the receive path and, when
 *  turning off, clears the send toggle + repaints the button. */
export function syncMessageEncryption(): void {
    recomputeActive();
    setButtonState?.(sendEnabled);
}

/** Whether the receive path is armed — for the CDP debug surface. */
export function messageEncryptionActive(): boolean {
    return receiveActive;
}

/** Whether the FluxDispatcher patch is currently installed — for the CDP debug surface. */
export function messageEncryptionPatched(): boolean {
    return originalDispatch !== null;
}
