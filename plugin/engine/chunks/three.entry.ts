/*
 * Chunk entry for THREE — see engine/chunkRegistry.ts (exportMode "entry").
 * ---------------------------------------------------------------------------
 * three is code-dense (~23 ms of startup V8 compile, measured) and is taken OUT
 * of vencordDesktopRenderer.js as a standalone chunk-three.js. Unlike a single-
 * package chunk (mermaid/pptx), the 3D viewer needs three PLUS several
 * three/examples/jsm loaders — each its own ESM module that internally imports
 * "three". Bundling them ALL here means esbuild dedupes "three" to ONE instance
 * the loaders share (a loader built against a different three copy would throw),
 * and the chunk exposes everything the viewer pulls in as named exports.
 *
 * scripts/build-chunks.mjs bundles THIS file (not a bare package) into chunk-three.js,
 * whose namespace object engine/lazyLib.ts hands back. The viewer reads:
 *   const THREE = (await loadLib("three", …))   // the default export (the namespace)
 *   const { OBJLoader, OrbitControls, … } = THREE  // the named loader exports
 * i.e. the chunk's `default` IS the three namespace and the loaders sit alongside.
 */

// The three namespace, re-exported as the chunk's default so the viewer's existing
// `const THREE = …` keeps working unchanged.
import * as THREE from "three";

import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { TDSLoader } from "three/examples/jsm/loaders/TDSLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export default THREE;
export {
    ColladaLoader,
    FBXLoader,
    GLTFLoader,
    OBJLoader,
    OrbitControls,
    PLYLoader,
    STLLoader,
    TDSLoader
};
