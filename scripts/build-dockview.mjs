/* Build the DockView renderer and main bundles without modifying Vencord. */

import { globalExternalsWithRegExp } from "@fal-works/esbuild-plugin-global-externals";
import { createRequire } from "module";
import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { chunkExternalPackages } from "./chunkList.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const vencordDir = process.argv[2];
const outDir = process.argv[3];

if (!vencordDir || !outDir) {
    throw new Error("usage: node scripts/build-dockview.mjs <vencordDir> <outDir>");
}

const requireFromVencord = createRequire(join(vencordDir, "package.json"));
const esbuild = requireFromVencord("esbuild");
const nodePaths = [join(vencordDir, "node_modules")];
mkdirSync(outDir, { recursive: true });

const names = {
    webpack: "Vencord.Webpack",
    "webpack/common": "Vencord.Webpack.Common",
    utils: "Vencord.Util",
    api: "Vencord.Api",
    "api/settings": "Vencord",
    components: "Vencord.Components"
};

const vencordGlobals = globalExternalsWithRegExp({
    getModuleInfo(modulePath) {
        const path = modulePath.replace("@vencord/types/", "");
        let varName = names[path];
        if (!varName) {
            const [root, ...rest] = path.split("/");
            const base = names[root];
            if (!base || rest.length === 0) throw new Error(`Unknown Vencord module path: ${modulePath}`);
            varName = `${base}.${rest.join(".")}`;
        }
        return { varName, type: "cjs" };
    },
    modulePathFilter: /^@vencord\/types.+$/
});

const managedCss = {
    name: "dockview-managed-css",
    setup(build) {
        build.onResolve({ filter: /\.css\?managed$/ }, args => ({
            path: join(args.resolveDir, args.path.slice(0, -"?managed".length)),
            namespace: "dockview-managed-css"
        }));
        build.onLoad({ filter: /.*/, namespace: "dockview-managed-css" }, args => ({
            contents: `export default ${JSON.stringify(readFileSync(args.path, "utf-8"))};`,
            loader: "js"
        }));
    }
};

const chunkPackages = chunkExternalPackages();
const chunkExternals = {
    name: "dockview-chunk-externals",
    setup(build) {
        build.onResolve({ filter: /^[^./]/ }, args => {
            if (chunkPackages.some(pkg => args.path === pkg || args.path.startsWith(`${pkg}/`))) {
                return { path: args.path, external: true };
            }
            return null;
        });
    }
};

await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [join(ROOT, "plugin", "standalone.ts")],
    bundle: true,
    format: "iife",
    globalName: "DockView",
    outfile: join(outDir, "dockviewRenderer.js"),
    minify: true,
    target: ["esnext"],
    platform: "browser",
    nodePaths,
    loader: { ".wasm": "binary" },
    plugins: [chunkExternals, managedCss, vencordGlobals],
    legalComments: "none",
    logLevel: "warning"
});

await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [join(ROOT, "plugin", "native.ts")],
    bundle: true,
    format: "cjs",
    outfile: join(outDir, "dockviewMain.js"),
    minify: true,
    target: ["node22"],
    platform: "node",
    nodePaths,
    banner: { js: "// DockView Runtime ABI: 1" },
    legalComments: "none",
    logLevel: "warning"
});

console.log(`DockView renderer/main built in ${outDir}`);
