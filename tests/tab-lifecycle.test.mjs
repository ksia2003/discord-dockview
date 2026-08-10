import assert from "node:assert/strict";
import test from "node:test";

import contentIdentityModule from "../plugin/engine/contentIdentity.ts";
import cacheOwnership from "../plugin/engine/cacheOwnership.ts";
import cacheState from "../plugin/engine/cacheState.ts";
import loadToken from "../plugin/engine/loadToken.ts";
import threadBinding from "../plugin/engine/threadBinding.ts";

const { contentIdentity } = contentIdentityModule;
const {
    collectRetiredEntries,
    discardStaleBlob,
    moveToShutdown,
    replaceCacheEntry,
    revokeUniqueBlobUrls,
    settleDetachedEntry,
    trackLoading,
    touchCurrentCacheEntry
} = cacheOwnership;
const { getWindowCacheState, updateSourceDescriptor, windowCacheEntry } = cacheState;
const { bump, nextToken } = loadToken;
const { shouldBindThreadToCurrentChannel } = threadBinding;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function makeWindow(id) {
    return {
        id,
        cacheStates: new Map(),
        content: { loading: false, error: null, value: null },
        activeCacheKey: null,
        activeCacheEntry: null
    };
}

function makeEntry(key = "image|https://cdn.discordapp.com/attachments/a/file.png") {
    return {
        key,
        name: "file.png",
        type: "image",
        url: "https://cdn.discordapp.com/attachments/a/file.png?ex=1&is=2&hm=3",
        sourceType: "image",
        sourceUrl: "https://cdn.discordapp.com/attachments/a/file.png?ex=1&is=2&hm=3",
        renderType: "image",
        renderUrl: "https://cdn.discordapp.com/attachments/a/file.png?ex=1&is=2&hm=3",
        loading: false,
        view: {}
    };
}

async function runDeferredLoad(win, token, work, onSuccess, onFailure) {
    win.content.loading = true;
    try {
        const value = await work;
        if (token.isCurrent()) {
            onSuccess(value);
            win.content.loading = false;
        }
    } catch (error) {
        if (token.isCurrent()) {
            onFailure(error);
            win.content.loading = false;
        }
    }
}

test("window load tokens isolate deferred A from B and settle inactive success/failure", async () => {
    const a = makeWindow("A");
    const b = makeWindow("B");
    const aSuccess = deferred();
    const aFailure = deferred();
    const aToken = nextToken(a);
    const bToken = nextToken(b);
    const bBefore = { value: "B current", loading: false };
    b.content = bBefore;

    const successRun = runDeferredLoad(
        a,
        aToken,
        aSuccess.promise,
        value => { a.content.value = value; },
        error => { a.content.error = String(error.message); }
    );
    // A's loader is inactive while B starts/switches its own load. B's sequence is
    // independent, and the completion must not touch B's selected content.
    nextToken(b);
    aSuccess.resolve("A payload");
    await successRun;
    assert.equal(a.content.value, "A payload");
    assert.equal(a.content.loading, false);
    assert.equal(b.content.value, "B current");
    assert.equal(b.content.loading, false);
    assert.equal(bToken.isCurrent(), false);

    const provisionalTabs = [a];
    const failureToken = nextToken(a);
    const failureRun = runDeferredLoad(
        a,
        failureToken,
        aFailure.promise,
        value => { a.content.value = value; },
        error => {
            a.content.error = String(error.message);
            provisionalTabs.splice(provisionalTabs.indexOf(a), 1);
        }
    );
    aFailure.reject(new Error("A failed"));
    await failureRun;
    assert.deepEqual(provisionalTabs, []);
    assert.equal(a.content.error, "A failed");
    assert.equal(b.content.value, "B current");
});

test("closed window invalidates a late completion without leaving its spinner or writing content", async () => {
    const closed = makeWindow("closed");
    const late = deferred();
    const token = nextToken(closed);
    const run = runDeferredLoad(
        closed,
        token,
        late.promise,
        value => { closed.content.value = value; },
        error => { closed.content.error = String(error.message); }
    );
    bump(closed);
    late.resolve("late payload");
    await run;
    assert.equal(closed.content.value, null);
    assert.equal(closed.content.error, null);
    assert.equal(closed.content.loading, true, "the detached window is no longer a visible spinner");
    assert.equal(token.isCurrent(), false);
});

