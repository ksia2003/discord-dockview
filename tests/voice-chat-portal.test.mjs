import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import retryModule from "../plugin/viewers/initialRenderRetry.ts";

const { createInitialRenderRetry } = retryModule;

function retryFixture({ maxAttempts = 180 } = {}) {
    const queue = [];
    const cancelled = new Set();
    let nextHandle = 0;
    let rendered = false;
    let current = true;
    let renderCalls = 0;
    let nativeCaptured = false;
    const schedule = callback => {
        const handle = ++nextHandle;
        queue.push({ handle, callback });
        return handle;
    };
    const cancel = handle => {
        cancelled.add(handle);
    };
    const runNext = () => {
        const pending = queue.shift();
        if (!pending || cancelled.has(pending.handle)) return false;
        pending.callback();
        return true;
    };
    const controller = createInitialRenderRetry({
        isCurrent: () => current,
        isRendered: () => rendered,
        render: () => {
            renderCalls++;
            return nativeCaptured;
        },
        setRendered: value => { rendered = value; },
        request: schedule,
        cancel,
        maxAttempts
    });
    return {
        queue,
        cancelled,
        runNext,
        controller,
        stop: controller.cancel,
        set current(value) { current = value; },
        set nativeCaptured(value) { nativeCaptured = value; },
        get renderCalls() { return renderCalls; },
        get rendered() { return rendered; }
    };
}

test("voice initial render self-heals after late native capture", () => {
    const fixture = retryFixture();
    assert.equal(fixture.renderCalls, 0);
    assert.equal(fixture.queue.length, 1);

    fixture.nativeCaptured = true;
    assert.equal(fixture.runNext(), true);
    assert.equal(fixture.renderCalls, 1);
    assert.equal(fixture.rendered, true);
    assert.equal(fixture.queue.length, 0);
});

test("a successful voice render is not retried or rendered again", () => {
    const fixture = retryFixture();
    fixture.nativeCaptured = true;
    fixture.runNext();
    assert.equal(fixture.runNext(), false);
    assert.equal(fixture.renderCalls, 1);
});

test("voice initial render retries are bounded", () => {
    const fixture = retryFixture({ maxAttempts: 3 });
    assert.equal(fixture.runNext(), true);
    assert.equal(fixture.runNext(), true);
    assert.equal(fixture.runNext(), true);
    assert.equal(fixture.queue.length, 0);
    assert.equal(fixture.renderCalls, 3);
});

test("the production retry window is exactly 180 frames", () => {
    const fixture = retryFixture();
    for (let i = 0; i < 180; i++) assert.equal(fixture.runNext(), true);
    assert.equal(fixture.renderCalls, 180);
    assert.equal(fixture.queue.length, 0);
});

test("destroy cancellation makes a pending voice retry stale and harmless", () => {
    const fixture = retryFixture({ maxAttempts: 3 });
    const staleCallback = fixture.queue[0].callback;
    fixture.current = false;
    fixture.stop();
    assert.equal(fixture.cancelled.size, 1);
    staleCallback();
    assert.equal(fixture.runNext(), false);
    assert.equal(fixture.renderCalls, 0);
});

test("max exhaustion stays idle until one readiness arm, then self-heals", () => {
    const fixture = retryFixture({ maxAttempts: 3 });
    fixture.runNext();
    fixture.runNext();
    fixture.runNext();
    assert.equal(fixture.queue.length, 0);

    fixture.nativeCaptured = true;
    assert.equal(fixture.controller.arm(), true);
    assert.equal(fixture.queue.length, 1);
    fixture.runNext();
    assert.equal(fixture.rendered, true);
    assert.equal(fixture.queue.length, 0);
    assert.equal(fixture.controller.arm(), false);
});

test("a zero-handle synchronous scheduler is cancelled and never leaks a callback", () => {
    let renderCalls = 0;
    let current = true;
    let rendered = false;
    const cancelled = [];
    const controller = createInitialRenderRetry({
        isCurrent: () => current,
        isRendered: () => rendered,
        render: () => {
            renderCalls++;
            return true;
        },
        setRendered: value => { rendered = value; },
        request: callback => { callback(); return 0; },
        cancel: handle => { cancelled.push(handle); },
        maxAttempts: 3
    });

    assert.equal(renderCalls, 1);
    assert.equal(rendered, true);
    controller.cancel();
    assert.deepEqual(cancelled, []);
});

test("destroyed portal callback cannot affect a same-channel replacement", () => {
    const queue = [];
    const cancelled = new Set();
    let nextHandle = 0;
    let currentPortal = { id: "voice" };
    let renderCalls = 0;
    let rendered = false;
    const request = callback => {
        const handle = ++nextHandle;
        queue.push({ handle, callback });
        return handle;
    };
    const oldPortal = currentPortal;
    const controller = createInitialRenderRetry({
        isCurrent: () => currentPortal === oldPortal,
        isRendered: () => rendered,
        render: () => { renderCalls++; return false; },
        setRendered: value => { rendered = value; },
        request,
        cancel: handle => cancelled.add(handle),
        maxAttempts: 3
    });
    const staleCallback = queue[0].callback;
    currentPortal = { id: "voice" };
    controller.cancel();
    staleCallback();
    assert.equal(renderCalls, 0);
    assert.equal(cancelled.size, 1);
});

test("voice portal keeps the bounded controller/readiness and stale guards wired", () => {
    const portal = readFileSync(new URL("../plugin/viewers/voice/voiceChatPortal.ts", import.meta.url), "utf8");
    const capture = readFileSync(new URL("../plugin/host/voiceChatCapture.ts", import.meta.url), "utf8");
    assert.match(portal, /createInitialRenderRetry/);
    assert.match(portal, /subscribeVoiceChatReadiness/);
    assert.match(portal, /portal\.renderRetry\?\.arm\(\)/);
    assert.match(portal, /portals\.get\(channelId\) !== portal/);
    assert.match(portal, /cancelReadiness\(portal\)/);
    assert.match(capture, /store\.addChangeListener\(onChange\)/);
    assert.match(capture, /store\.removeChangeListener\(onChange\)/);
});
