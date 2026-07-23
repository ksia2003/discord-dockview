/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { VENCORD_CORE_FILES } from "shared/dockviewBundleFiles";

import { fetchie } from "./http";

const API_BASE = "https://api.github.com/repos/Vendicated/Vencord";
const USER_AGENT = "Vesktop-DockView/Vencord-Updater";
const HASH_BANNER = /^\/\/ Vencord ([0-9a-f]{7,40})\b/im;
const RELEASE_HASH = /\b([0-9a-f]{7,40})\s*$/i;
const STANDALONE_BANNER = /^\/\/ Standalone: true$/im;
const REVISIONED_FILES = VENCORD_CORE_FILES.filter(name => name.endsWith(".js"));

type FetchResponse = Pick<Response, "json">;
export type VencordUpdateFetch = (url: string, options?: RequestInit) => Promise<FetchResponse>;

export interface VencordChange {
    hash: string;
    author: string;
    message: string;
}

export async function isStandaloneVencordInstall(dir: string): Promise<boolean> {
    const source = await readFile(join(dir, "vencordDesktopMain.js"), "utf8");
    return STANDALONE_BANNER.test(source.slice(0, 512));
}

export async function readInstalledVencordHash(dir: string): Promise<string> {
    const hashes = await Promise.all(
        REVISIONED_FILES.map(async name => {
            const source = await readFile(join(dir, name), "utf8");
            const hash = HASH_BANNER.exec(source)?.[1];
            if (!hash) throw new Error(`The installed Vencord file has no valid source revision: ${name}`);
            return hash.toLowerCase();
        })
    );

    if (new Set(hashes).size !== 1) throw new Error("The installed Vencord core files have inconsistent revisions");
    return hashes[0];
}

/**
 * Vencord's standalone GET_UPDATES handler also fills its process-local
 * download queue. The renderer calls GET_UPDATES before UPDATE, so repeated
 * checks can enqueue the same assets more than once. This read-only check
 * preserves Vencord's response shape while leaving UPDATE and BUILD entirely
 * owned by the unmodified official runtime.
 */
export async function getVencordUpdates(
    installDir: string,
    fetchResponse: VencordUpdateFetch = (url, options) => fetchie(url, options, { retryOnNetworkError: true })
): Promise<VencordChange[]> {
    const options: RequestInit = {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": USER_AGENT
        }
    };
    const [installedHash, release] = await Promise.all([
        readInstalledVencordHash(installDir),
        fetchResponse(`${API_BASE}/releases/latest`, options).then(response => response.json()) as Promise<{
            name?: unknown;
        }>
    ]);

    const releaseHash =
        typeof release.name === "string" ? RELEASE_HASH.exec(release.name)?.[1]?.toLowerCase() : undefined;
    if (!releaseHash) throw new Error("The latest Vencord release does not identify its source revision");
    if (installedHash === releaseHash) return [];

    const comparison = (await fetchResponse(`${API_BASE}/compare/${installedHash}...${releaseHash}`, options).then(
        response => response.json()
    )) as {
        commits?: Array<{
            sha?: string;
            author?: { login?: string };
            commit?: { author?: { name?: string }; message?: string };
        }>;
    };
    if (!Array.isArray(comparison.commits)) throw new Error("Vencord returned no comparable update history");

    return comparison.commits.map(commit => ({
        hash: commit.sha?.slice(0, 7) || "unknown",
        author: commit.author?.login ?? commit.commit?.author?.name ?? "Unknown Author",
        message: commit.commit?.message?.split("\n")[0] || "Vencord update"
    }));
}
