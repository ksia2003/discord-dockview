import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import portalSyncModule from "../plugin/viewers/thread/portalSync.ts";
import inputIntentModule from "../plugin/host/inputIntent.ts";

const { createBoundedSettle, decideThreadOpen } = portalSyncModule;
const { createInputIntentTracker, isEditableTarget } = inputIntentModule;

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

test("trusted click arms exactly one explicit open; a second dispatch same turn is non-explicit", () => {
    const timers = timerQueue();
    const intent = createInputIntentTracker(timers.schedule, timers.clear);
    intent.arm(); // trusted click/keydown capture
    assert.equal(intent.consume(), true); // the FIRST intercepted SIDEBAR is explicit
    assert.equal(intent.consume(), false); // recursive/second dispatch: non-explicit
});

test("untrusted/internal render without any trusted input is never explicit", () => {
    const timers = timerQueue();
    const intent = createInputIntentTracker(timers.schedule, timers.clear);
    assert.equal(intent.consume(), false);
    assert.equal(intent.consume(), false);
});

test("unconsumed intent expires after the event turn", () => {
    const timers = timerQueue();
    const intent = createInputIntentTracker(timers.schedule, timers.clear, 0);
    intent.arm();
    timers.runAll(); // the zero-timeout clears the pending intent
    assert.equal(intent.consume(), false);
});

test("re-arm restarts the one-shot window; only one consume is granted", () => {
    const timers = timerQueue();
    const intent = createInputIntentTracker(timers.schedule, timers.clear, 0);
    intent.arm();
    intent.arm(); // second trusted input in the same turn restarts the timer
    assert.equal(intent.consume(), true);
    assert.equal(intent.consume(), false);
});

test("stop cleanup cancels the timer and clears any pending intent", () => {
    const timers = timerQueue();
    const intent = createInputIntentTracker(timers.schedule, timers.clear, 0);
    intent.arm();
    intent.cancel();
    assert.ok(timers.cancelledCount >= 1);
    assert.equal(intent.consume(), false);
    timers.runAll();
    assert.equal(intent.consume(), false); // nothing leaks after cleanup
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
    assert.match(interception, /if \(inputIntent\.consume\(\)\) markExplicitThreadOpen\(\);[\s\S]{0,80}openThreadTab\(String\(target\)/);
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
    assert.match(interception, /if \(inputIntent\.consume\(\)\) markExplicitThreadOpen\(\);/);
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
