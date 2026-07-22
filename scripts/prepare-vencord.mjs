/*
 * DockView build helper
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Reproducibly builds the pinned, unmodified Vencord desktop runtime and the
 * independent DockView runtime. The two output trees are deliberately disjoint:
 * static/vencordDist and static/dockviewDist.
 *
 * Usage:
 *   node scripts/prepare-vencord.mjs
 *
 * Env overrides:
 *   VENCORD_REF        git ref/tag of Vencord to build      (default: scripts/lib/vencordRef.mjs)
 *   VENCORD_EXPECTED_COMMIT full SHA required for an overridden ref (optional)
 *   SKIP_VENCORD_BUILD if set, skip cloning/building and just verify output
 */

import { execFileSync } from "child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync
} from "fs";
import { builtinModules } from "module";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { pnpmInvocation } from "./lib/commandInvocation.mjs";
import { computeVencordBuildIdentity } from "./lib/vencordBuildIdentity.mjs";
import { readDockViewReleaseMetadata } from "./lib/readDockViewReleaseMetadata.mjs";
import { dependencySpecs } from "./lib/vencordDependencies.mjs";
import { VENCORD_COMMIT as PINNED_VENCORD_COMMIT, VENCORD_REF as PINNED_VENCORD_REF } from "./lib/vencordRef.mjs";
import { VENCORD_OUTPUT_FILES } from "./lib/vencordOutputs.mjs";
import { assertRuntimeBundles } from "./lib/runtimeBundles.mjs";

// Node builtins (with and without the "node:" prefix). The plugin runs in the
// renderer and shouldn't import these, but guard against future drift.
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RELEASE_METADATA = readDockViewReleaseMetadata(ROOT);

const VENCORD_REPO = "https://github.com/Vendicated/Vencord";
const VENCORD_REF = process.env.VENCORD_REF || PINNED_VENCORD_REF;
const VENCORD_EXPECTED_COMMIT = process.env.VENCORD_REF ? process.env.VENCORD_EXPECTED_COMMIT : PINNED_VENCORD_COMMIT;

const PNPM = "pnpm";

// DockView source, shipped in this repo and built independently.
const PLUGIN_SRC = join(ROOT, "plugin");

// Import prefixes that Vencord already provides — never `pnpm add` these.
// (Vencord aliases + the React runtime + node builtins.)
const VENCORD_PROVIDED_PREFIXES = ["@webpack", "@utils/", "@api/", "@components/", "@vencord/"];
const VENCORD_PROVIDED_EXACT = new Set(["react", "react-dom", "@webpack", "@webpack/common"]);

// Pull the package name out of a bare import specifier.
//   "pdfjs-dist/build/pdf.worker.mjs" -> "pdfjs-dist"
//   "@codemirror/lang-js"             -> "@codemirror/lang-js"  (scoped: keep scope + first segment)
//   "react-dom/client"               -> "react-dom"
function packageNameOf(spec) {
    if (spec.startsWith("@")) {
        const [scope, name] = spec.split("/");
        return name ? `${scope}/${name}` : scope;
    }
    return spec.split("/")[0];
}

function isExternalPackage(spec) {
    // Relative imports are our own modules.
    if (spec.startsWith(".") || spec.startsWith("/")) return false;
    // Node builtins (provided by the runtime, not npm).
    if (NODE_BUILTINS.has(spec)) return false;
    // Vencord-provided runtime/aliases.
    if (VENCORD_PROVIDED_EXACT.has(spec)) return false;
    if (VENCORD_PROVIDED_PREFIXES.some(p => spec === p || spec.startsWith(p))) return false;
    const pkg = packageNameOf(spec);
    if (NODE_BUILTINS.has(pkg)) return false;
    if (VENCORD_PROVIDED_EXACT.has(pkg)) return false;
    return true;
}

// Recursively collect plugin/**/*.{ts,tsx}.
function collectSources(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            out.push(...collectSources(full));
        } else if (/\.tsx?$/.test(name)) {
            out.push(full);
        }
    }
    return out;
}

// Scan the plugin source for the external npm packages it imports, so the
// dep list can never drift out of sync with the code again. We catch three
// shapes: static `from "X"`, side-effect `import "X"`, and dynamic `import("X")`.
function deriveDockviewDeps() {
    // `from "X"` / `import "X"` (single or double quoted).
    const fromRe = /\bfrom\s*["']([^"']+)["']/g;
    const bareImportRe = /\bimport\s*["']([^"']+)["']/g;
    // `import("X")` dynamic import.
    const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

    const deps = new Set();
    for (const file of collectSources(PLUGIN_SRC)) {
        const raw = readFileSync(file, "utf-8");
        // Strip comments before scanning so illustrative specifiers written out
        // in doc comments (a dynamic import shown in prose) are never mistaken
        // for real dependencies. The `[^:]` guard keeps `://` inside a URL from
        // eating the rest of the line as a line comment.
        const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
        for (const re of [fromRe, bareImportRe, dynamicRe]) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(src)) !== null) {
                let spec = m[1];
                // Strip Vencord's `?managed` (and any other) query suffix.
                spec = spec.split("?")[0];
                if (!spec || !isExternalPackage(spec)) continue;
                deps.add(packageNameOf(spec));
            }
        }
    }
    return [...deps].sort();
}

