import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import hostSelection from "../plugin/host/hostSelection.ts";

const {
    HOST_ID, clearDockHostState, findPageInnerForHost, isDockHostTreeActive,
    selectDockHost, setLiveHost
} = hostSelection;

function fixtureTree({ display = "block", inner = false } = {}) {
    const chat = { className: "chat_fixture" };
    return {
        isConnected: true,
        parentElement: null,
        className: inner ? "dockview-page-inner" : "page_fixture",
        style: { display, visibility: "" },
        children: [chat]
    };
}

function fixtureHost(tree, { connected = true } = {}) {
    const classes = new Set(["discord-owned-class", "dockview-open", "dockview-host--compact", "dockview-host--floating"]);
    const style = {
        display: "none",
        flex: "0 0 560px",
        width: "560px",
        background: "discord-owned-style",
        removeProperty(name) { this[name] = ""; }
    };
    return {
        isConnected: connected,
        parentElement: tree,
        style,
        classList: {
            remove(...names) { names.forEach(name => classes.delete(name)); },
            contains(name) { return classes.has(name); }
        },
        classes,
        offsetParent: null
    };
}

function withDocument(nodes, callback) {
    const prior = globalThis.document;
    globalThis.document = {
        querySelectorAll(selector) {
            assert.equal(selector, `#${HOST_ID}`);
            return nodes;
        }
    };
    try {
        return callback();
    } finally {
        setLiveHost(null);
        if (prior === undefined) delete globalThis.document;
        else globalThis.document = prior;
    }
}

test("an active parent tree wins when every host itself is display:none", () => {
    const hiddenTree = fixtureTree({ display: "none" });
    const activeTree = fixtureTree();
    const staleHidden = fixtureHost(hiddenTree);
    const active = fixtureHost(activeTree);

    withDocument([staleHidden, active], () => {
        assert.equal(staleHidden.style.display, "none");
        assert.equal(active.style.display, "none");
        assert.strictEqual(selectDockHost(), active);
    });
});

test("F9-hidden host keeps the same live binding while its parent tree stays active", () => {
    const activeTree = fixtureTree();
    const live = fixtureHost(activeTree);

    withDocument([live], () => {
        setLiveHost(live);
        assert.equal(isDockHostTreeActive(live), true);
        assert.strictEqual(selectDockHost(), live);
    });
});

test("an inactive live tree rebinds selection to the active duplicate", () => {
    const hiddenTree = fixtureTree({ display: "none" });
    const activeTree = fixtureTree();
    const oldLive = fixtureHost(hiddenTree);
    const next = fixtureHost(activeTree);

    withDocument([oldLive, next], () => {
        setLiveHost(oldLive);
        assert.strictEqual(selectDockHost(), next);
        clearDockHostState(oldLive);
        setLiveHost(next);
        assert.strictEqual(selectDockHost(), next);
        assert.equal(oldLive.classes.has("dockview-open"), false);
        assert.equal(oldLive.style.flex, "");
        assert.equal(oldLive.style.width, "");
    });
});

test("retiring a host clears DockView state without touching Discord state", () => {
    const host = fixtureHost(fixtureTree());

    clearDockHostState(host);

    assert.equal(host.classes.has("dockview-open"), false);
    assert.equal(host.classes.has("dockview-host--compact"), false);
    assert.equal(host.classes.has("dockview-host--floating"), false);
    assert.equal(host.style.flex, "");
    assert.equal(host.style.width, "");
    assert.equal(host.classes.has("discord-owned-class"), true);
    assert.equal(host.style.background, "discord-owned-style");
});

test("host-affine page-inner lookup does not fall back to the first page", () => {
    const aInner = fixtureTree({ inner: true });
    const bInner = fixtureTree({ inner: true });
    const aHost = fixtureHost(aInner);
    const bHost = fixtureHost(bInner);

    assert.strictEqual(findPageInnerForHost(aHost), aInner);
    assert.strictEqual(findPageInnerForHost(bHost), bInner);
});

test("open and layout writes share the duplicate-safe selector", () => {
    const mount = readFileSync(new URL("../plugin/host/mount.ts", import.meta.url), "utf8");
    const layout = readFileSync(new URL("../plugin/host/layout.ts", import.meta.url), "utf8");
    assert.match(mount, /selectDockHost\(\)/);
    assert.match(mount, /if \(visible\) applyDockLayout\(host\);/);
    assert.match(layout, /export function applyDockLayout\(host: HTMLElement \| null = selectDockHost\(\)\)/);
    assert.match(layout, /const inner = findPageInner\(host\);/);
    assert.doesNotMatch(layout, /document\.getElementById\(HOST_ID\)/);
});
