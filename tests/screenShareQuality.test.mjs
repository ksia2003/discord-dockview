import assert from "node:assert/strict";
import test from "node:test";

import {
    getAdaptiveScreenShareBitrate,
    getScreenShareQualityValues,
    SCREEN_SHARE_TARGET_BITRATE_CAP
} from "../src/shared/screenShareQuality.ts";

function quality(resolution, frameRate) {
    return getScreenShareQualityValues(resolution, frameRate);
}

test("adaptive bitrate preserves the 720p30 compatibility baseline", () => {
    const values = getAdaptiveScreenShareBitrate(quality(720, 30));

    assert.deepEqual(values, {
        bitrateMin: 500_000,
        bitrateMax: 8_000_000,
        bitrateTarget: 600_000
    });
});

test("adaptive bitrate scales 1080p60 and 1440p60 by pixel rate", () => {
    assert.equal(getAdaptiveScreenShareBitrate(quality(1080, 60)).bitrateTarget, 2_700_000);
    assert.equal(getAdaptiveScreenShareBitrate(quality(1440, 60)).bitrateTarget, 4_800_000);
});

test("adaptive bitrate clamps extreme quality to the DockView target cap", () => {
    const values = getAdaptiveScreenShareBitrate(quality(2160, 120));

    assert.equal(values.bitrateTarget, SCREEN_SHARE_TARGET_BITRATE_CAP);
    assert.ok(values.bitrateMin <= values.bitrateTarget);
    assert.ok(values.bitrateMax >= values.bitrateTarget);
});

test("a higher valid existing target is preserved up to the cap", () => {
    assert.equal(getAdaptiveScreenShareBitrate(quality(720, 30), { bitrateTarget: 3_000_000 }).bitrateTarget, 3_000_000);
    assert.equal(getAdaptiveScreenShareBitrate(quality(720, 30), { bitrateTarget: 12_000_000 }).bitrateTarget, 8_000_000);
});

test("an existing max above the DockView cap is preserved", () => {
    const values = getAdaptiveScreenShareBitrate(quality(1080, 60), { bitrateMax: 12_000_000 });

    assert.equal(values.bitrateTarget, 2_700_000);
    assert.equal(values.bitrateMax, 12_000_000);
});

test("the DockView max floor remains when an existing max is smaller", () => {
    const values = getAdaptiveScreenShareBitrate(quality(720, 30), { bitrateMax: 1_000_000 });

    assert.equal(values.bitrateMax, 8_000_000);
});

test("invalid quality inputs fall back to safe 720p30 values", () => {
    assert.deepEqual(quality(Number.NaN, -1), {
        framerate: 30,
        height: 720,
        width: 1280,
        pixelCount: 921_600
    });
    assert.equal(getAdaptiveScreenShareBitrate(quality(0, Number.POSITIVE_INFINITY)).bitrateTarget, 600_000);
});
