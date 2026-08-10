import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import portalSyncModule from "../plugin/viewers/thread/portalSync.ts";
import inputIntentModule from "../plugin/host/inputIntent.ts";

const { createBoundedSettle, decideThreadOpen } = portalSyncModule;
const { createInputIntentTracker, extractActivationIds, isEditableTarget } = inputIntentModule;

function frameQueue() {
    const queue = [];
    const cancelled = new Set();
    let nextHandle = 0;
    return {
        schedule(callback) {
            const handle = ++nextHandle;
            queue.push({ handle, callback });
            return handle;
        },
        cancel(handle) { cancelled.add(handle); },
        runNext() {
            const entry = queue.shift();
            if (!entry || cancelled.has(entry.handle)) return false;
            entry.callback();
            return true;
        },
        runAll() { while (this.runNext()) { /* drain */ } },
        pending() { return queue.length; },
        get cancelledCount() { return cancelled.size; }
    };
}

const source = relative => readFileSync(new URL(relative, import.meta.url), "utf8");

// --- thread open decision (loop-breaker vs explicit refocus vs fresh open) -------

test("visible same-thread non-explicit recursion is a pure no-op (loop-breaker)", () => {
    assert.equal(decideThreadOpen(true, false), "noop");
});

test("F9-hidden internal dispatch without trusted input stays noop by decision", () => {
    // No trusted-input marker = non-explicit, so even a hidden-dock recursion cannot
    // refocus; only the interception's one-shot trusted-input seam marks it explicit.
    assert.equal(decideThreadOpen(true, false), "noop");
});

test("same-thread open through the explicit browser seam refocuses even when visible", () => {
    assert.equal(decideThreadOpen(true, true), "refocus");
});

test("hidden->different thread: any open of a not-active thread proceeds to open", () => {
    assert.equal(decideThreadOpen(false, false), "open");
    assert.equal(decideThreadOpen(false, true), "open");
});

// --- one-shot trusted-user-input intent (the hidden-refocus discriminator) ---------

function timerQueue() {
    const queue = [];
    const cancelled = new Set();
    let nextHandle = 0;
    return {
        schedule(callback) {
            const handle = ++nextHandle;
            queue.push({ handle, callback });
            return handle;
        },
        clear(handle) { cancelled.add(handle); },
        runNext() {
            const entry = queue.shift();
            if (!entry || cancelled.has(entry.handle)) return false;
            entry.callback();
            return true;
        },
        runAll() { while (this.runNext()) { /* drain */ } },
        pending() { return queue.length; },
        get cancelledCount() { return cancelled.size; }
    };
}

test("trusted click with matching evidence arms exactly one explicit open", () => {
    const timers = timerQueue();
    const intent = createInputIntentTracker(timers.schedule, timers.clear);
    intent.arm(["456"]); // trusted click/keydown on a thread-row target
    assert.equal(intent.consumeFor("456"), true); // the matching SIDEBAR is explicit
    assert.equal(intent.consumeFor("456"), false); // recursive/second dispatch: non-explicit
});

test("unrelated click evidence never matches a thread payload and expires", () => {
    const timers = timerQueue();
    const intent = createInputIntentTracker(timers.schedule, timers.clear);
    intent.arm(["999"]); // e.g. a parent-channel row click
    assert.equal(intent.consumeFor("456"), false); // internal SIDEBAR for a thread: no match
    timers.runAll(); // the turn ends without a matching SIDEBAR
    assert.equal(intent.consumeFor("999"), false); // never explicit
});

test("a non-matching SIDEBAR leaves the intent armed for a matching one this turn", () => {
    const timers = timerQueue();
    const intent = createInputIntentTracker(timers.schedule, timers.clear);
    intent.arm(["456"]);
    assert.equal(intent.consumeFor("999"), false); // unrelated dispatch first
    assert.equal(intent.consumeFor("456"), true); // then the thread's own SIDEBAR matches
    assert.equal(intent.consumeFor("456"), false); // one-shot consumed
});

test("untrusted/internal render without any trusted input is never explicit", () => {
    const timers = timerQueue();
    const intent = createInputIntentTracker(timers.schedule, timers.clear);
    assert.equal(intent.consumeFor("456"), false);
    assert.equal(intent.consumeFor("456"), false);
});

