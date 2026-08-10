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

test("loop-breaker: a same-thread open through a non-explicit seam is a pure no-op", () => {
    assert.equal(decideThreadOpen(true, false), "noop");
});

test("hidden->same thread: a same-thread open through the explicit browser seam refocuses", () => {
    assert.equal(decideThreadOpen(true, true), "refocus");
});

test("hidden->different thread: any open of a not-active thread proceeds to open", () => {
    assert.equal(decideThreadOpen(false, false), "open");
    assert.equal(decideThreadOpen(false, true), "open");
});

// --- bounded live-body reacquire (no permanent rAF loop) -------------------------

test("settle runs exactly maxFrames ticks after arm and then stops", () => {
    const frames = frameQueue();
    let ticks = 0;
    const settle = createBoundedSettle(
        (cb) => frames.schedule(() => { ticks++; cb(); }),
        frames.cancel,
        3
    );
    settle.arm();
    assert.equal(frames.pending(), 1);
    frames.runAll();
    assert.equal(ticks, 3);
    assert.equal(frames.pending(), 0);
    frames.runAll();
    assert.equal(ticks, 3); // steady state: zero further work
});

test("settle never schedules a permanent loop", () => {
    const frames = frameQueue();
    let ticks = 0;
    const settle = createBoundedSettle(
        (cb) => frames.schedule(() => { ticks++; cb(); }),
        frames.cancel,
        5
    );
    settle.arm();
    frames.runAll();
    assert.equal(ticks, 5);
    assert.equal(frames.pending(), 0);
    frames.runAll();
    assert.equal(ticks, 5); // steady state: zero further work
});

test("settle cancel stops immediately and neutralises the scheduled tick", () => {
    const frames = frameQueue();
    let ticks = 0;
    const settle = createBoundedSettle(
        (cb) => frames.schedule(() => { ticks++; cb(); }),
        frames.cancel,
        5
    );
    settle.arm();
    settle.cancel();
    assert.ok(frames.cancelledCount >= 1);
    frames.runAll();
    assert.equal(ticks, 0);
});

test("re-arm mid-settle extends the window (bounded, not compounding)", () => {
    const frames = frameQueue();
    let ticks = 0;
    const settle = createBoundedSettle(
        (cb) => frames.schedule(() => { ticks++; cb(); }),
        frames.cancel,
        3
    );
    settle.arm();
    frames.runNext(); // tick 1
    settle.arm();     // refresh the count
    frames.runNext(); // tick 2
    frames.runNext(); // tick 3
    frames.runNext(); // tick 4
    assert.equal(ticks, 4);
    assert.equal(frames.pending(), 0);
    frames.runAll();
    assert.equal(ticks, 4);
});

// --- wiring (the seams stay narrow and non-revealing for internal re-entry) -------

test("threadTab: recursion no-op returns before any reveal; explicit refocus reveals", () => {
    const threadTab = source("../plugin/engine/threadTab.ts");
    assert.match(threadTab, /decideThreadOpen\(alreadyActive, explicit\)/);
    assert.match(threadTab, /if \(decision === "noop"\) \{/);
    // The no-op branch precedes the reveal calls: internal re-entry can never reveal.
    assert.match(threadTab, /if \(decision === "noop"\) \{[\s\S]{0,80}return;[\s\S]{0,60}\}/);
    assert.match(threadTab, /if \(decision === "refocus"\) \{[\s\S]{0,140}host\.revealDock\(\);[\s\S]{0,80}selectThreadPortal\(threadId\);/);
    assert.match(threadTab, /if \(takesOverView\) host\.revealDock\(\)/);
    // The intent flag is consumed on the next open and never leaks.
    assert.match(threadTab, /const explicit = explicitThreadOpenPending;/);
    assert.match(threadTab, /explicitThreadOpenPending = false;/);
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
    assert.match(portal, /if \(body !== observedBody\) \{[\s\S]{0,400}settleSync\.arm\(\);/);
    assert.match(portal, /function startSync\(\): void \{[\s\S]{0,400}settleSync\.arm\(\);/);
    assert.match(portal, /settleSync\.cancel\(\);/);
    // showThreadPortal hides every non-selected portal (one visible portal invariant).
    assert.match(portal, /if \(id !== threadId\) \{[\s\S]{0,120}p\.node\.style\.display = "none";/);
});
