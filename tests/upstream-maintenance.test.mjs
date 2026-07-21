import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
    fetchAllPages,
    formatReport,
    inspectUpstreams,
    parseStableTag,
    selectLatestStableRelease,
    selectLatestStableTag
} from "../scripts/check-upstream-updates.mjs";
import { pnpmInvocation, quoteWindowsCmdToken } from "../scripts/lib/commandInvocation.mjs";
import { dependencySpecs, VENCORD_DEPENDENCIES } from "../scripts/lib/vencordDependencies.mjs";
import { computeVencordBuildIdentity, VENCORD_BUILD_INPUT_FILES } from "../scripts/lib/vencordBuildIdentity.mjs";
import { inspectVencordBundle } from "../scripts/lib/vencordBundle.mjs";
import { readDockViewReleaseMetadata } from "../scripts/lib/readDockViewReleaseMetadata.mjs";
import {
    inspectVencordCheckout,
    VENCORD_CORE_OUTPUT_FILES,
    VENCORD_PROVENANCE_RECORD
} from "../scripts/lib/vencordProvenance.mjs";
import { VENCORD_COMMIT, VENCORD_REF } from "../scripts/lib/vencordRef.mjs";
import { VENCORD_OUTPUT_FILES } from "../scripts/lib/vencordOutputs.mjs";
import { replaceVencordRef } from "../scripts/set-vencord-ref.mjs";
import { AUTOMATION_MARKER } from "../scripts/sync-upstream-issues.mjs";
import { createCandidate, verifyCandidate, verifyGeneratedOutput } from "../scripts/vencord-candidate.mjs";

const CURRENT_PLUGIN_VERSION = readDockViewReleaseMetadata(process.cwd()).pluginVersion;

test("stable upstream release selection is numeric and excludes drafts and prereleases", () => {
    const latest = selectLatestStableRelease([
        { tag_name: "v1.9.9", draft: false, prerelease: false },
        { tag_name: "v1.10.0", draft: false, prerelease: false },
        { tag_name: "v2.0.0-beta.1", draft: false, prerelease: true },
        { tag_name: "v9.0.0", draft: true, prerelease: false }
    ]);
    assert.equal(latest.parsed.tag, "v1.10.0");
    assert.equal(latest.parsed.version, "1.10.0");
});

test("only plain numeric three-part upstream tags are accepted", () => {
    assert.deepEqual(parseStableTag("v1.14.16")?.parts, [1, 14, 16]);
    assert.deepEqual(parseStableTag("1.6.5")?.parts, [1, 6, 5]);
    assert.equal(parseStableTag("v1.14.16-beta.1"), null);
    assert.equal(parseStableTag("latest"), null);
});

test("Vencord stable versions are selected from Git tags, not GitHub releases", () => {
    const latest = selectLatestStableTag([
        { name: "devbuild" },
        { name: "v1.14.9" },
        { name: "v1.14.16", commit: { sha: "a".repeat(40) } }
    ]);
    assert.equal(latest.parsed.tag, "v1.14.16");
    assert.equal(latest.tag.commit.sha, "a".repeat(40));
});

test("Vencord pin updater changes one strict tag and full commit pair", () => {
    const source = 'export const VENCORD_REF = "v1.14.16";\n' + `export const VENCORD_COMMIT = "${"a".repeat(40)}";\n`;
    assert.equal(
        replaceVencordRef(source, "v1.14.17", "B".repeat(40)),
        'export const VENCORD_REF = "v1.14.17";\n' + `export const VENCORD_COMMIT = "${"b".repeat(40)}";\n`
    );
    assert.throws(() => replaceVencordRef(source, "main", "b".repeat(40)), /stable Vencord release tag/);
    assert.throws(() => replaceVencordRef(source, "v1.14.17", "short"), /full SHA/);
    assert.throws(() => replaceVencordRef(`${source}${source}`, "v1.14.17", "b".repeat(40)), /exactly one/);
});