test("unconsumed intent expires after the event turn", () => {
    const timers = timerQueue();
    const intent = createInputIntentTracker(timers.schedule, timers.clear);
    intent.arm(["456"]);
    timers.runAll(); // the zero-timeout clears the pending intent
    assert.equal(intent.consumeFor("456"), false);
});

test("re-arm restarts the one-shot window; only one consume is granted", () => {
    const timers = timerQueue();
    const intent = createInputIntentTracker(timers.schedule, timers.clear);
    intent.arm(["456"]);
    intent.arm(["456"]); // second trusted input in the same turn restarts the timer
    assert.equal(intent.consumeFor("456"), true);
    assert.equal(intent.consumeFor("456"), false);
});

test("stop cleanup cancels the timer and clears any pending intent", () => {
    const timers = timerQueue();
    const intent = createInputIntentTracker(timers.schedule, timers.clear);
    intent.arm(["456"]);
    intent.cancel();
    assert.ok(timers.cancelledCount >= 1);
    assert.equal(intent.consumeFor("456"), false);
    timers.runAll();
    assert.equal(intent.consumeFor("456"), false); // nothing leaks after cleanup
});

test("activation-id evidence: anchors, stable attributes, and own-fiber channel props", () => {
    const anchor = { getAttribute: name => (name === "href" ? "/channels/123/456" : null) };
    assert.deepEqual(extractActivationIds([anchor]), ["456"]);
    assert.deepEqual(
        extractActivationIds([
            { getAttribute: name => (name === "data-channel-id" ? "789" : null) },
            { getAttribute: name => (name === "data-list-item-id" ? "111" : null) }
        ]),
        ["789", "111"]
    );
    const fiberNode = {
        getAttribute: () => null,
        __reactFiber$hash: { memoizedProps: { channel: { id: "222" }, channelId: "333", thread: { id: "444" } } }
    };
    assert.deepEqual(extractActivationIds([fiberNode]), ["333", "222", "444"]);
});

test("activation-id evidence: prefixed data-list-item-id snowflakes", () => {
    const listItem = value => ({ getAttribute: name => (name === "data-list-item-id" ? value : null) });
    assert.deepEqual(extractActivationIds([listItem("channels___456")]), ["456"]);
    assert.deepEqual(extractActivationIds([listItem("thread-row___789")]), ["789"]);
    assert.deepEqual(extractActivationIds([listItem("456")]), ["456"]); // plain digits still work
    assert.deepEqual(extractActivationIds([listItem("abc123def")]), []); // no buried digits
    // data-channel-id stays strict digits — a prefixed value contributes nothing.
    assert.deepEqual(
        extractActivationIds([{ getAttribute: name => (name === "data-channel-id" ? "channels___456" : null) }]),
        []
    );
});

test("activation-id evidence: non-thread targets contribute nothing", () => {
    assert.deepEqual(extractActivationIds([]), []);
    assert.deepEqual(extractActivationIds([null, 42, "text"]), []);
    assert.deepEqual(extractActivationIds([{ getAttribute: () => null }]), []);
    assert.deepEqual(
        extractActivationIds([
            { getAttribute: name => (name === "href" ? "https://example.com/foo" : null) },
            { getAttribute: name => (name === "data-channel-id" ? "not-an-id" : null) }
        ]),
        []
    );
    // A generic `id` prop on the fiber must NOT be treated as channel evidence.
    assert.deepEqual(
        extractActivationIds([{ __reactFiber$h: { memoizedProps: { id: "555", guildId: "666" } } }]),
        []
    );
});

test("non-Element path nodes are skipped without enumerating their keys", () => {
    const ownKeysCalls = [];
    const sentinel = new Proxy({}, {
        ownKeys() {
            ownKeysCalls.push("ownKeys");
            return [];
        }
    });
    assert.deepEqual(extractActivationIds([sentinel]), []);
    assert.deepEqual(ownKeysCalls, []); // Object.keys was never invoked on it
    // A non-Element fiber-like object must not contribute evidence either.
    assert.deepEqual(
        extractActivationIds([{ __reactFiber$h: { memoizedProps: { channel: { id: "777" } } } }]),
        []
    );
});

