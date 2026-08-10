import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import detectTypeModule from "../plugin/engine/detectType.ts";
import dockEligibilityModule from "../plugin/engine/dockEligibility.ts";
import iframeLinkBridgeModule from "../plugin/engine/iframeLinkBridge.ts";
import mediaErrorModule from "../plugin/viewers/media/mediaError.ts";
import mediaProbeModule from "../plugin/viewers/media/mediaProbe.ts";

const { detectType } = detectTypeModule;
const {
    canInterceptDockAttachment, decoderKeyForFile, hasFileActionSurface,
    inlineImageTypeFor, isCurrentAttachmentSurface, isDiscordAttachmentUrl,
    isDockFileEligible, portalThreadIdFromSurface
} = dockEligibilityModule;
const {
    canOpenIframeDock, iframeForSource, iframeLinkBase, isAllowedIframeRawLink,
    resolveIframeLink
} = iframeLinkBridgeModule;
const {
    MEDIA_DECODE_ERROR, holdPendingMediaOpen, isPendingMediaOpen,
    markMediaDecodeError, markMediaLoaded
} = mediaErrorModule;
const {
    cancelAllMediaProbes, cancelMediaProbe, hasMediaProbe, startMediaProbe
} = mediaProbeModule;

class FakeMediaProbeElement {
    constructor() {
        this.src = "";
        this.preload = "";
        this.muted = false;
        this.listeners = new Map();
        this.loadCount = 0;
        this.pauseCount = 0;
        this.srcRemovalCount = 0;
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
    }

    pause() { this.pauseCount += 1; }
    removeAttribute(name) {
        if (name === "src") {
            this.src = "";
            this.srcRemovalCount += 1;
        }
    }
    load() { this.loadCount += 1; }
    listener(type) { return [...(this.listeners.get(type) ?? [])][0] ?? null; }
    emit(type) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(); }
}

function provisionalMediaWindow(id, kind = "video", url = `${attachmentUrl}&window=${id}`) {
    return {
        id,
        activeCacheKey: `${kind}:https://cdn.discordapp.com/attachments/100/200/${id}`,
        content: { type: kind, url, seq: 1, loading: true, error: null },
        openRollback: {}
    };
}

