/*
 * The 3D-model viewer — the Viewer contract over three.js (type "model3d").
 *
 * Covers obj / stl / ply / fbx / dae (Collada) / 3ds, plus gltf / glb (three's
 * best-supported format, cheap to add). The loader fetches the attachment bytes,
 * lazily loads three.js (off Vesktop startup), picks the loader by extension,
 * parses the bytes into a THREE.Object3D root, normalises it (wrap raw geometry in
 * a default-material Mesh, recolour materials with no map so unlit geometry is
 * visible), and hands the root to Model3DBody — which builds the Scene, frames the
 * camera to the bounding box, adds lighting, and runs the WebGLRenderer with
 * OrbitControls.
 *
 * three.js is HEAVY and code-dense (~23 ms of startup V8 compile, measured). It is
 * CHUNKED: three + every example loader is bundled into chunk-three.js
 * (engine/chunks/three.entry.ts) and EXTERNALIZED from the renderer, so its bytes
 * leave vencordDesktopRenderer.js entirely (not just its execution). The viewer
 * pulls the module + loaders from ONE withLibLoading("three") call, which loadLib
 * routes to the on-disk chunk (read over IPC + eval'd). NEVER add a static
 * `import … from "three"` (it re-inlines three and undoes the chunk) and NEVER a
 * bare `import("three/examples/…")` (a live dangling specifier once three is
 * external) — every loader comes off the chunk namespace.
 *
 * Resource ownership mirrors the PDF viewer: the parsed object is the big resource,
 * owned by the CACHE ENTRY (entry.model3dObject), not the body. The body only reads
 * content.model3d.object to render; dispose() (cache eviction) walks the object's
 * geometries/materials/textures and frees their GPU buffers. The dual-write +
 * destroy-on-supersede is verbatim from the PDF loader: the entry is always written
 * (and the object disposed if the entry was detached mid-load), the live content
 * only while token.isCurrent().
 */

import { getCacheEntry } from "../../engine/cache";
import { extOf } from "../../engine/detectType";
import { withLibLoading } from "../../engine/lazyLib";
import { STRINGS } from "../../strings";
import type {
    CacheEntry, LoadOpts, LoadToken, Model3DViewState, Viewer, ViewerContext
} from "../../engine/types";
import { Model3DBody, resetModel3DView } from "./Model3DBody";

/** Recursively dispose a three.js object's geometries, materials and any textures
 *  the materials hold, then drop it from its parent. Called on cache eviction so a
 *  long session doesn't leak GPU buffers. Best-effort — each step swallowed so a
 *  teardown never throws upward. */
export function disposeObject3D(root: any): void {
    if (!root) return;
    const seenMats = new Set<any>();
    const disposeMaterial = (m: any) => {
        if (!m || seenMats.has(m)) return;
        seenMats.add(m);
        // free any texture maps the material references (map, normalMap, …).
        for (const k of Object.keys(m)) {
            const v = (m as any)[k];
            if (v && typeof v === "object" && typeof v.dispose === "function" && v.isTexture) {
                try { v.dispose(); } catch { /* ignore */ }
            }
        }
        try { m.dispose(); } catch { /* ignore */ }
    };
    try {
        root.traverse?.((child: any) => {
            if (child.geometry && typeof child.geometry.dispose === "function") {
                try { child.geometry.dispose(); } catch { /* ignore */ }
            }
            const mat = child.material;
            if (Array.isArray(mat)) mat.forEach(disposeMaterial);
            else if (mat) disposeMaterial(mat);
        });
    } catch { /* a malformed object — nothing more to free */ }
    try { root.parent?.remove?.(root); } catch { /* already detached */ }
}

/** Parse the fetched bytes with the loader matching `ext`, returning a normalised
 *  THREE.Object3D root. STL/PLY return a bare BufferGeometry → wrap it in a Mesh with
 *  a sane default material; OBJ meshes with the placeholder material (no map) get a
 *  neutral lit material so they aren't flat white. `mod` is chunk-three.js's namespace
 *  (mod.default = three, mod.<Loader> = the example loaders), so every loader comes
 *  from the ONE chunk load — no separate dynamic import (those would be live dangling
 *  specifiers now that three is external to the renderer bundle). */