test("editable-target gate blocks composer text entry from arming intent", () => {
    assert.equal(isEditableTarget({ tagName: "INPUT", isContentEditable: false, getAttribute: () => null }), true);
    assert.equal(isEditableTarget({ tagName: "TEXTAREA", isContentEditable: false, getAttribute: () => null }), true);
    assert.equal(isEditableTarget({ tagName: "SELECT", isContentEditable: false, getAttribute: () => null }), true);
    assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true, getAttribute: () => null }), true);
    assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: false, getAttribute: name => (name === "role" ? "textbox" : null) }), true);
    assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: false, getAttribute: () => null }), false);
    assert.equal(isEditableTarget(null), false);
});

// --- bounded live-body reacquire (no permanent rAF loop) -------------------------

test("settle runs the action exactly maxFrames times after arm and then stops", () => {
    const frames = frameQueue();
    let runs = 0;
    const settle = createBoundedSettle(
        frames.schedule,
        frames.cancel,
        () => { runs++; },
        3
    );
    settle.arm();
    assert.equal(frames.pending(), 1);
    frames.runAll();
    assert.equal(runs, 3);
    assert.equal(frames.pending(), 0);
    frames.runAll();
    assert.equal(runs, 3); // steady state: zero further work
});

test("settle never schedules a permanent loop", () => {
    const frames = frameQueue();
    let runs = 0;
    const settle = createBoundedSettle(
        frames.schedule,
        frames.cancel,
        () => { runs++; },
        5
    );
    settle.arm();
    frames.runAll();
    assert.equal(runs, 5);
    assert.equal(frames.pending(), 0);
    frames.runAll();
    assert.equal(runs, 5); // steady state: zero further work
});

test("settle cancel stops immediately and the action never runs", () => {
    const frames = frameQueue();
    let runs = 0;
    const settle = createBoundedSettle(
        frames.schedule,
        frames.cancel,
        () => { runs++; },
        5
    );
    settle.arm();
    settle.cancel();
    assert.ok(frames.cancelledCount >= 1);
    frames.runAll();
    assert.equal(runs, 0);
});

test("re-arm mid-settle extends the window (bounded, not compounding)", () => {
    const frames = frameQueue();
    let runs = 0;
    const settle = createBoundedSettle(
        frames.schedule,
        frames.cancel,
        () => { runs++; },
        3
    );
    settle.arm();
    frames.runNext(); // tick 1
    settle.arm();     // refresh the count
    frames.runNext(); // tick 2
    frames.runNext(); // tick 3
    frames.runNext(); // tick 4
    assert.equal(runs, 4);
    assert.equal(frames.pending(), 0);
    frames.runAll();
    assert.equal(runs, 4); // one extra frame from the re-arm, then it stops
});

test("each settle frame runs the sync action and can observe a changed body identity", () => {
    const frames = frameQueue();
    let liveBody = "body1";
    let lastSyncedBody = null;
    let runs = 0;
    const settle = createBoundedSettle(
        frames.schedule,
        frames.cancel,
        () => {
            runs++;
            lastSyncedBody = liveBody; // the action re-resolves the live body each frame
        },
        12
    );
    settle.arm();
    liveBody = "body2"; // the dock body was replaced while the settle was armed
    frames.runAll();
    assert.equal(runs, 12);
    assert.equal(lastSyncedBody, "body2"); // reacquisition observed the NEW body
    assert.equal(frames.pending(), 0);
});

// --- wiring (the seams stay narrow and non-revealing for internal re-entry) -------

