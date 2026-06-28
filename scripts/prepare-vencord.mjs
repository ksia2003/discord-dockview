/*
 * DockView build helper
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Reproducibly builds Vencord with the DockView userplugin bundled in, then
 * copies the four desktop dist files into static/vencordDist/ so they ship
 * inside the DockView app package (see src/main/utils/vencordLoader.ts).
 *
 * The DockView userplugin source lives in this repo under plugin/ and is copied
 * straight into Vencord's src/userplugins/ — no separate clone.
 *
 * Usage:
 *   node scripts/prepare-vencord.mjs
 *
 * Env overrides:
 *   VENCORD_REF        git ref/tag of Vencord to build      (default: v1.14.13)
 *   SKIP_VENCORD_BUILD if set, skip cloning/building and just verify output
 */

import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { builtinModules } from "module";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { chunkExternalPackages, chunkFileNames } from "./chunkList.mjs";

// Node builtins (with and without the "node:" prefix). The plugin runs in the
// renderer and shouldn't import these, but guard against future drift.
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const VENCORD_REPO = "https://github.com/Vendicated/Vencord";
const VENCORD_REF = process.env.VENCORD_REF || "v1.14.13";

const PNPM = "pnpm";

// DockView userplugin source, shipped in this repo.
const PLUGIN_SRC = join(ROOT, "plugin");

// plugin/version.ts is the SINGLE home of the running plugin version. This is a
// .mjs and can't import a .ts, so read the literal as text and regex it out.
// Keeps the build the SOLE writer of version.txt with version.ts the one source.
function readPluginVersion() {
    const src = readFileSync(join(PLUGIN_SRC, "version.ts"), "utf-8");
    const m = src.match(/DOCKVIEW_PLUGIN_VERSION\s*=\s*["']([^"']+)["']/);
    if (!m) throw new Error("Could not extract DOCKVIEW_PLUGIN_VERSION from plugin/version.ts");
    return m[1];
}

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
        const src = readFileSync(file, "utf-8");
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

// The core desktop bundle files plus the out-of-bundle CHUNK files (chunk-<lib>.js)
// the chunk build emits. The chunked code-dense libs (mermaid, pptx, three, pdfjs,
// codemirror) are externalized from the renderer and shipped as these separate
// files so they no longer cost V8 compile at every Vesktop startup.
const CHUNK_OUTPUT_FILES = chunkFileNames();
const FILES = [
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css",
    ...CHUNK_OUTPUT_FILES
];

// Packages the renderer build must treat as external (their bytes go into a chunk
// file instead of inline) — passed to Vencord's esbuild via DOCKVIEW_CHUNK_EXTERNALS,
// read by the dockview-chunk-external plugin the build patch injects.
const CHUNK_EXTERNALS = chunkExternalPackages();

const OUT_DIR = join(ROOT, "static", "vencordDist");

// Print the derived deps so a build log is auditable — if the plugin grows a
// new import, it shows up here without anyone touching this script.
console.log(`Derived DockView deps (${DOCKVIEW_DEPS.length}) from plugin/ imports:`);
for (const dep of DOCKVIEW_DEPS) console.log(`  - ${dep}`);
if (DOCKVIEW_DEPS.length === 0) {
    throw new Error("No external deps derived from plugin/ — scanner is broken or plugin/ is empty.");
}

function run(cmd, args, cwd, extraEnv) {
    console.log(`$ ${cmd} ${args.join(" ")}  (cwd: ${cwd})`);
    // shell: true so Windows can run pnpm, which is a `.cmd` shim: execFileSync
    // can't spawn `pnpm` (ENOENT) nor `pnpm.cmd` directly (EINVAL, since the Node
    // CVE-2024-27980 fix). The shell resolves it on both platforms. Harmless on
    // POSIX; the temp/clone paths used here have no spaces.
    execFileSync(cmd, args, { cwd, stdio: "inherit", shell: true, env: { ...process.env, ...extraEnv } });
}

function verifyOutput() {
    for (const f of FILES) {
        const p = join(OUT_DIR, f);
        if (!existsSync(p)) throw new Error(`Missing expected output file: ${p}`);
    }
    const renderer = readFileSync(join(OUT_DIR, "vencordDesktopRenderer.js"), "utf-8");
    const count = (renderer.match(/DockView/g) || []).length;
    if (count < 1) {
        throw new Error("DockView string not found in vencordDesktopRenderer.js — plugin was not bundled.");
    }
    console.log(`✔ static/vencordDist ready. DockView references in renderer: ${count}`);
}

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

    // 2. Inject the DockView userplugin from this repo's plugin/ folder.
    if (!existsSync(PLUGIN_SRC)) throw new Error(`Plugin source not found: ${PLUGIN_SRC}`);
    const pluginDest = join(vencordDir, "src", "userplugins", "dockView");
    mkdirSync(dirname(pluginDest), { recursive: true });
    cpSync(PLUGIN_SRC, pluginDest, { recursive: true });

    // 3. Add DockView runtime deps to Vencord. `-w`: Vencord is a pnpm workspace
    //    and `pnpm add` to a workspace root refuses (ERR_PNPM_ADDING_TO_ROOT)
    //    without it.
    run(PNPM, ["add", "-w", ...DOCKVIEW_DEPS], vencordDir);

    // 3b. Patch Vencord's renderer build to EXTERNALIZE the chunked libs (their
    //     bytes go into chunk-<lib>.js instead of inline) — mirrors the dev path.
    run("node", [join(__dirname, "patch-vencord-build.mjs"), vencordDir], ROOT);

    // 4. Install + build Vencord. The chunk externals are passed via env so the
    //    injected plugin marks them external in the renderer (IIFE) bundle.
    run(PNPM, ["install"], vencordDir);
    run(PNPM, ["build"], vencordDir, { DOCKVIEW_CHUNK_EXTERNALS: CHUNK_EXTERNALS.join(",") });

    // 4b. Emit the standalone chunk-<lib>.js files (a separate esbuild pass that
    //     bundles each externalized lib). Writes into <vencordDir>/dist alongside
    //     the renderer; the registry is read from the injected plugin copy.
    run("node", [join(__dirname, "build-chunks.mjs"), vencordDir], ROOT, {
        DOCKVIEW_CHUNK_REGISTRY: join(vencordDir, "src", "userplugins", "dockView", "engine", "chunkRegistry.ts"),
        DOCKVIEW_PLUGIN_DIR: join(vencordDir, "src", "userplugins", "dockView")
    });

    // 5. Copy the desktop dist files + the chunk files into static/vencordDist.
    mkdirSync(OUT_DIR, { recursive: true });
    for (const f of FILES) {
        cpSync(join(vencordDir, "dist", f), join(OUT_DIR, f));
    }
    let pluginRev = "local";
    try {
        pluginRev = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT })
            .toString()
            .trim();
    } catch {
        /* not a git checkout (e.g. source tarball) — fall back to "local" */
    }
    const ver = readPluginVersion();
    writeFileSync(join(OUT_DIR, "version.txt"), `dockview:${ver} ${VENCORD_REF} ${pluginRev}\n`);

    // 6. Verify DockView made it in.
    verifyOutput();
} finally {
    rmSync(work, { recursive: true, force: true });
}