test("signed Discord URL rotation deduplicates one fetch, while web query/fragment and routing type stay distinct", () => {
    const q1 = "https://cdn.discordapp.com/attachments/1/file.png?ex=old&is=one&hm=aaa&width=900#page";
    const q2 = "https://cdn.discordapp.com/attachments/1/file.png?ex=new&is=two&hm=bbb&width=900#page";
    assert.equal(contentIdentity(q1, "image"), contentIdentity(q2, "image"));
    assert.notEqual(contentIdentity(q1, "image"), contentIdentity(q1, "raw"));

    const webA = "https://example.test/view?q=1#anchor-a";
    const webB = "https://example.test/view?q=2#anchor-b";
    assert.notEqual(contentIdentity(webA, "web"), contentIdentity(webB, "web"));
    assert.notEqual(contentIdentity(q1, "web"), contentIdentity(q2, "web"),
        "Discord CDN URLs opened as web tabs keep signed query identity exact");

    const fetched = new Map();
    let fetchCount = 0;
    for (const url of [q1, q2]) {
        const key = contentIdentity(url, "image");
        if (!fetched.has(key)) {
            fetchCount++;
            fetched.set(key, { source: url });
        }
    }
    assert.equal(fetchCount, 1);
});

test("source-linked signed refresh updates direct render URL without resetting view; converted payload stays a blob", () => {
    const direct = makeEntry();
    direct.view.imgScale = 2.5;
    const refreshed = "https://cdn.discordapp.com/attachments/a/file.png?ex=refresh&is=refresh&hm=refresh";
    updateSourceDescriptor(direct, refreshed, "image");
    assert.equal(direct.sourceUrl, refreshed);
    assert.equal(direct.url, refreshed);
    assert.equal(direct.renderUrl, refreshed);
    assert.equal(direct.renderType, "image");
    assert.equal(direct.view.imgScale, 2.5);

    const converted = makeEntry("postscript|https://cdn.discordapp.com/attachments/a/file.eps");
    converted.type = "postscript";
    converted.sourceType = "postscript";
    converted.sourceUrl = "https://cdn.discordapp.com/attachments/a/file.eps?ex=1&is=2&hm=3";
    converted.url = converted.sourceUrl;
    converted.renderType = "pdf";
    converted.renderUrl = "blob:pdf-q1";
    updateSourceDescriptor(converted, "https://cdn.discordapp.com/attachments/a/file.eps?ex=4&is=5&hm=6", "postscript");
    assert.equal(converted.sourceUrl.endsWith("hm=6"), true);
    assert.equal(converted.renderUrl, "blob:pdf-q1");
    assert.equal(converted.renderType, "pdf");
});

test("two windows keep same-identity zoom/scroll/edit/derived HTML independent, while one window preserves pinned state", () => {
    const a = makeWindow("A");
    const b = makeWindow("B");
    const entry = makeEntry();

    const aState = getWindowCacheState(a, entry.key);
    const bState = getWindowCacheState(b, entry.key);
    aState.view.imgScale = 3;
    aState.view.scrollTop = 420;
    aState.view.editBuffer = "A edit";
    aState.html = "<p>A derived</p>";
    aState.frameHtml = "<iframe>A</iframe>";
    bState.view.imgScale = 1.25;
    bState.view.scrollTop = 18;
    bState.view.editBuffer = "B edit";
    bState.html = "<p>B derived</p>";
    bState.frameHtml = "<iframe>B</iframe>";

    const aProjected = windowCacheEntry(a, entry);
    const bProjected = windowCacheEntry(b, entry);
    assert.equal(aProjected.view.imgScale, 3);
    assert.equal(aProjected.view.scrollTop, 420);
    assert.equal(aProjected.view.editBuffer, "A edit");
    assert.equal(aProjected.html, "<p>A derived</p>");
    assert.equal(aProjected.frameHtml, "<iframe>A</iframe>");
    assert.equal(bProjected.view.imgScale, 1.25);
    assert.equal(bProjected.view.scrollTop, 18);
    assert.equal(bProjected.view.editBuffer, "B edit");
    assert.equal(bProjected.html, "<p>B derived</p>");
    assert.equal(bProjected.frameHtml, "<iframe>B</iframe>");
    assert.notEqual(aProjected.view, bProjected.view);

    // A pinned tab remains the same DockWindow across channel strips, so its overlay
    // is intentionally retained when projected again.
    assert.equal(windowCacheEntry(a, entry).view.editBuffer, "A edit");
    assert.equal(windowCacheEntry(a, entry).view.imgScale, 3);
});