test("threadTab: recursion no-op returns before any reveal; explicit refocus reveals", () => {
    const threadTab = source("../plugin/engine/threadTab.ts");
    assert.match(threadTab, /decideThreadOpen\(alreadyActive, explicit\)/);
    assert.match(threadTab, /if \(decision === "noop"\) \{/);
    // The no-op branch precedes the reveal calls: internal re-entry can never reveal.
    assert.match(threadTab, /if \(decision === "noop"\) \{[\s\S]{0,80}return;[\s\S]{0,60}\}/);
    assert.match(
        threadTab,
        /if \(decision === "refocus"\) \{[\s\S]{0,600}host\.deactivateSearchView\(\);[\s\S]{0,80}setContextActive\(getWindowChannelId\(\), false\);[\s\S]{0,80}host\.hideContextBody\(\);[\s\S]{0,80}host\.ensureHost\(\);[\s\S]{0,80}host\.revealDock\(\);[\s\S]{0,80}selectThreadPortal\(threadId\);[\s\S]{0,80}requestRender\(\);/
    );
    assert.match(threadTab, /if \(takesOverView\) host\.revealDock\(\)/);
    // Refocus repaints but never seq-bumps/remounts the chat (that would re-arm recursion).
    assert.doesNotMatch(threadTab, /"refocus"[\s\S]{0,600}seq \+= 1/);
    // The intent flag is consumed on the next open and never leaks.
    assert.match(threadTab, /const explicit = explicitThreadOpenPending;/);
    assert.match(threadTab, /explicitThreadOpenPending = false;/);
});

test("interception arms one-shot intent on trusted click/key activation only", () => {
    const interception = source("../plugin/host/interception.ts");
    assert.match(interception, /addEventListener\("click", trustedClickListener, true\)/);
    assert.match(interception, /addEventListener\("keydown", trustedKeydownListener, true\)/);
    assert.match(interception, /e\.isTrusted === false/);
    assert.match(interception, /e\.key !== "Enter" && e\.key !== " "/);
    assert.match(interception, /isEditableTarget\(e\.target\)/);
    assert.match(interception, /extractActivationIds\(path\)/);
    assert.match(interception, /if \(ids\.length > 0\) inputIntent\.arm\(ids\);/);
    assert.match(interception, /if \(inputIntent\.consumeFor\(String\(target\)\)\) markExplicitThreadOpen\(\);[\s\S]{0,80}openThreadTab\(String\(target\)/);
    assert.match(interception, /removeEventListener\("click", trustedClickListener, true\)/);
    assert.match(interception, /removeEventListener\("keydown", trustedKeydownListener, true\)/);
    assert.match(interception, /inputIntent\.cancel\(\)/);
});

test("the F9-hidden state proxy is gone from the host bridge and open wiring", () => {
    const hostBridge = source("../plugin/engine/hostBridge.ts");
    const open = source("../plugin/host/open.ts");
    assert.doesNotMatch(hostBridge, /isDockTemporarilyHidden/);
    assert.doesNotMatch(open, /isDockTemporarilyHidden/);
});

test("browser seam arms explicit intent; interception only marks via a consumed trusted input", () => {
    const plugin = source("../plugin/index.tsx");
    const interception = source("../plugin/host/interception.ts");
    assert.match(plugin, /markExplicitThreadOpen\(\)/);
    assert.match(plugin, /openThreadTab\(threadId, parentId\)/);
    assert.match(interception, /if \(inputIntent\.consumeFor\(String\(target\)\)\) markExplicitThreadOpen\(\);/);
    assert.doesNotMatch(interception, /markExplicitThreadOpen\(\);[\s\S]{0,120}markExplicitThreadOpen/);
});

test("threadPortal: reacquires a replaced body via bounded settle, one portal visible", () => {
    const portal = source("../plugin/viewers/thread/threadPortal.ts");
    assert.match(portal, /createBoundedSettle\(/);
    assert.match(portal, /syncVisibleThreadPortalNow\s*\)/); // each settle frame syncs
    assert.match(portal, /if \(body !== observedBody\) \{[\s\S]{0,400}settleSync\.arm\(\);/);
    assert.match(portal, /function startSync\(\): void \{[\s\S]{0,400}settleSync\.arm\(\);/);
    assert.match(portal, /settleSync\.cancel\(\);/);
    // showThreadPortal hides every non-selected portal (one visible portal invariant).
    assert.match(portal, /if \(id !== threadId\) \{[\s\S]{0,120}p\.node\.style\.display = "none";/);
});

test("settle default window is a small bounded frame budget, not a loop", () => {
    const portalSync = source("../plugin/viewers/thread/portalSync.ts");
    assert.match(portalSync, /maxFrames = 12/);
    assert.match(portalSync, /if \(remaining > 0 && !handle\) handle = schedule\(tick\);/);
});
