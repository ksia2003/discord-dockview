/*
 * The 3D-model body — a three.js WebGLRenderer canvas filling the dock body, with
 * OrbitControls (rotate / zoom / pan), scene lighting and an auto-framed camera.
 *
 * The parsed model (a THREE.Object3D root) is produced by Model3DViewer.load and
 * lives on the cache entry; this body only READS content.model3d.object and renders
 * it. The effect (keyed on renderToken + seq, like PdfBody) builds the scene once
 * three has resolved, frames the camera to the model's bounding box, and runs an rAF
 * loop while OrbitControls damping settles.
 *
 * TEARDOWN (load-bearing): a WebGLRenderer holds a real GPU context, and browsers
 * cap live WebGL contexts (~16) — leaking one per dock open breaks rendering after a
 * dozen files. So the cleanup STOPS the rAF loop (cancelAnimationFrame), disposes
 * OrbitControls + the renderer, force-loses the WebGL context, and drops the canvas.
 * The model object itself is NOT disposed here (it's owned by the cache entry;
 * Model3DViewer.dispose frees it on eviction) — we only remove it from our scene.
 *
 * three is loaded lazily (the lib load happens in the loader, behind the "Loading 3D
 * viewer…" dock state; by the time this body mounts content.loading is false and the
 * module is cached). We STILL import it dynamically here — never a static
 * `import … from "three"` — so this module adds nothing to startup.
 */

import { React } from "@webpack/common";

import { getActiveWindow } from "../../engine/window";
import type { DockWindow, Model3DViewState } from "../../engine/types";

export const MODEL3D_VIEWSTATE = "model3d";

/** The window's 3D view-state slice (camera pose), created on demand. Mirrors
 *  pdfState's init-order back-fill: the very first window is built before this viewer
 *  registers, so it can lack the slice. */
export function model3dState(win: DockWindow = getActiveWindow()): Model3DViewState {
    let vs = win.viewStates[MODEL3D_VIEWSTATE] as Model3DViewState | undefined;
    if (!vs) {
        vs = { camPos: null, target: null };
        win.viewStates[MODEL3D_VIEWSTATE] = vs;
    }
    return vs;
}

/** Reset the 3D view to its fresh-open default (no saved camera → auto-frame). */
export function resetModel3DView(win: DockWindow = getActiveWindow()): void {
    const vs = model3dState(win);
    vs.camPos = null;
    vs.target = null;
}

/** Read a CSS custom property off an element, falling back when it (or the var)
 *  is empty — Discord themes always define --background-*, but a stray theme might
 *  not, so we keep a dark neutral fallback that fits the panel. */
function cssVar(el: Element, name: string, fallback: string): string {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
}

/** The 3D body. Keyed on content.seq by the dispatcher; the effect builds the scene
 *  once three resolves and the object is ready, runs OrbitControls + an rAF loop, and
 *  tears the whole GPU pipeline down on unmount. */