test("retired exact entry remains live, cacheTouch cannot resurrect it, and replacement disposes once", async () => {
    const oldEntry = makeEntry("image|same");
    const currentEntry = makeEntry("image|same");
    oldEntry.loading = true;
    const current = new Map([[oldEntry.key, oldEntry]]);
    const retired = new Set();
    const disposed = [];
    let live = new Set([oldEntry]);
    trackLoading(oldEntry, () => collectRetiredEntries(retired, live, entry => disposed.push(entry)));
    replaceCacheEntry(current, retired, currentEntry);
    collectRetiredEntries(retired, live, entry => disposed.push(entry));
    assert.equal(disposed.length, 0, "A's exact live payload cannot be disposed by B's retry");
    assert.equal(touchCurrentCacheEntry(current, oldEntry), false);
    assert.equal(current.get(oldEntry.key), currentEntry, "retired mount must not restore old global current");

    const late = deferred();
    const completion = late.promise.then(blobUrl => {
        oldEntry.renderUrl = blobUrl;
        oldEntry.loading = false;
    });
    // Pending async ownership protects an entry even if its window is closed before
    // the deferred decoder returns.
    collectRetiredEntries(retired, live, entry => disposed.push(entry));
    live = new Set();
    late.resolve("blob:late-doc");
    await completion;
    await Promise.resolve();
    collectRetiredEntries(retired, new Set(), entry => disposed.push(entry));
    assert.deepEqual(disposed, [oldEntry]);
    assert.equal(current.get(oldEntry.key), currentEntry);
});

test("plugin-stop shutdown-retired waits for deferred blob/doc settlement and disposes exactly once", async () => {
    const pending = makeEntry("pdf|same");
    pending.loading = true;
    const shutdown = new Set();
    const disposed = [];
    trackLoading(pending, () => collectRetiredEntries(shutdown, new Set(), entry => disposed.push(entry)));
    moveToShutdown([pending], shutdown, entry => disposed.push(entry), entry => entry.loading);
    assert.equal(disposed.length, 0);
    assert.equal(shutdown.has(pending), true);

    const late = deferred();
    const completion = late.promise.then(blobUrl => {
        pending.pdfDoc = { blobUrl };
        pending.loading = false;
    });
    collectRetiredEntries(shutdown, new Set([pending]), entry => disposed.push(entry));
    late.resolve("blob:shutdown-doc");
    await completion;
    await Promise.resolve();
    collectRetiredEntries(shutdown, new Set(), entry => disposed.push(entry));
    assert.equal(pending.pdfDoc.blobUrl, "blob:shutdown-doc");
    assert.deepEqual(disposed, [pending]);
});

test("background thread reopen binds only its parent strip", () => {
    assert.equal(shouldBindThreadToCurrentChannel("parent-a", "parent-b"), false);
    assert.equal(shouldBindThreadToCurrentChannel("parent-a", "parent-a"), true);
    assert.equal(shouldBindThreadToCurrentChannel(null, null), true);
});

