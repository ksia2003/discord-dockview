import assert from "node:assert/strict";
import test from "node:test";

const runtime = await import("../static/dockviewDist/dockviewMain.js");

test("built DockView main implements Runtime ABI v1 and keeps legacy exports", async () => {
    assert.equal(runtime.DOCKVIEW_RUNTIME_ABI_VERSION, 1);
    assert.equal(typeof runtime.invoke, "function");
    assert.equal(typeof runtime.configureBrowserWindow, "function");
    assert.equal(typeof runtime.attachBrowserWindow, "function");
    for (const method of [
        "readInstalledVersion",
        "readChunk",
        "convertAttachment",
        "discoverManifest",
        "applyUpdate"
    ]) {
        assert.equal(typeof runtime[method], "function", method);
    }

    const options = { webPreferences: {} };
    runtime.configureBrowserWindow(options);
    assert.equal(options.webPreferences.webviewTag, true);
    assert.match(await runtime.invoke(null, "readInstalledVersion", []), /^dockview:/);
});

test("Runtime ABI dispatch rejects inherited, unknown, and malformed method calls", () => {
    assert.throws(() => runtime.invoke(null, "__proto__", []), /Unknown DockView runtime method/);
    assert.throws(() => runtime.invoke(null, "constructor", []), /Unknown DockView runtime method/);
    assert.throws(() => runtime.invoke(null, "notRegistered", []), /Unknown DockView runtime method/);
    assert.throws(() => runtime.invoke(null, "readChunk", "not-an-array"), /Invalid DockView runtime invocation/);
});