async function parseModel(mod: any, ext: string, buf: ArrayBuffer): Promise<any> {
    const THREE: any = mod.default;
    // A neutral, slightly glossy default material so unlit/material-less geometry
    // reads as a solid 3D surface under the scene lights (not a flat silhouette).
    const defaultMaterial = () => new THREE.MeshStandardMaterial({
        color: 0xb0b4bb, metalness: 0.1, roughness: 0.75, side: THREE.DoubleSide, flatShading: false
    });
    // Wrap a raw BufferGeometry (STL/PLY) in a default-material Mesh, ensuring it has
    // normals so lighting works (ascii STL / point-only PLY may ship without them).
    const meshFromGeometry = (geometry: any): any => {
        if (geometry && !geometry.attributes?.normal && typeof geometry.computeVertexNormals === "function") {
            try { geometry.computeVertexNormals(); } catch { /* leave unlit */ }
        }
        return new THREE.Mesh(geometry, defaultMaterial());
    };
    const dec = () => new TextDecoder("utf-8").decode(new Uint8Array(buf));

    switch (ext) {
        case "obj": {
            const { OBJLoader } = mod;
            const obj = new OBJLoader().parse(dec());
            // OBJ with no .mtl gets a placeholder MeshPhongMaterial (white, name
            // ""). Swap any unmapped/placeholder material for our neutral lit one so
            // the model isn't a flat white blob (the single-attachment case: the
            // .mtl sibling almost never travels with the .obj).
            obj.traverse((c: any) => {
                if (!c.isMesh) return;
                const m = c.material;
                const isPlaceholder = (mm: any) => mm && !mm.map && (mm.name === "" || mm.name == null);
                if (Array.isArray(m)) c.material = m.map((mm: any) => (isPlaceholder(mm) ? defaultMaterial() : mm));
                else if (isPlaceholder(m)) c.material = defaultMaterial();
            });
            return obj;
        }
        case "stl": {
            const { STLLoader } = mod;
            return meshFromGeometry(new STLLoader().parse(buf));
        }
        case "ply": {
            const { PLYLoader } = mod;
            const geometry = new PLYLoader().parse(buf);
            return meshFromGeometry(geometry);
        }
        case "fbx": {
            const { FBXLoader } = mod;
            return new FBXLoader().parse(buf, "");
        }
        case "dae": {
            const { ColladaLoader } = mod;
            const result = new ColladaLoader().parse(dec(), "");
            return result.scene;
        }
        case "3ds": {
            const { TDSLoader } = mod;
            return new TDSLoader().parse(buf, "");
        }
        case "gltf":
        case "glb": {
            const { GLTFLoader } = mod;
            const loader = new GLTFLoader();
            const gltf: any = await new Promise((resolve, reject) =>
                loader.parse(buf, "", resolve, reject));
            return gltf.scene;
        }
        default:
            throw new Error(`Unsupported 3D format: .${ext}`);
    }
}

/** 3D loader: fetch bytes → lazy-load three + the per-ext loader → parse into an
 *  Object3D root → dual-write (entry always, content while current). */
function load(opts: LoadOpts, token: LoadToken, entry: CacheEntry | null, ctx: ViewerContext): void {
    // Reset the live model BEFORE the fetch (mirrors the PDF reset): null the
    // previous object and BUMP renderToken so the body (keyed on renderToken) drops
    // the stale scene immediately instead of rendering A's model until B resolves.
    ctx.content.model3d = { object: null, renderToken: ctx.content.model3d.renderToken + 1 };
    resetModel3DView(ctx.window);
    if (!opts.url) {
        ctx.content.loading = false;
        ctx.content.error = STRINGS.error.noSource.title;
        return;
    }
    ctx.content.loading = true;
    const reqUrl = opts.url;
    const ext = (extOf(opts.url) || extOf(opts.name) || "").toLowerCase();

    ctx.fetch(reqUrl, opts.noCache)
        .then(r => {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.arrayBuffer();
        })
        .then(async buf => {
            // Load three through the lazy-lib loader so the dock shows "Loading 3D
            // viewer…" while the (code-dense) lib spins up the first time this
            // session; subsequent opens reuse the cached module instantly.
            // The "three" key is CHUNKED: loadLib returns chunk-three.js's namespace,
            // whose `default` is the three module and whose named exports are the
            // example loaders (engine/chunks/three.entry.ts). The viewer pulls both
            // from this one load — no separate `import("three/examples/…")` (those
            // would be live dangling specifiers once three is external to the bundle).
            const threeMod: any = await withLibLoading(ctx, STRINGS.loading.lib.threed, "three",
                () => import("three").then(m => ({ default: m })));
            const object = await parseModel(threeMod, ext, buf);
            if (!object) throw new Error("The model contained no geometry.");

            // Only keep the object if `entry` is STILL the cache's live entry for its
            // key (a rapid re-click could have disposed + replaced it). Otherwise the
            // entry is detached and storing the object there would leak it — dispose.
            const live = entry != null && getCacheEntry(entry.key) === entry;
            if (live) { entry!.model3dObject = object; entry!.loading = false; entry!.error = null; }
            else { disposeObject3D(object); }

            if (!token.isCurrent()) return; // superseded — don't touch content
            ctx.content.model3d.object = object;
            ctx.content.model3d.renderToken += 1; // a fresh object is ready to render
            ctx.content.loading = false;
            ctx.content.loadingLabel = null;
            ctx.content.error = null;
            ctx.requestRender();
        })
        .catch(e => {
            if (entry) { entry.loading = false; entry.error = String(e?.message || e); }
            if (!token.isCurrent()) return;
            ctx.content.loading = false;
            ctx.content.error = String(e?.message || e);
            ctx.requestRender();
        });
}

function createState(): Model3DViewState {
    return { camPos: null, target: null };
}

function resetState(vs: Model3DViewState): void {
    if (!vs) return;
    vs.camPos = null;
    vs.target = null;
}

/** Park the camera pose on the entry so a cache return reopens the model at the same
 *  angle/zoom. The Body keeps vs.camPos/target up to date as the user orbits. */
function snapshot(vs: Model3DViewState, entry: CacheEntry): void {
    entry.view.modelCamPos = vs?.camPos ?? null;
    entry.view.modelTarget = vs?.target ?? null;
}

/** Restore the camera pose on a cache return (Body re-applies it once the renderer
 *  exists; absent → the Body auto-frames the model). */
function restore(vs: Model3DViewState, entry: CacheEntry): void {
    if (!vs) return;
    vs.camPos = entry.view.modelCamPos ?? null;
    vs.target = entry.view.modelTarget ?? null;
}

/** Release the parsed object's GPU buffers when the cache entry is evicted. */
function dispose(entry: CacheEntry): void {
    disposeObject3D(entry.model3dObject);
    entry.model3dObject = null;
}

export const Model3DViewer: Viewer<Model3DViewState> = {
    type: "model3d",
    load,
    createState,
    resetState,
    snapshot,
    restore,
    Body: Model3DBody,
    dispose
};
