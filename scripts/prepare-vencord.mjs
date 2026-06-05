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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const VENCORD_REPO = "https://github.com/Vendicated/Vencord";
const VENCORD_REF = process.env.VENCORD_REF || "v1.14.13";

// DockView userplugin source, shipped in this repo.
const PLUGIN_SRC = join(ROOT, "plugin");

// Extra deps DockView needs that aren't in stock Vencord.
const DOCKVIEW_DEPS = ["pdfjs-dist", "marked", "highlight.js"];

const FILES = [
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css"
];

const OUT_DIR = join(ROOT, "static", "vencordDist");

function run(cmd, args, cwd) {
    console.log(`$ ${cmd} ${args.join(" ")}  (cwd: ${cwd})`);
    execFileSync(cmd, args, { cwd, stdio: "inherit" });
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

    // 3. Add DockView runtime deps to Vencord.
    run("pnpm", ["add", ...DOCKVIEW_DEPS], vencordDir);

    // 4. Install + build Vencord.
    run("pnpm", ["install"], vencordDir);
    run("pnpm", ["build"], vencordDir);

    // 5. Copy the four desktop dist files into static/vencordDist.
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
    writeFileSync(join(OUT_DIR, "version.txt"), `${VENCORD_REF}+dockview-${pluginRev}\n`);

    // 6. Verify DockView made it in.
    verifyOutput();
} finally {
    rmSync(work, { recursive: true, force: true });
}
