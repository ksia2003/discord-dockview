/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getVencordUpdates, isStandaloneVencordInstall } from "../src/main/utils/vencordUpdateCheck.ts";
import { VENCORD_CORE_FILES } from "../src/shared/dockviewBundleFiles.ts";

const OLD_HASH = "fc5466e";
const NEW_HASH = "4b9c27d";
const API = "https://api.github.com/repos/Vendicated/Vencord";

async function writeCore(dir, hash, standalone = true) {
    await mkdir(dir, { recursive: true });
    for (const name of VENCORD_CORE_FILES) {
        const contents = name.endsWith(".js")
            ? `// Vencord ${hash}\n// Standalone: ${standalone}\nfixture:${name}\n`
            : `fixture:${name}\n`;
        await writeFile(join(dir, name), contents);
    }
}

function fakeFetch() {
    const calls = [];
    const fetch = async url => {
        calls.push(url);
        if (url === `${API}/releases/latest`) {
            return new Response(JSON.stringify({ name: `DevBuild ${NEW_HASH}` }));
        }
        if (url === `${API}/compare/${OLD_HASH}...${NEW_HASH}`) {
            return new Response(
                JSON.stringify({
                    commits: [
                        {
                            sha: NEW_HASH + "0".repeat(33),
                            author: { login: "Vencord" },
                            commit: { message: "Updater fixture" }
                        }
                    ]
                })
            );
        }
        throw new Error(`Unexpected URL ${url}`);
    };
    return { calls, fetch };
}

test("Vencord update checks are repeatable and never download or enqueue release assets", async t => {
    const root = await mkdtemp(join(tmpdir(), "dockview-vencord-check-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeCore(root, OLD_HASH);

    const transport = fakeFetch();
    const expected = [{ hash: NEW_HASH, author: "Vencord", message: "Updater fixture" }];

    assert.deepEqual(await getVencordUpdates(root, transport.fetch), expected);
    assert.deepEqual(await getVencordUpdates(root, transport.fetch), expected);
    assert.equal(transport.calls.some(url => url.includes("/releases/download/")), false);
});

test("Vencord update checks observe an applied on-disk revision without relaunch", async t => {
    const root = await mkdtemp(join(tmpdir(), "dockview-vencord-current-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeCore(root, NEW_HASH);

    const transport = fakeFetch();
    assert.deepEqual(await getVencordUpdates(root, transport.fetch), []);
    assert.deepEqual(transport.calls, [`${API}/releases/latest`]);
});

test("Vencord update checks reject mixed installed revisions", async t => {
    const root = await mkdtemp(join(tmpdir(), "dockview-vencord-mixed-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeCore(root, OLD_HASH);
    await writeFile(join(root, "vencordDesktopPreload.js"), `// Vencord ${NEW_HASH}\nfixture\n`);

    const transport = fakeFetch();
    await assert.rejects(getVencordUpdates(root, transport.fetch), /inconsistent revisions/);
    assert.equal(transport.calls.some(url => url.includes("/compare/")), false);
});

test("the check bridge can distinguish standalone and custom Git Vencord builds", async t => {
    const root = await mkdtemp(join(tmpdir(), "dockview-vencord-mode-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    await writeCore(root, OLD_HASH, true);
    assert.equal(await isStandaloneVencordInstall(root), true);

    await writeCore(root, OLD_HASH, false);
    assert.equal(await isStandaloneVencordInstall(root), false);
});