test("viewer-like deferred shutdown success callbacks dispose and settle detached payloads without touching live content", async () => {
    const cases = [
        ["pdfDoc", { id: "pdf" }, value => value.destroyed = true],
        ["model3dObject", { id: "model" }, value => value.disposed = true],
        ["pptxPresentation", { id: "pptx" }, value => value.disposed = true],
        ["xlsxWorkbook", { names: ["Sheet1"] }, value => value.disposed = true]
    ];
    for (const [field, resource, dispose] of cases) {
        const entry = { loading: true, error: null, [field]: resource };
        const content = { value: null };
        const late = deferred();
        const completion = late.promise.then(payload => {
            const live = false; // cache stop removed the entry from live ownership
            if (!live) {
                dispose(payload);
                entry[field] = null;
                settleDetachedEntry(entry, "detached");
                return;
            }
            content.value = payload;
        });
        late.resolve(resource);
        await completion;
        assert.equal(entry.loading, false, field);
        assert.equal(entry.error, "detached", field);
        assert.equal(entry[field], null, field);
        assert.equal(content.value, null, field);
        assert.equal(resource.disposed || resource.destroyed, true, field);
    }
});

test("stale PostScript conversion revokes its blob and leaves the source descriptor retryable", async () => {
    const win = makeWindow("ps");
    const entry = makeEntry("postscript|same");
    entry.type = "postscript";
    entry.sourceType = "postscript";
    entry.renderType = "postscript";
    entry.renderUrl = entry.sourceUrl;
    entry.loading = true;
    const token = nextToken(win);
    const late = deferred();
    const revoked = [];
    const completion = late.promise.then(blobUrl => {
        if (!token.isCurrent()) {
            discardStaleBlob(entry, blobUrl, url => revoked.push(url), "stale");
            return;
        }
        entry.renderType = "pdf";
        entry.renderUrl = blobUrl;
    });
    bump(win);
    late.resolve("blob:stale-ps");
    await completion;
    assert.deepEqual(revoked, ["blob:stale-ps"]);
    assert.equal(entry.loading, false);
    assert.equal(entry.error, "stale");
    assert.equal(entry.renderType, "postscript");
    assert.equal(entry.renderUrl, entry.sourceUrl);
});

test("multi-page TIFF render URL is window-owned and duplicate blob URLs revoke once", () => {
    const entry = makeEntry("rasterimage|same");
    entry.type = "rasterimage";
    entry.sourceType = "rasterimage";
    entry.renderType = "rasterimage";
    entry.renderUrl = "blob:tiff-page-1";
    entry.rasterPageUrls = ["blob:tiff-page-1", "blob:tiff-page-2"];
    const a = makeWindow("tiff-a");
    const b = makeWindow("tiff-b");
    const aState = getWindowCacheState(a, entry.key);
    const bState = getWindowCacheState(b, entry.key);
    aState.view.rasterPage = 2;
    aState.renderUrl = "blob:tiff-page-2";
    bState.view.rasterPage = 1;
    bState.renderUrl = "blob:tiff-page-1";
    assert.equal(windowCacheEntry(a, entry).renderUrl, "blob:tiff-page-2");
    assert.equal(windowCacheEntry(b, entry).renderUrl, "blob:tiff-page-1");
    assert.equal(entry.renderUrl, "blob:tiff-page-1");
    bState.view.rasterPage = 2;
    bState.renderUrl = "blob:tiff-page-2";
    assert.equal(windowCacheEntry(b, entry).renderUrl, "blob:tiff-page-2");
    assert.equal(windowCacheEntry(a, entry).view.rasterPage, 2);

    const fresh = makeWindow("tiff-fresh");
    const freshEntry = { ...entry, view: {} };
    const freshProjected = windowCacheEntry(fresh, freshEntry);
    assert.equal(freshProjected.view.rasterPage, 1);
    assert.equal(freshProjected.renderUrl, "blob:tiff-page-1");
    assert.equal(getWindowCacheState(fresh, freshEntry.key).renderUrl, "blob:tiff-page-1");

    const revoked = [];
    revokeUniqueBlobUrls(
        [entry.renderUrl, ...entry.rasterPageUrls, "blob:tiff-page-2"],
        url => revoked.push(url)
    );
    assert.deepEqual(revoked, ["blob:tiff-page-1", "blob:tiff-page-2"]);
});
