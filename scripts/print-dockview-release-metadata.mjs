#!/usr/bin/env node

import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { readDockViewReleaseMetadata } from "./lib/readDockViewReleaseMetadata.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.length > 2 || (args.length === 1 && args[0] !== "--field") || (args.length === 2 && args[0] !== "--field")) {
    console.error(
        "Usage: node scripts/print-dockview-release-metadata.mjs [--field tag|appVersion|pluginVersion|shellVersion|vesktopCommit|repository]"
    );
    process.exit(1);
}

try {
    const metadata = readDockViewReleaseMetadata(ROOT);
    if (!args.length) {
        console.log(JSON.stringify(metadata, null, 2));
    } else {
        const field = args[1];
        if (!["tag", "appVersion", "pluginVersion", "shellVersion", "vesktopCommit", "repository"].includes(field)) {
            throw new Error(
                `Unknown field ${JSON.stringify(field)}; expected tag, appVersion, pluginVersion, shellVersion, vesktopCommit, or repository`
            );
        }
        console.log(field === "repository" ? metadata.repository.slug : metadata[field]);
    }
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