function source(path) {
    return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const attachmentUrl = "https://cdn.discordapp.com/attachments/100/200/readme.pdf?ex=1&is=2&hm=3";
const attachmentSurface = {
    attachmentMarker: true,
    attachmentUrl,
    messageChannelId: "100",
    activeSurfaceChannelIds: ["100"],
    portalThreadId: null,
    searchSurface: false,
    homeSurface: false,
    explicitDownload: false
};
const enabledPdf = { type: "pdf", categoryEnabled: true, decoderEnabled: true };

test("Dock ownership requires a real current attachment surface", () => {
    assert.equal(isDiscordAttachmentUrl(attachmentUrl), true);
    assert.equal(isDiscordAttachmentUrl("https://media.discordapp.net/attachments/100/200/readme.pdf"), true);
    assert.equal(isDiscordAttachmentUrl("https://evil.example/attachments/100/200/readme.pdf"), false);
    assert.equal(isDiscordAttachmentUrl("https://sub.cdn.discordapp.com/attachments/100/200/readme.pdf"), false);
    assert.equal(isDiscordAttachmentUrl("http://cdn.discordapp.com/attachments/100/200/readme.pdf"), false);
    assert.equal(isCurrentAttachmentSurface(attachmentSurface), true);
    assert.equal(canInterceptDockAttachment({ surface: attachmentSurface, gate: enabledPdf }), true);

    // A normal message anchor with a supported extension remains Discord/Vesktop-owned.
    assert.equal(isCurrentAttachmentSurface({
        ...attachmentSurface,
        attachmentMarker: false,
        attachmentUrl: "https://example.com/a.pdf"
    }), false);

    // Search/home surfaces and explicit download controls never become Dock opens,
    // even when their message channel happens to equal the selected channel.
    assert.equal(isCurrentAttachmentSurface({ ...attachmentSurface, searchSurface: true }), false);
    assert.equal(isCurrentAttachmentSurface({ ...attachmentSurface, homeSurface: true }), false);
    assert.equal(isCurrentAttachmentSurface({ ...attachmentSurface, explicitDownload: true }), false);
});

test("relocated Search attachments require the active current-guild Dock surface", () => {
    const relocated = {
        ...attachmentSurface,
        messageChannelId: "200",
        activeSurfaceChannelIds: ["100"],
        searchResultSurface: true,
        searchResultScopeId: "guild:alpha",
        activeSearchScopeId: "guild:alpha",
        searchResultActive: true,
        messageGuildId: "alpha",
        activeGuildId: "alpha",
        searchSurface: false
    };
    assert.equal(isCurrentAttachmentSurface(relocated), true);

    // Hidden/other-guild resident surfaces, native Discord Search, and non-search home
    // surfaces remain upstream even when their message row has a supported CDN file.
    assert.equal(isCurrentAttachmentSurface({ ...relocated, searchResultActive: false }), false);
    assert.equal(isCurrentAttachmentSurface({ ...relocated, searchResultScopeId: "guild:beta" }), false);
    assert.equal(isCurrentAttachmentSurface({ ...relocated, messageGuildId: "beta" }), false);
    assert.equal(isCurrentAttachmentSurface({ ...relocated, searchResultSurface: false, searchSurface: true }), false);
    assert.equal(isCurrentAttachmentSurface({ ...relocated, searchResultSurface: false, homeSurface: true }), false);
    assert.equal(isCurrentAttachmentSurface({ ...relocated, explicitDownload: true }), false);
});

test("visible thread portal binds only its native message channel", () => {
    const threadMessage = {
        ...attachmentSurface,
        messageChannelId: "300",
        activeSurfaceChannelIds: ["100"],
        portalThreadId: portalThreadIdFromSurface(true, "300")
    };
    assert.equal(threadMessage.portalThreadId, "300");
    assert.equal(isCurrentAttachmentSurface(threadMessage), true);

    // A child/thread message outside the visible portal is not implicitly accepted.
    assert.equal(portalThreadIdFromSurface(false, "300"), null);
    assert.equal(isCurrentAttachmentSurface({
        ...threadMessage,
        portalThreadId: portalThreadIdFromSurface(false, "300")
    }), false);
    assert.equal(isCurrentAttachmentSurface({ ...threadMessage, portalThreadId: "301" }), false);
});

test("disabled category and heavy decoder gates pass through before routing", () => {
    assert.equal(decoderKeyForFile("model3d", "model.glb"), "three");
    assert.equal(decoderKeyForFile("postscript", "drawing.eps"), "ghostscript");
    assert.equal(decoderKeyForFile("rasterimage", "photo.psd"), "ag-psd");
    assert.equal(decoderKeyForFile("rasterimage", "photo.jxl"), "jxl");
    assert.equal(decoderKeyForFile("dicom", "scan.dcm"), "dicom-parser");

    assert.equal(isDockFileEligible({ type: "unknown", categoryEnabled: true, decoderEnabled: true }), false);
    assert.equal(isDockFileEligible({ type: "pdf", categoryEnabled: false, decoderEnabled: true }), false);
    assert.equal(isDockFileEligible({ type: "model3d", categoryEnabled: true, decoderEnabled: false }), false);
    assert.equal(canInterceptDockAttachment({
        surface: attachmentSurface,
        gate: { type: "rasterimage", categoryEnabled: true, decoderEnabled: false }
    }), false);

    // PSD remains rasterimage when enabled; inline <img> previews must not retype it
    // to the ImageViewer route (which would bypass ag-psd).
    const psdType = detectType({ url: "https://cdn.discordapp.com/attachments/100/200/photo.psd" });
    assert.equal(psdType, "rasterimage");
    assert.equal(isDockFileEligible({ type: psdType, categoryEnabled: true, decoderEnabled: true }), true);
    assert.equal(inlineImageTypeFor(psdType), null);
    assert.equal(inlineImageTypeFor("image"), "image");
});

test("iframe links allow HTTP(S)/mailto, block unsafe schemes, and bind sender/base", () => {
    const base = "https://cdn.example.test/docs/source.md";
    assert.equal(resolveIframeLink("https://example.test/page", base), "https://example.test/page");
    assert.equal(resolveIframeLink("mailto:user@example.test", base), "mailto:user@example.test");
    assert.equal(resolveIframeLink("../next.pdf", base), "https://cdn.example.test/next.pdf");
    for (const unsafe of ["javascript:alert(1)", "file:///tmp/a", "data:text/html,x"]) {
        assert.equal(isAllowedIframeRawLink(unsafe), false);
        assert.equal(resolveIframeLink(unsafe, base), null);
    }
    assert.equal(canOpenIframeDock("https://example.test/page"), true);
    assert.equal(canOpenIframeDock("mailto:user@example.test"), false);

    const activeSource = {};
    const hiddenSource = {};
    const activeFrame = {
        contentWindow: activeSource,
        isConnected: true,
        style: { display: "" },
        src: "https://cdn.example.test/docs/index.html"
    };
    const hiddenFrame = {
        contentWindow: hiddenSource,
        isConnected: true,
        style: { display: "none" },
        src: "https://other.example.test/hidden/index.html"
    };
    assert.equal(iframeForSource(activeSource, [hiddenFrame, activeFrame]), activeFrame);
    assert.equal(iframeForSource(hiddenSource, [hiddenFrame, activeFrame]), null);
    assert.equal(iframeForSource({}, [activeFrame]), null);

    const activeBase = iframeLinkBase(activeFrame, base);
    assert.equal(activeBase, "https://cdn.example.test/docs/index.html");
    assert.equal(resolveIframeLink("next.pdf", activeBase), "https://cdn.example.test/docs/next.pdf");
    // A hidden/non-active sender cannot make its different base resolve through the
    // active window: ownership is rejected before URL normalization.
    assert.equal(iframeForSource(hiddenSource, [hiddenFrame]), null);
});

test("media provisional readiness handles success, cache-hit, active/inactive errors, and stale seq", () => {
    const successWindow = {
        content: { type: "video", seq: 7, loading: false, error: null },
        openRollback: {}
    };
    // A cache hit restores content.loading=false, but a new provisional window must
    // still wait for native readiness before its rollback contract is cleared.
    assert.equal(holdPendingMediaOpen(successWindow), true);
    assert.equal(isPendingMediaOpen(successWindow), true);
    assert.equal(markMediaLoaded(successWindow, 7), true);
    assert.equal(successWindow.content.loading, false);
    assert.equal(successWindow.openRollback, null);
    assert.equal(isPendingMediaOpen(successWindow), false);

    const cacheHitWindow = {
        content: { type: "audio", seq: 8, loading: false, error: null },
        openRollback: {}
    };
    assert.equal(holdPendingMediaOpen(cacheHitWindow), true);
    assert.equal(cacheHitWindow.content.loading, true);

    // A -> B -> A switch can reconcile A from its ready cache entry and overwrite
    // the window's loading bit. Re-applying the hold before layout settle restores
    // the provisional boundary without making CacheEntry.loading stay pending.
    const tabA = {
        content: { type: "video", seq: 13, loading: true, error: null },
        openRollback: {}
    };
    const tabB = {
        content: { type: "audio", seq: 14, loading: false, error: null },
        openRollback: null
    };
    assert.equal(holdPendingMediaOpen(tabA), true);
    tabA.content.loading = false; // mountFromCache while switching B -> A
    assert.equal(tabB.openRollback, null);
    assert.equal(isPendingMediaOpen(tabA), true); // cache mount did not end the provisional open
    assert.equal(holdPendingMediaOpen(tabA), true);
    assert.equal(isPendingMediaOpen(tabA), true);

    // Both active and background provisional tabs leave openRollback in place; the
    // next layout settle then closes/removes them through the existing contract.
    const inactiveWindow = {
        content: { type: "video", seq: 9, loading: true, error: null },
        openRollback: {}
    };
    const activeWindow = {
        content: { type: "audio", seq: 10, loading: true, error: null },
        openRollback: {}
    };
    assert.equal(markMediaDecodeError(inactiveWindow, 9), true);
    assert.equal(markMediaDecodeError(activeWindow, 10), true);
    assert.equal(inactiveWindow.content.error, MEDIA_DECODE_ERROR);
    assert.equal(activeWindow.content.error, MEDIA_DECODE_ERROR);
    assert.notEqual(inactiveWindow.openRollback, null);
    assert.notEqual(activeWindow.openRollback, null);

    const staleWindow = {
        content: { type: "video", seq: 11, loading: true, error: null },
        openRollback: {}
    };
    staleWindow.content.seq = 12;
    assert.equal(markMediaLoaded(staleWindow, 11), false);
    assert.equal(markMediaDecodeError(staleWindow, 11), false);
    assert.equal(staleWindow.content.loading, true);
    assert.equal(staleWindow.content.error, null);
});

test("tab-owned media probes survive body unmount/seq changes and clean every terminal path", () => {
    cancelAllMediaProbes();
    const made = [];
    const factory = () => {
        const element = new FakeMediaProbeElement();
        made.push(element);
        return element;
    };

    // A's visible body may unmount while B is selected. The tab-owned probe remains,
    // and a focus-only seq bump on A does not invalidate the same descriptor.
    const tabA = provisionalMediaWindow("a");
    assert.equal(startMediaProbe(tabA, "video", tabA.content.url, factory), true);
    const probeA = made.at(-1);
    assert.equal(hasMediaProbe(tabA), true);
    tabA.content.seq += 1; // A -> B -> A remount, same window + cache identity
    probeA.emit("loadedmetadata");
    assert.equal(tabA.openRollback, null);
    assert.equal(tabA.content.loading, false);
    assert.equal(hasMediaProbe(tabA), false);
    assert.equal(probeA.pauseCount, 1);
    assert.equal(probeA.srcRemovalCount, 1);

    // An inactive failing tab is still observed; settlePendingOpens can now remove it.
    const inactive = provisionalMediaWindow("inactive", "audio");
    startMediaProbe(inactive, "audio", inactive.content.url, factory);
    const inactiveProbe = made.at(-1);
    inactiveProbe.emit("error");
    assert.equal(inactive.content.error, MEDIA_DECODE_ERROR);
    assert.notEqual(inactive.openRollback, null);
    assert.equal(hasMediaProbe(inactive), false);

    // Replacing the descriptor cancels the old observer. Even a captured stale
    // callback cannot mutate or delete the replacement probe.
    const replaced = provisionalMediaWindow("replace");
    startMediaProbe(replaced, "video", replaced.content.url, factory);
    const first = made.at(-1);
    const staleError = first.listener("error");
    replaced.activeCacheKey = "video:https://cdn.discordapp.com/attachments/100/201/new";
    replaced.content.url = "https://cdn.discordapp.com/attachments/100/201/new.mp4";
    startMediaProbe(replaced, "video", replaced.content.url, factory);
    const second = made.at(-1);
    assert.notEqual(first, second);
    staleError();
    assert.equal(replaced.content.error, null);
    assert.equal(hasMediaProbe(replaced), true);
    second.emit("canplay");
    assert.equal(replaced.openRollback, null);

    const closed = provisionalMediaWindow("closed");
    startMediaProbe(closed, "video", closed.content.url, factory);
    const closedProbe = made.at(-1);
    const lateLoaded = closedProbe.listener("loadedmetadata");
    cancelMediaProbe(closed);
    lateLoaded();
    assert.notEqual(closed.openRollback, null);
    assert.equal(closed.content.loading, true);

    const resetA = provisionalMediaWindow("reset-a");
    const resetB = provisionalMediaWindow("reset-b", "audio");
    startMediaProbe(resetA, "video", resetA.content.url, factory);
    startMediaProbe(resetB, "audio", resetB.content.url, factory);
    cancelAllMediaProbes();
    assert.equal(hasMediaProbe(resetA), false);
    assert.equal(hasMediaProbe(resetB), false);
});

test("production seams keep portal, sender, media, and web/file capabilities explicit", () => {
    const embed = source("plugin/embed.ts");
    const plugin = source("plugin/index.tsx");
    const load = source("plugin/engine/load.ts");
    const mediaViewer = source("plugin/viewers/media/MediaViewer.ts");
    const media = source("plugin/viewers/media/MediaBody.tsx");
    const mediaProbe = source("plugin/viewers/media/mediaProbe.ts");
    const windows = source("plugin/engine/window.ts");
    const stateCards = source("plugin/ui/StateCards.tsx");
    const moreMenu = source("plugin/ui/DockMoreMenu.tsx");
    const panel = source("plugin/ui/DockPanel.tsx");

    assert.match(embed, /portalThreadIdFromSurface\(!!portal, message\.channelId\)/);
    assert.doesNotMatch(embed, /dataset\.dockviewThreadId/);
    assert.match(plugin, /host\.id !== "dockview-root"/);
    assert.match(plugin, /iframe\.dockview-frame/);
    assert.match(plugin, /iframeForSource\(source, frames\)/);
    assert.match(plugin, /__dockViewMdTocReady[\s\S]*liveIframeForSource\(e\.source\)/);
    assert.match(plugin, /__dockViewMdCopy[\s\S]*liveIframeForSource\(e\.source\)/);
    assert.match(load, /startMediaProbe\(win, type, opts\.url\)/);
    assert.match(load, /if \(opts\.noCache\) cancelMediaProbe\(win\)/);
    assert.doesNotMatch(mediaViewer, /holdPendingMediaOpen/);
    assert.match(panel, /isPendingMediaOpen\(activeWindow\)[\s\S]*holdPendingMediaOpen\(activeWindow\)/);
    assert.match(media, /markMediaDecodeError\(win, mediaSeq\)/);
    assert.match(mediaProbe, /new Map<DockWindow, ProbeRecord>/);
    assert.match(mediaProbe, /removeEventListener\("error", record\.error\)/);
    assert.match(windows, /cancelMediaProbe\(w\)/);
    assert.match(windows, /cancelAllMediaProbes\(\)/);
    assert.match(media, /onLoadedMetadata: reportLoaded/);
    assert.match(media, /onCanPlay: reportLoaded/);
    assert.match(media, /requestRender\(\)/);
    assert.doesNotMatch(media, /setFailed|dockview-media-fallback/);
    assert.doesNotMatch(stateCards, /openUrlInVesktopWindow/);
    assert.match(moreMenu, /hasFileActionSurface/);
    assert.match(panel, /hasFileActionSurface/);
    assert.equal(hasFileActionSurface("pdf"), true);
    assert.equal(hasFileActionSurface("web"), false);
    assert.equal(hasFileActionSurface("thread"), false);
});
