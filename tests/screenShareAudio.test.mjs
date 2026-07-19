import assert from "node:assert/strict";
import test from "node:test";

import {
    isCurrentScreenShareGeneration,
    requestsLinuxScreenShareAudio,
    withLinuxScreenShareAudioDisabled
} from "../src/shared/screenShareAudio.ts";
import {
    getAudioServiceExclusions,
    getAudioServicePids,
    getAudioServiceWorkarounds
} from "../src/main/venmicRouting.ts";

test("Linux audio intent requires an explicit non-None source", () => {
    assert.equal(requestsLinuxScreenShareAudio(undefined), false);
    assert.equal(requestsLinuxScreenShareAudio({}), false);
    assert.equal(requestsLinuxScreenShareAudio({ includeSources: null }), false);
    assert.equal(requestsLinuxScreenShareAudio({ includeSources: "None" }), false);
    assert.equal(requestsLinuxScreenShareAudio({ includeSources: "Microphone" }), false);
    assert.equal(requestsLinuxScreenShareAudio({ includeSources: [] }), false);
    assert.equal(requestsLinuxScreenShareAudio({ includeSources: [null] }), false);
    assert.equal(requestsLinuxScreenShareAudio({ includeSources: [{}] }), false);
    assert.equal(requestsLinuxScreenShareAudio({ includeSources: [{ "node.name": "mic" }] }), true);
    assert.equal(requestsLinuxScreenShareAudio({ includeSources: "Entire System" }), true);
});

test("Linux audio failure fallback preserves the stream as video-only", () => {
    const settings = { audio: true, includeSources: [{ "node.name": "desktop" }], contentHint: "motion" };

    assert.deepEqual(withLinuxScreenShareAudioDisabled(settings), {
        audio: true,
        includeSources: "None",
        contentHint: "motion"
    });
    assert.deepEqual(settings.includeSources, [{ "node.name": "desktop" }]);
});

test("an old screen-share generation cannot clean up the active generation", () => {
    const oldGeneration = {};
    const newGeneration = {};
    const settings = {};

    assert.equal(isCurrentScreenShareGeneration(newGeneration, oldGeneration, settings, settings), false);
    assert.equal(isCurrentScreenShareGeneration(newGeneration, newGeneration, settings, settings), true);
});

test("Audio Service metrics support both Electron metric names and all PIDs", () => {
    const pids = getAudioServicePids([
        { name: "Audio Service", pid: 101 },
        { serviceName: "Audio Service", pid: 202 },
        { serviceName: "audio.mojom.AudioService", pid: 404 },
        { name: "Audio Service", serviceName: "Audio Service", pid: 101 },
        { name: "Renderer", pid: 303 },
        { serviceName: "audio.mojom.OtherAudioService", pid: 505 },
        { name: "Audio Service" }
    ]);

    assert.deepEqual(pids, ["101", "202", "404"]);
    assert.deepEqual(getAudioServiceExclusions(pids), [
        { "application.process.id": "101" },
        { "application.process.id": "202" },
        { "application.process.id": "404" }
    ]);
    assert.deepEqual(getAudioServiceWorkarounds(pids), [
        { "application.process.id": "101", "media.name": "RecordStream" },
        { "application.process.id": "202", "media.name": "RecordStream" },
        { "application.process.id": "404", "media.name": "RecordStream" }
    ]);
    assert.deepEqual(getAudioServiceExclusions([]), []);
    assert.deepEqual(getAudioServiceWorkarounds([]), []);
});