export function Model3DBody() {
    const { useRef, useEffect } = React;
    const containerRef = useRef(null as HTMLDivElement | null);

    const win = getActiveWindow();
    const seq = win.content.seq;
    const renderToken = win.content.model3d.renderToken;

    useEffect(() => {
        const host = containerRef.current;
        if (!host) return;
        const object = win.content.model3d.object;
        if (!object) return; // nothing parsed (error/empty) — the state card shows instead
        const vs = model3dState(win);

        // Everything below is torn down by the cleanup; declared here so the cleanup
        // closure can reach them even if the async three import resolves late.
        let disposed = false;
        let rafId = 0;
        let renderer: any = null;
        let controls: any = null;
        let resizeObs: ResizeObserver | null = null;
        let onControlsChange: (() => void) | null = null;

        // The clear colour derives from the panel's chat background so the canvas
        // blends with the dock and follows the active Discord theme (no hardcoded
        // colour fighting a light theme). Read once at build; resize doesn't change it.
        const bgColor = cssVar(host, "--background-base-lower", "#1a1a1e");

        (async () => {
            const THREE: any = await import("three");
            const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
            if (disposed || !host.isConnected) return;

            const width = Math.max(1, host.clientWidth);
            const height = Math.max(1, host.clientHeight);

            const scene = new THREE.Scene();
            try { scene.background = new THREE.Color(bgColor); } catch { /* keep default */ }

            // --- frame the model: centre it at the origin + size the camera to fit ---
            // Bounding box → centre + radius; the model is re-centred to the origin so
            // OrbitControls orbits its middle, and the camera is pulled back far enough
            // that the whole bounding sphere fits the vertical FOV with a small margin.
            const box = new THREE.Box3().setFromObject(object);
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
            object.position.sub(center); // recentre to origin
            scene.add(object);

            // bounding-sphere radius (half the box diagonal) — the camera fit + light
            // distances + control min/max distance all scale off this.
            const boundingRadius = Math.max(size.length() * 0.5, 1e-3);

            const fov = 50;
            const camera = new THREE.PerspectiveCamera(fov, width / height, boundingRadius / 100, boundingRadius * 100);
            // distance so the bounding sphere fits the (smaller of h/v) FOV, ×1.4 margin.
            const vFov = (fov * Math.PI) / 180;
            const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (width / height));
            const fitDist = boundingRadius / Math.sin(Math.min(vFov, hFov) / 2);
            const dist = fitDist * 1.4;
            // a pleasant default 3/4 view (front-right-above) for a fresh open.
            camera.position.set(dist * 0.6, dist * 0.5, dist * 0.8);
            camera.lookAt(0, 0, 0);

            renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            renderer.setSize(width, height, false);
            try { renderer.outputColorSpace = THREE.SRGBColorSpace; } catch { /* older three */ }
            const canvas: HTMLCanvasElement = renderer.domElement;
            canvas.className = "dockview-model3d-canvas";
            host.appendChild(canvas);

            // --- lighting so unlit / material-less geometry is visible -------------
            // Hemisphere (sky/ground ambient gradient) + a key directional from the
            // camera-ish direction + a soft ambient floor. Tuned to read a neutral grey
            // model as a solid lit surface in the dark dock.
            scene.add(new THREE.AmbientLight(0xffffff, 0.55));
            const hemi = new THREE.HemisphereLight(0xffffff, 0x444455, 0.7);
            hemi.position.set(0, 1, 0);
            scene.add(hemi);
            const key = new THREE.DirectionalLight(0xffffff, 1.1);
            key.position.set(1, 1.2, 1).multiplyScalar(boundingRadius * 4);
            scene.add(key);
            const fill = new THREE.DirectionalLight(0xffffff, 0.4);
            fill.position.set(-1, 0.3, -0.8).multiplyScalar(boundingRadius * 4);
            scene.add(fill);

            // --- OrbitControls: rotate / zoom / pan, with inertial damping ---------
            controls = new OrbitControls(camera, canvas);
            controls.enableDamping = true;
            controls.dampingFactor = 0.08;
            controls.target.set(0, 0, 0);
            controls.minDistance = boundingRadius * 0.2;
            controls.maxDistance = boundingRadius * 50;

            // Restore a saved camera pose (cache return) over the auto-frame default.
            if (vs.camPos && vs.target) {
                camera.position.set(vs.camPos[0], vs.camPos[1], vs.camPos[2]);
                controls.target.set(vs.target[0], vs.target[1], vs.target[2]);
            }
            controls.update();

            // Persist the camera pose on every change so a cache return reopens the
            // model exactly where the user left it. Cheap (3+3 numbers on a struct).
            onControlsChange = () => {
                vs.camPos = [camera.position.x, camera.position.y, camera.position.z];
                vs.target = [controls.target.x, controls.target.y, controls.target.z];
            };
            controls.addEventListener("change", onControlsChange);
            onControlsChange(); // seed from the framed/restored pose

            // --- render loop -------------------------------------------------------
            // A continuous rAF loop: OrbitControls damping needs per-frame update()s
            // to settle after a drag, and a fresh-open auto-frame should paint
            // immediately. The loop is stopped (cancelAnimationFrame) on teardown.
            const renderFrame = () => {
                if (disposed) return;
                controls.update(); // applies damping; returns true while still moving
                renderer.render(scene, camera);
                rafId = requestAnimationFrame(renderFrame);
            };
            rafId = requestAnimationFrame(renderFrame);

            // --- resize: the dock is resizable; keep the canvas + aspect in sync ---
            resizeObs = new ResizeObserver(() => {
                if (disposed || !renderer) return;
                const w = Math.max(1, host.clientWidth);
                const h = Math.max(1, host.clientHeight);
                camera.aspect = w / h;
                camera.updateProjectionMatrix();
                renderer.setSize(w, h, false);
            });
            resizeObs.observe(host);
        })().catch(() => { /* a three import failure is already an errored content */ });

        return () => {
            disposed = true;
            if (rafId) cancelAnimationFrame(rafId);
            rafId = 0;
            resizeObs?.disconnect();
            resizeObs = null;
            if (controls) {
                if (onControlsChange) controls.removeEventListener("change", onControlsChange);
                try { controls.dispose(); } catch { /* ignore */ }
                controls = null;
            }
            // Remove our model from the scene (do NOT dispose it — the cache entry
            // owns it; Model3DViewer.dispose frees it on eviction).
            try { object.parent?.remove?.(object); } catch { /* ignore */ }
            if (renderer) {
                try { renderer.dispose(); } catch { /* ignore */ }
                // Force-lose the WebGL context so the GPU resource is freed NOW, not
                // whenever GC happens to collect the canvas — browsers cap live
                // contexts and a side panel opens many models per session.
                try {
                    const gl = renderer.getContext?.();
                    const lose = gl?.getExtension?.("WEBGL_lose_context");
                    lose?.loseContext?.();
                } catch { /* ignore */ }
                const dom = renderer.domElement as HTMLCanvasElement | undefined;
                try { dom?.parentNode?.removeChild(dom); } catch { /* ignore */ }
                renderer = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [renderToken, seq]);

    return React.createElement("div", {
        key: seq,
        ref: containerRef,
        className: "dockview-model3d-container",
        // Focusable so a click into the body gives the panel keyboard focus, matching
        // the other interactive viewers (pdf).
        tabIndex: 0
    });
}
