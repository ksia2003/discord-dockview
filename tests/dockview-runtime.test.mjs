import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { DOCKVIEW_OUTPUT_FILES } from "../scripts/lib/vencordOutputs.mjs";

const runtime = await import("../static/dockviewDist/dockviewMain.js");

const sha256 = value => createHash("sha256").update(value).digest("hex");

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

test("DockView update and rollback never alter the separate Vencord runtime", async t => {
    const root = await mkdtemp(join(tmpdir(), "dockview-runtime-update-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const install = join(root, "dockviewFiles");
    const vencord = join(root, "vencordFiles");
    await Promise.all([mkdir(install), mkdir(vencord)]);
    for (const name of DOCKVIEW_OUTPUT_FILES) {
        await copyFile(join(process.cwd(), "static", "dockviewDist", name), join(install, name));
    }
    const vencordSentinel = join(vencord, "vencordDesktopMain.js");
    await writeFile(vencordSentinel, "// official Vencord sentinel\n");
    const vencordBefore = sha256(await readFile(vencordSentinel));
    const before = Object.fromEntries(
        await Promise.all(
            DOCKVIEW_OUTPUT_FILES.map(async name => [name, sha256(await readFile(join(install, name)))])
        )
    );

    const isolated = await import(`${pathToFileURL(join(install, "dockviewMain.js")).href}?fixture=${Date.now()}`);
    const originalVersion = await isolated.readInstalledVersion(null);
    const releaseBase = "https://github.com/ksia2003/discord-dockview/releases/download/v9.9.9";
    const manifestUrl = `${releaseBase}/manifest.json`;
    let manifest;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => {
        const href = String(url);
        if (href.includes("/api.github.com/") || href === "https://api.github.com/repos/ksia2003/discord-dockview/releases?per_page=30") {
            return new Response(
                JSON.stringify([
                    {
                        tag_name: "v9.9.9",
                        draft: false,
                        prerelease: true,
                        assets: [{ name: "manifest.json", browser_download_url: manifestUrl }]
                    }
                ])
            );
        }
        if (href === manifestUrl) return new Response(JSON.stringify(manifest));
        const name = href.slice(releaseBase.length + 1);
        const entry = manifest.files[name];
        if (!entry) return new Response("not found", { status: 404 });
        return new Response(entry.bytes);
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const targetBytes = Object.fromEntries(
        DOCKVIEW_OUTPUT_FILES.map(name => {
            const value =
                name === "version.txt"
                    ? Buffer.from(`dockview:9.9.9 v1.14.16 ${"a".repeat(40)}-${"b".repeat(64)}\n`)
                    : Buffer.from(`next DockView runtime: ${name}\n`);
            return [name, value];
        })
    );
    const validManifest = {
        schema: 2,
        pluginVersion: "9.9.9",
        runtimeAbi: 1,
        needsRelaunch: true,
        files: Object.fromEntries(
            Object.entries(targetBytes).map(([name, bytes]) => [
                name,
                { sha256: sha256(bytes), url: name, bytes }
            ])
        )
    };

    async function approve(value) {
        manifest = value;
        const found = await isolated.discoverManifest(null, "ksia2003", "discord-dockview", true);
        assert.equal(found.ok, true);
        return found;
    }

    const tampered = structuredClone(validManifest);
    const approved = await approve(tampered);
    approved.manifest.pluginVersion = "9.9.8";
    assert.match(
        (await isolated.applyUpdate(null, approved.manifest, approved.baseUrl)).error,
        /approval expired/
    );

    const wrongAbi = structuredClone(validManifest);
    wrongAbi.runtimeAbi = 2;
    const wrongAbiApproval = await approve(wrongAbi);
    assert.match(
        (await isolated.applyUpdate(null, wrongAbiApproval.manifest, wrongAbiApproval.baseUrl)).error,
        /requires runtime ABI 2/
    );

    const escaped = structuredClone(validManifest);
    escaped.files["vencordDesktopMain.js"] = {
        sha256: sha256(Buffer.from("not DockView")),
        url: "vencordDesktopMain.js",
        bytes: Buffer.from("not DockView")
    };
    const escapedApproval = await approve(escaped);
    assert.match(
        (await isolated.applyUpdate(null, escapedApproval.manifest, escapedApproval.baseUrl)).error,
        /disallowed file name/
    );

    const validApproval = await approve(validManifest);
    const applied = await isolated.applyUpdate(null, validApproval.manifest, validApproval.baseUrl);
    assert.deepEqual(applied, { ok: true, needsRelaunch: true });
    assert.equal(sha256(await readFile(vencordSentinel)), vencordBefore);
    assert.equal(await isolated.readRollbackVersion(null), originalVersion);
    for (const [name, bytes] of Object.entries(targetBytes)) {
        assert.equal(sha256(await readFile(join(install, name))), sha256(bytes), name);
    }

    const rolledBack = await isolated.rollbackUpdate(null);
    assert.deepEqual(rolledBack, { ok: true, needsRelaunch: true });
    assert.equal(sha256(await readFile(vencordSentinel)), vencordBefore);
    for (const [name, digest] of Object.entries(before)) {
        assert.equal(sha256(await readFile(join(install, name))), digest, name);
    }
    await assert.rejects(readFile(join(install, ".dockview-update-in-progress")), /ENOENT/);
});