// Extra deps DockView needs that aren't in stock Vencord, derived from the
// plugin source at build time (no hand-maintained array to go stale).
const DOCKVIEW_DEPS = deriveDockviewDeps();
const DOCKVIEW_DEP_SPECS = dependencySpecs(DOCKVIEW_DEPS);

const VENCORD_OUT_DIR = join(ROOT, "static", "vencordDist");
const DOCKVIEW_OUT_DIR = join(ROOT, "static", "dockviewDist");

// Print the derived deps so a build log is auditable — if the plugin grows a
// new import, it shows up here without anyone touching this script.
console.log(`Derived DockView deps (${DOCKVIEW_DEPS.length}) from plugin/ imports:`);
for (const dep of DOCKVIEW_DEPS) console.log(`  - ${dep}`);
if (DOCKVIEW_DEPS.length === 0) {
    throw new Error("No external deps derived from plugin/ — scanner is broken or plugin/ is empty.");
}

function run(cmd, args, cwd, extraEnv) {
    console.log(`$ ${cmd} ${args.join(" ")}  (cwd: ${cwd})`);
    const invocation = cmd === PNPM ? pnpmInvocation(args) : { executable: cmd, args };

    execFileSync(invocation.executable, invocation.args, {
        cwd,
        stdio: "inherit",
        env: { ...process.env, ...extraEnv }
    });
}

function verifyOutput() {
    assertRuntimeBundles(ROOT, {
        pluginVersion: RELEASE_METADATA.pluginVersion,
        vencordRef: VENCORD_REF,
        buildIdentity: BUILD_IDENTITY
    });
    console.log(`✔ official Vencord and independent DockView outputs verified; build identity ${BUILD_IDENTITY}`);
}

const BUILD_IDENTITY = (() => {
    try {
        return computeVencordBuildIdentity(ROOT);
    } catch (error) {
        throw new Error(`Could not determine stable DockView build identity: ${error.message}`);
    }
})();

if (process.env.SKIP_VENCORD_BUILD) {
    verifyOutput();
    process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "dockview-vencord-"));
const vencordDir = join(work, "Vencord");

try {
    console.log(`Working in ${work}`);

    // 1. Clone Vencord at the pinned ref.
    run("git", ["clone", "--depth", "1", "--branch", VENCORD_REF, VENCORD_REPO, vencordDir], work);
    if (VENCORD_EXPECTED_COMMIT) {
        if (!/^[0-9a-f]{40}$/i.test(VENCORD_EXPECTED_COMMIT)) {
            throw new Error(`Expected Vencord commit is not a full SHA: ${VENCORD_EXPECTED_COMMIT}`);
        }
        const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: vencordDir,
            encoding: "utf-8"
        })
            .trim()
            .toLowerCase();
        if (actualCommit !== VENCORD_EXPECTED_COMMIT.toLowerCase()) {
            throw new Error(
                `Vencord ref ${VENCORD_REF} resolved to ${actualCommit}, expected ${VENCORD_EXPECTED_COMMIT.toLowerCase()}`
            );
        }
        console.log(`✔ Vencord ref ${VENCORD_REF} resolved to pinned commit ${actualCommit}`);
    }

    // 2. Install and build the pinned official source without copying or patching
    //    DockView into the checkout.
    run(PNPM, ["install", "--frozen-lockfile"], vencordDir);
    run(PNPM, ["build"], vencordDir);

    rmSync(VENCORD_OUT_DIR, { recursive: true, force: true });
    mkdirSync(VENCORD_OUT_DIR, { recursive: true });
    for (const file of VENCORD_OUTPUT_FILES) {
        cpSync(join(vencordDir, "dist", file), join(VENCORD_OUT_DIR, file));
    }

    // 3. Install DockView's exact extra dependencies into the disposable checkout.
    //    This happens only after the official Vencord bytes have been built/copied.
    if (!existsSync(PLUGIN_SRC)) throw new Error(`Plugin source not found: ${PLUGIN_SRC}`);
    run(PNPM, ["add", "-w", "--save-exact", ...DOCKVIEW_DEP_SPECS], vencordDir);

    // 4. Build the independent DockView renderer/main and lazy chunks.
    rmSync(DOCKVIEW_OUT_DIR, { recursive: true, force: true });
    mkdirSync(DOCKVIEW_OUT_DIR, { recursive: true });
    run("node", [join(__dirname, "build-dockview.mjs"), vencordDir, DOCKVIEW_OUT_DIR], ROOT);

    run("node", [join(__dirname, "build-chunks.mjs"), vencordDir, DOCKVIEW_OUT_DIR], ROOT, {
        DOCKVIEW_CHUNK_REGISTRY: join(PLUGIN_SRC, "engine", "chunkRegistry.ts"),
        DOCKVIEW_PLUGIN_DIR: PLUGIN_SRC
    });

    run("node", [join(__dirname, "build-sample-chunk.mjs"), DOCKVIEW_OUT_DIR], ROOT, {
        DOCKVIEW_SAMPLES_DIR: join(PLUGIN_SRC, "gallery", "samples")
    });

    // 5. Stamp only the DockView-owned tree.
    const ver = RELEASE_METADATA.pluginVersion;
    writeFileSync(join(DOCKVIEW_OUT_DIR, "version.txt"), `dockview:${ver} ${VENCORD_REF} ${BUILD_IDENTITY}\n`);

    // 6. Prove Vencord stayed clean and DockView is complete.
    verifyOutput();
} finally {
    rmSync(work, { recursive: true, force: true });
}