test("Windows pnpm invocation uses cmd with strictly validated inert tokens", () => {
    const invocation = pnpmInvocation(["add", "-w", "@scope/package"], {
        platform: "win32",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" }
    });
    assert.equal(invocation.executable, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(invocation.args, ["/d", "/s", "/c", "pnpm add -w @scope/package"]);
    assert.throws(() => quoteWindowsCmdToken("package&whoami"), /Unsafe Windows command token/);
    assert.throws(
        () => pnpmInvocation(["add&whoami", "safe"], { platform: "win32", env: {} }),
        /Unsafe Windows command token/
    );
});

test("derived Vencord dependencies must exactly match explicit version pins", () => {
    const names = Object.keys(VENCORD_DEPENDENCIES);
    const specs = dependencySpecs(names);
    assert.equal(specs.length, names.length);
    assert.ok(specs.includes(`marked@${VENCORD_DEPENDENCIES.marked}`));
    assert.throws(() => dependencySpecs([...names, "unexpected-package"]), /missing: unexpected-package/);
    assert.throws(() => dependencySpecs(names.slice(1)), /unused:/);
});

test("candidate provenance binds exact source, Vencord pin, file set, and digests", () => {
    const directory = mkdtempSync(join(tmpdir(), "dockview-candidate-test-"));
    const buildIdentity = `${"c".repeat(40)}-${"d".repeat(64)}`;
    try {
        for (const file of VENCORD_OUTPUT_FILES) {
            writeFileSync(
                join(directory, file),
                file === "version.txt" ? `dockview:0.1.37 v1.14.17 ${buildIdentity}\n` : `fixture:${file}\n`
            );
        }
        createCandidate(directory, "a".repeat(40), "v1.14.17", "b".repeat(40));
        const verified = verifyCandidate(directory, "a".repeat(40), "v1.14.17", "b".repeat(40));
        assert.equal(verified.sourceCommit, "a".repeat(40));
        assert.equal(verified.buildIdentity, buildIdentity);
        writeFileSync(join(directory, VENCORD_OUTPUT_FILES[0]), "tampered\n");
        assert.throws(() => verifyCandidate(directory, "a".repeat(40), "v1.14.17", "b".repeat(40)), /digest mismatch/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("verify-generated accepts a complete tree without a persisted record", () => {
    const directory = mkdtempSync(join(tmpdir(), "dockview-generated-tree-test-"));
    const buildIdentity = computeVencordBuildIdentity(process.cwd());
    try {
        for (const file of VENCORD_OUTPUT_FILES) {
            writeFileSync(
                join(directory, file),
                file === "version.txt"
                    ? `dockview:${CURRENT_PLUGIN_VERSION} ${VENCORD_REF} ${buildIdentity}\n`
                    : file === "vencordDesktopRenderer.js"
                      ? "DockView generated verifier fixture\n"
                      : `fixture:${file}\n`
            );
        }
        assert.equal(verifyGeneratedOutput(directory).length, VENCORD_OUTPUT_FILES.length);
        assert.ok(VENCORD_OUTPUT_FILES.some(file => file.startsWith("chunk-")));

        const chunk = VENCORD_OUTPUT_FILES.find(file => file.startsWith("chunk-"));
        rmSync(join(directory, chunk), { force: true });
        assert.throws(() => verifyGeneratedOutput(directory), /file set mismatch/);
        writeFileSync(join(directory, chunk), `fixture:${chunk}\n`);
        writeFileSync(join(directory, "unexpected.js"), "unexpected\n");
        assert.throws(() => verifyGeneratedOutput(directory), /file set mismatch/);
        rmSync(join(directory, "unexpected.js"));

        writeFileSync(join(directory, "version.txt"), `dockview:0.1.36 ${VENCORD_REF} ${buildIdentity}\n`);
        assert.throws(() => verifyGeneratedOutput(directory), /version.txt plugin/);
        writeFileSync(
            join(directory, "version.txt"),
            `dockview:${CURRENT_PLUGIN_VERSION} ${VENCORD_REF} ${"a".repeat(40)}-${"b".repeat(64)}\n`
        );
        assert.throws(() => verifyGeneratedOutput(directory), /build provenance/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("generated bundle verification requires the exact output set and stable build provenance", () => {
    const directory = mkdtempSync(join(tmpdir(), "dockview-bundle-test-"));
    const buildIdentity = `${"c".repeat(40)}-${"d".repeat(64)}`;
    try {
        for (const file of VENCORD_OUTPUT_FILES) {
            writeFileSync(
                join(directory, file),
                file === "version.txt"
                    ? `dockview:0.1.37 ${VENCORD_REF} ${buildIdentity}\n`
                    : file === "vencordDesktopRenderer.js"
                      ? "DockView runtime fixture\n"
                      : `fixture:${file}\n`
            );
        }
        assert.equal(
            inspectVencordBundle(directory, {
                pluginVersion: "0.1.37",
                vencordRef: VENCORD_REF,
                buildIdentity
            }).current,
            true
        );
        writeFileSync(
            join(directory, "version.txt"),
            `dockview:0.1.37 ${VENCORD_REF} ${"c".repeat(40)}-${"e".repeat(64)}\n`
        );
        const stale = inspectVencordBundle(directory, {
            pluginVersion: "0.1.37",
            vencordRef: VENCORD_REF,
            buildIdentity
        });
        assert.equal(stale.current, false);
        assert.match(stale.reasons.join("; "), /build provenance/);

        writeFileSync(join(directory, "version.txt"), `dockview:0.1.37 ${VENCORD_REF} ${buildIdentity}\n`);
        const chunk = VENCORD_OUTPUT_FILES.find(file => file.startsWith("chunk-"));
        rmSync(join(directory, chunk), { force: true });
        const missing = inspectVencordBundle(directory, {
            pluginVersion: "0.1.37",
            vencordRef: VENCORD_REF,
            buildIdentity
        });
        assert.equal(missing.current, false);
        assert.match(missing.reasons.join("; "), /missing required output/);

        writeFileSync(join(directory, chunk), `fixture:${chunk}\n`);
        writeFileSync(join(directory, "unexpected.js"), "unexpected\n");
        const extra = inspectVencordBundle(directory, {
            pluginVersion: "0.1.37",
            vencordRef: VENCORD_REF,
            buildIdentity
        });
        assert.equal(extra.current, false);
        assert.match(extra.reasons.join("; "), /unexpected bundle output/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("git archive clean checkout uses the persisted record without requiring ignored chunks", () => {
    const repo = mkdtempSync(join(tmpdir(), "dockview-provenance-repo-"));
    const clean = mkdtempSync(join(tmpdir(), "dockview-provenance-clean-"));
    const buildIdentity = `${"c".repeat(40)}-${"d".repeat(64)}`;
    const sourceCommit = "e".repeat(40);
    const staticDir = join(repo, "static", "vencordDist");
    const recordPath = join(repo, VENCORD_PROVENANCE_RECORD);
    try {
        mkdirSync(staticDir, { recursive: true });
        for (const file of VENCORD_CORE_OUTPUT_FILES) {
            writeFileSync(
                join(staticDir, file),
                file === "version.txt"
                    ? `dockview:0.1.37 ${VENCORD_REF} ${buildIdentity}\n`
                    : file === "vencordDesktopRenderer.js"
                      ? "DockView clean checkout fixture\n"
                      : `core fixture:${file}\n`
            );
        }
        const files = Object.fromEntries(
            VENCORD_OUTPUT_FILES.map(file => [
                file,
                VENCORD_CORE_OUTPUT_FILES.includes(file)
                    ? createHash("sha256")
                          .update(readFileSync(join(staticDir, file)))
                          .digest("hex")
                    : createHash("sha256").update(`ignored chunk fixture:${file}`).digest("hex")
            ])
        );
        writeFileSync(
            recordPath,
            `${JSON.stringify(
                {
                    schemaVersion: 1,
                    sourceCommit,
                    vencordRef: VENCORD_REF,
                    vencordCommit: VENCORD_COMMIT,
                    buildIdentity,
                    files
                },
                null,
                2
            )}\n`
        );

        const git = args => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
        git(["init", "-q"]);
        git(["config", "user.name", "test"]);
        git(["config", "user.email", "test@example.invalid"]);
        git(["add", "static"]);
        git(["commit", "-qm", "post-merge fixture"]);
        const archive = execFileSync("git", ["archive", "HEAD"], { cwd: repo });
        execFileSync("tar", ["-xf", "-", "-C", clean], { input: archive });

        const options = {
            pluginVersion: "0.1.37",
            vencordRef: VENCORD_REF,
            vencordCommit: VENCORD_COMMIT,
            buildIdentity
        };
        const current = inspectVencordCheckout(
            join(clean, "static/vencordDist"),
            join(clean, VENCORD_PROVENANCE_RECORD),
            options
        );
        assert.equal(current.current, true);
        assert.deepEqual(current.presentChunks, []);
        assert.deepEqual(readdirSync(join(clean, "static/vencordDist")).sort(), [...VENCORD_CORE_OUTPUT_FILES].sort());

        const cleanRecord = join(clean, VENCORD_PROVENANCE_RECORD);
        const baseline = JSON.parse(readFileSync(cleanRecord, "utf-8"));
        const expectStale = (name, mutate, reason) => {
            const variant = structuredClone(baseline);
            mutate(variant);
            writeFileSync(cleanRecord, `${JSON.stringify(variant)}\n`);
            const stale = inspectVencordCheckout(join(clean, "static/vencordDist"), cleanRecord, options);
            assert.equal(stale.current, false, name);
            assert.match(stale.reasons.join("; "), reason, name);
        };
        rmSync(cleanRecord);
        const missingRecord = inspectVencordCheckout(join(clean, "static/vencordDist"), cleanRecord, options);
        assert.equal(missingRecord.current, false);
        assert.match(missingRecord.reasons.join("; "), /Could not read Vencord provenance/);
        writeFileSync(cleanRecord, `${JSON.stringify(baseline)}\n`);
        expectStale(
            "tampered record",
            variant => {
                variant.tampered = true;
            },
            /unexpected or missing top-level keys/
        );
        expectStale(
            "mismatched Vencord commit",
            variant => {
                variant.vencordCommit = "a".repeat(40);
            },
            /commit mismatch/
        );
        expectStale(
            "mismatched Vencord ref",
            variant => {
                variant.vencordRef = "v9.9.9";
            },
            /ref mismatch/
        );
        expectStale(
            "mismatched build identity",
            variant => {
                variant.buildIdentity = `${"a".repeat(40)}-${"b".repeat(64)}`;
            },
            /build identity mismatch/
        );
        expectStale(
            "mismatched tracked core hash",
            variant => {
                variant.files["version.txt"] = "f".repeat(64);
            },
            /tracked output digest mismatch/
        );
        expectStale(
            "incomplete chunk hash set",
            variant => {
                delete variant.files["chunk-samples.js"];
            },
            /exact runtime output key set/
        );
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(clean, { recursive: true, force: true });
    }
});

test("build identity ignores automation-only commits but changes with plugin input", () => {
    assert.deepEqual(
        ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].every(file =>
            VENCORD_BUILD_INPUT_FILES.includes(file)
        ),
        true
    );
    const root = mkdtempSync(join(tmpdir(), "dockview-build-identity-test-"));
    try {
        for (const file of VENCORD_BUILD_INPUT_FILES) {
            const path = join(root, file);
            mkdirSync(join(path, ".."), { recursive: true });
            writeFileSync(path, `fixture:${file}\n`);
        }
        mkdirSync(join(root, "plugin"), { recursive: true });
        writeFileSync(join(root, "plugin", "entry.ts"), "export const fixture = 1;\n");
        const git = args => execFileSync("git", args, { cwd: root, stdio: "ignore" });
        git(["init", "-q"]);
        git(["config", "user.name", "test"]);
        git(["config", "user.email", "test@example.invalid"]);
        git(["add", "--", ...VENCORD_BUILD_INPUT_FILES, "plugin/entry.ts"]);
        git(["commit", "-qm", "source"]);
        const sourceIdentity = computeVencordBuildIdentity(root);
        writeFileSync(join(root, "AUTOMATION.md"), "documentation only\n");
        git(["add", "--", "AUTOMATION.md"]);
        git(["commit", "-qm", "automation docs"]);
        assert.equal(computeVencordBuildIdentity(root), sourceIdentity);
        writeFileSync(join(root, "plugin", "entry.ts"), "export const fixture = 2;\n");
        git(["add", "--", "plugin/entry.ts"]);
        git(["commit", "-qm", "plugin change"]);
        assert.notEqual(computeVencordBuildIdentity(root), sourceIdentity);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("fresh package, test, and release paths regenerate the complete chunk set", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
    assert.match(packageJson.scripts.package, /prepareVencord/);
    assert.match(packageJson.scripts.package, /verify-generated static\/vencordDist/);
    assert.doesNotMatch(packageJson.scripts.package, /provenance\.json/);
    assert.match(packageJson.scripts["package:dir"], /prepareVencord/);
    assert.match(packageJson.scripts["package:dir"], /verify-generated static\/vencordDist/);
    assert.doesNotMatch(packageJson.scripts["package:dir"], /provenance\.json/);
    const testWorkflow = readFileSync(join(process.cwd(), ".github/workflows/test.yml"), "utf-8");
    assert.match(testWorkflow, /pnpm prepareVencord/);
    assert.match(testWorkflow, /node scripts\/vencord-candidate\.mjs verify-generated static\/vencordDist/);
    const releaseWorkflow = readFileSync(join(process.cwd(), ".github/workflows/release.yml"), "utf-8");
    assert.match(releaseWorkflow, /node scripts\/prepare-vencord\.mjs/);
    assert.match(releaseWorkflow, /verify-generated static\/vencordDist/);
    assert.match(releaseWorkflow, /gh release create "\$TAG" --verify-tag --prerelease/);
    assert.match(releaseWorkflow, /needs:\s*prepare-release/);
    assert.match(releaseWorkflow, /fail-fast:\s*false/);
    assert.match(releaseWorkflow, /CSC_IDENTITY_AUTO_DISCOVERY=false/);
    assert.match(releaseWorkflow, /--config\.mac\.notarize=false/);
    assert.doesNotMatch(releaseWorkflow, /electron-builder[^\n]*--publish always/);
    assert.equal((releaseWorkflow.match(/electron-builder[^\n]*--publish never/g) ?? []).length, 3);
    assert.match(releaseWorkflow, /gh release upload "\$TAG" "\$\{files\[@\]\}" --clobber/);
    assert.match(releaseWorkflow, /dist\/\*\.dmg/);
    assert.match(releaseWorkflow, /dist\/\*\.blockmap/);
    assert.doesNotMatch(releaseWorkflow, /verify-output|provenance\.json/);
    for (const workflow of ["meta.yml", "update-vencord-dev.yml", "winget-submission.yml"])
        assert.equal(existsSync(join(process.cwd(), ".github/workflows", workflow)), false);
    assert.ok(
        VENCORD_OUTPUT_FILES.every(
            file => file === "version.txt" || file.startsWith("vencordDesktop") || file.startsWith("chunk-")
        )
    );
    const maintenanceWorkflow = readFileSync(
        join(process.cwd(), ".github/workflows/upstream-maintenance.yml"),
        "utf-8"
    );
    assert.match(maintenanceWorkflow, /always\(\)\s*&&\s*needs\.detect\.result == 'failure'/);
    assert.match(maintenanceWorkflow, /node scripts\/vencord-candidate\.mjs verify-generated static\/vencordDist/);
    assert.match(maintenanceWorkflow, /static\/vencordDist\.provenance\.json/);
    const artifactVerify = maintenanceWorkflow.indexOf(
        'node scripts/vencord-candidate.mjs verify "$RUNNER_TEMP/candidate"'
    );
    const recordCopy = maintenanceWorkflow.indexOf('cp -- "$RUNNER_TEMP/candidate/candidate-provenance.json"');
    assert.ok(artifactVerify >= 0 && artifactVerify < recordCopy);
});

async function runIssueSynchronizer(handler, envOverrides) {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const root = mkdtempSync(join(tmpdir(), "dockview-upstream-issues-test-"));
    const report = join(root, "report.md");
    writeFileSync(report, "upstream test report\n");
    const child = spawn(process.execPath, ["scripts/sync-upstream-issues.mjs", "sync"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            GH_TOKEN: "test-token",
            GITHUB_REPOSITORY: "acme/repo",
            UPSTREAM_API_ROOT: `http://127.0.0.1:${address.port}`,
            UPSTREAM_REPORT: report,
            VENCORD_UPDATE: "true",
            VESKTOP_UPDATE: "false",
            ...envOverrides
        }
    });
    const [exitCode] = await once(child, "close");
    server.close();
    rmSync(root, { recursive: true, force: true });
    return exitCode;
}

async function runFailureSynchronizer(handler) {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const child = spawn(process.execPath, ["scripts/sync-upstream-issues.mjs", "failure"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            GH_TOKEN: "test-token",
            GITHUB_REPOSITORY: "acme/repo",
            UPSTREAM_API_ROOT: `http://127.0.0.1:${address.port}`,
            UPSTREAM_REPORT: "",
            UPSTREAM_FAILURE_BODY: "detection failed in test"
        }
    });
    const [exitCode] = await once(child, "close");
    server.close();
    return exitCode;
}

test("issue enumeration failure never creates a tracker or treats the list as empty", async () => {
    const requests = [];
    const exitCode = await runIssueSynchronizer((request, response) => {
        requests.push({ method: request.method, url: request.url });
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "simulated API outage" }));
    });
    assert.notEqual(exitCode, 0);
    assert.ok(requests.length >= 1);
    assert.ok(requests.every(request => request.method === "GET"));
});

test("detection failure creates a durable overdue tracker when the API is available", async () => {
    const requests = [];
    const exitCode = await runFailureSynchronizer((request, response) => {
        requests.push({ method: request.method, url: request.url });
        const path = request.url.split("?", 1)[0];
        if (request.method === "GET" && path.endsWith("/issues")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end("[]");
            return;
        }
        if (request.method === "GET" && path.includes("/labels/")) {
            response.writeHead(404, { "content-type": "application/json" });
            response.end(JSON.stringify({ message: "Not Found" }));
            return;
        }
        if (request.method === "POST" && path.endsWith("/labels")) {
            response.writeHead(201, { "content-type": "application/json" });
            response.end(JSON.stringify({ name: path.split("/").pop() }));
            return;
        }
        if (request.method === "POST" && path.endsWith("/issues")) {
            response.writeHead(201, { "content-type": "application/json" });
            response.end(JSON.stringify({ number: 7, created_at: "2026-07-21T00:00:00Z" }));
            return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
    });
    assert.equal(exitCode, 0);
    assert.ok(requests.some(request => request.method === "POST" && request.url.endsWith("/issues")));
    assert.ok(requests.some(request => request.method === "PUT" && request.url.endsWith("/issues/7/labels")));
});

test("duplicate issue enumeration chooses the oldest canonical tracker before mutation", async () => {
    const requests = [];
    const issues = [
        {
            number: 2,
            title: "[upstream] Vencord stable update pending",
            created_at: "2026-01-01T00:00:00Z",
            body: `${AUTOMATION_MARKER}\n\nmanaged issue`,
            labels: [{ name: "upstream-maintenance" }, { name: "upstream-vencord" }]
        },
        {
            number: 3,
            title: "[upstream] Vencord stable update pending",
            created_at: "2026-02-01T00:00:00Z",
            body: `${AUTOMATION_MARKER}\n\nmanaged duplicate`,
            labels: [{ name: "upstream-maintenance" }, { name: "upstream-vencord" }]
        }
    ];
    const exitCode = await runIssueSynchronizer((request, response) => {
        requests.push({ method: request.method, url: request.url });
        const path = request.url.split("?", 1)[0];
        if (request.method === "GET" && path.endsWith("/issues")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(issues));
            return;
        }
        if (request.method === "GET" && path.includes("/labels/")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ name: path.split("/").pop() }));
            return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
    });
    assert.equal(exitCode, 0);
    assert.ok(requests.some(request => request.method === "POST" && request.url.endsWith("/issues/3/comments")));
    assert.ok(requests.some(request => request.method === "PATCH" && request.url.endsWith("/issues/3")));
    assert.ok(requests.some(request => request.method === "PATCH" && request.url.endsWith("/issues/2")));
    assert.ok(!requests.some(request => request.method === "POST" && request.url.endsWith("/issues")));
});

test("human exact-title issues are not mutated without the automation marker", async () => {
    const requests = [];
    const humanIssue = {
        number: 11,
        title: "[upstream] Vencord stable update pending",
        created_at: "2026-01-01T00:00:00Z",
        body: "A maintainer wrote this issue by hand."
    };
    const exitCode = await runIssueSynchronizer((request, response) => {
        requests.push({ method: request.method, url: request.url });
        const path = request.url.split("?", 1)[0];
        if (request.method === "GET" && path.endsWith("/issues")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify([humanIssue]));
            return;
        }
        if (request.method === "POST" && path.endsWith("/issues")) {
            response.writeHead(201, { "content-type": "application/json" });
            response.end(JSON.stringify({ number: 12, created_at: "2026-07-21T00:00:00Z" }));
            return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
    });
    assert.equal(exitCode, 0);
    assert.ok(requests.some(request => request.method === "POST" && request.url.endsWith("/issues")));
    assert.ok(!requests.some(request => /\/issues\/11(?:\/|$)/.test(request.url) && request.method !== "GET"));
});

test("paginated GitHub arrays are combined without silently truncating", async () => {
    const fetchImpl = async url => {
        const page = Number(new URL(url).searchParams.get("page"));
        const body = page === 1 ? [{ name: "v1.0.0" }, { name: "v1.1.0" }] : [{ name: "v1.2.0" }];
        return { ok: true, status: 200, json: async () => body };
    };
    const result = await fetchAllPages(fetchImpl, "/repos/example/project/tags", "token", { pageSize: 2 });
    assert.deepEqual(
        result.map(tag => tag.name),
        ["v1.0.0", "v1.1.0", "v1.2.0"]
    );
});

test("upstream report distinguishes automatic Vencord candidates from Vesktop review", () => {
    const result = {
        checkedAt: "2026-07-21T00:00:00.000Z",
        vencord: {
            currentRef: "v1.14.16",
            currentCommit: "a".repeat(40),
            latestRef: "v1.14.17",
            latestCommit: "b".repeat(40),
            updateAvailable: true
        },
        vesktop: {
            currentVersion: "1.6.5",
            latestVersion: "1.6.5",
            reviewedVersion: "1.6.5",
            defaultBranch: "main",
            currentCommit: "a".repeat(40),
            reviewedCommit: "a".repeat(40),
            headCommit: "b".repeat(40),
            releaseUpdateAvailable: false,
            headUpdateAvailable: true
        }
    };
    const report = formatReport(result);
    assert.match(report, /candidate PR required/);
    assert.match(report, /source review required/);
    assert.match(report, /never merged automatically/);
});

test("live inspection compares Vencord tags and Vesktop review cursors", async () => {
    const responses = new Map([
        [
            "/repos/Vendicated/Vencord/tags?per_page=100&page=1",
            [{ name: VENCORD_REF, commit: { sha: VENCORD_COMMIT } }]
        ],
        [
            "/repos/Vencord/Vesktop/releases?per_page=100&page=1",
            [{ tag_name: "v1.6.5", draft: false, prerelease: false }]
        ],
        ["/repos/Vencord/Vesktop", { default_branch: "main" }],
        ["/repos/Vencord/Vesktop/commits/main", { sha: "f".repeat(40) }]
    ]);
    const fetchImpl = async url => {
        const path = new URL(url).pathname + new URL(url).search;
        const body = responses.get(path);
        return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
    };

    const result = await inspectUpstreams({ fetchImpl, token: "test-token" });
    assert.equal(result.vencord.updateAvailable, true);
    assert.equal(result.vencord.bundleCurrent, false);
    assert.equal(result.vencord.latestCommit, VENCORD_COMMIT);
    assert.equal(result.vesktop.releaseUpdateAvailable, false);
    assert.equal(result.vesktop.headUpdateAvailable, true);
    assert.equal(result.vesktop.updateAvailable, true);
});

test("live inspection detects a stable Vencord tag moved to a different commit", async () => {
    const responses = new Map([
        [
            "/repos/Vendicated/Vencord/tags?per_page=100&page=1",
            [{ name: VENCORD_REF, commit: { sha: "0".repeat(40) } }]
        ],
        [
            "/repos/Vencord/Vesktop/releases?per_page=100&page=1",
            [{ tag_name: "v1.6.5", draft: false, prerelease: false }]
        ],
        ["/repos/Vencord/Vesktop", { default_branch: "main" }],
        ["/repos/Vencord/Vesktop/commits/main", { sha: "f".repeat(40) }]
    ]);
    const fetchImpl = async url => {
        const parsed = new URL(url);
        const body = responses.get(parsed.pathname + parsed.search);
        return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
    };

    const result = await inspectUpstreams({ fetchImpl, token: "test-token" });
    assert.equal(result.vencord.currentRef, result.vencord.latestRef);
    assert.equal(result.vencord.updateAvailable, true);
});
