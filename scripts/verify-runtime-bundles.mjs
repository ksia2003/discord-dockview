import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { computeVencordBuildIdentity } from "./lib/vencordBuildIdentity.mjs";
import { readDockViewReleaseMetadata } from "./lib/readDockViewReleaseMetadata.mjs";
import { assertRuntimeBundles } from "./lib/runtimeBundles.mjs";
import { VENCORD_REF } from "./lib/vencordRef.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = readDockViewReleaseMetadata(root);

assertRuntimeBundles(root, {
    pluginVersion: metadata.pluginVersion,
    vencordRef: VENCORD_REF,
    buildIdentity: computeVencordBuildIdentity(root)
});
console.log("Verified disjoint official Vencord and DockView runtime bundles");
