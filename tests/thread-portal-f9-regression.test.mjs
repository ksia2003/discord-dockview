import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import portalSyncModule from "../plugin/viewers/thread/portalSync.ts";

const { createBoundedSettle, decideThreadOpen } = portalSyncModule;

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
    assert.equal(decideThreadOpen(true, false, false), "noop");
});

test("hidden->same thread: a non-explicit SIDEBAR open refocuses while the dock is F9-hidden", () => {
    assert.equal(decideThreadOpen(true, false, true), "refocus");
});

test("same-thread open through the explicit browser seam refocuses even when visible", () => {
    assert.equal(decideThreadOpen(true, true, false), "refocus");
    assert.equal(decideThreadOpen(true, true, true), "refocus");
});

test("hidden->different thread: any open of a not-active thread proceeds to open", () => {
    assert.equal(decideThreadOpen(false, false, false), "open");
    assert.equal(decideThreadOpen(false, false, true), "open");
    assert.equal(decideThreadOpen(false, true, false), "open");
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
    assert.match(threadTab, /decideThreadOpen\(alreadyActive, explicit, hostActions\(\)\.isDockTemporarilyHidden\(\)\)/);
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

test("host action: Dock temporary-hidden state is exposed and wired from mount", () => {
    const hostBridge = source("../plugin/engine/hostBridge.ts");
    const open = source("../plugin/host/open.ts");
    assert.match(hostBridge, /isDockTemporarilyHidden\(\): boolean;/);
    assert.match(hostBridge, /isDockTemporarilyHidden: \(\) => false/);
    assert.match(open, /isDockTemporarilyHidden,/);
    assert.match(open, /registerHostActions\(\{[\s\S]{0,200}isDockTemporarilyHidden,/);
});

test("browser seam arms explicit intent; background/interception never do", () => {
    const plugin = source("../plugin/index.tsx");
    const interception = source("../plugin/host/interception.ts");
    assert.match(plugin, /markExplicitThreadOpen\(\)/);
    assert.match(plugin, /openThreadTab\(threadId, parentId\)/);
    assert.doesNotMatch(interception, /markExplicitThreadOpen|explicit/);
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
