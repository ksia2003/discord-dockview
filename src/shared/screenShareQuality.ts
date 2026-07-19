/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const SCREEN_SHARE_DEFAULT_HEIGHT = 720;
export const SCREEN_SHARE_DEFAULT_FRAME_RATE = 30;
export const SCREEN_SHARE_DEFAULT_WIDTH = 1280;
export const SCREEN_SHARE_BASELINE_BITRATE = 600_000;
export const SCREEN_SHARE_MIN_BITRATE = 500_000;
export const SCREEN_SHARE_TARGET_BITRATE_CAP = 8_000_000;

export interface ScreenShareQualityValues {
    framerate: number;
    height: number;
    width: number;
    pixelCount: number;
}

export interface ScreenShareBitrateValues {
    bitrateMin: number;
    bitrateMax: number;
    bitrateTarget: number;
}

function positiveFinite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function sanitizePositive(value: unknown, fallback: number) {
    return positiveFinite(value) ? value : fallback;
}

export function getScreenShareQualityValues(resolution: unknown, frameRate: unknown): ScreenShareQualityValues {
    const height = sanitizePositive(resolution, SCREEN_SHARE_DEFAULT_HEIGHT);
    const framerate = sanitizePositive(frameRate, SCREEN_SHARE_DEFAULT_FRAME_RATE);
    const width = Math.round(height * (16 / 9));

    return {
        framerate,
        height,
        width,
        pixelCount: width * height
    };
}

export function getAdaptiveScreenShareBitrate(
    { width, height, framerate }: ScreenShareQualityValues,
    existing: Partial<ScreenShareBitrateValues> = {}
): ScreenShareBitrateValues {
    const safeWidth = sanitizePositive(width, SCREEN_SHARE_DEFAULT_WIDTH);
    const safeHeight = sanitizePositive(height, SCREEN_SHARE_DEFAULT_HEIGHT);
    const safeFramerate = sanitizePositive(framerate, SCREEN_SHARE_DEFAULT_FRAME_RATE);
    const pixelsPerSecond = safeWidth * safeHeight * safeFramerate;
    const baselinePixelsPerSecond =
        SCREEN_SHARE_DEFAULT_WIDTH * SCREEN_SHARE_DEFAULT_HEIGHT * SCREEN_SHARE_DEFAULT_FRAME_RATE;
    const calculatedTarget = Math.round(SCREEN_SHARE_BASELINE_BITRATE * (pixelsPerSecond / baselinePixelsPerSecond));
    const adaptiveTarget = Math.min(
        SCREEN_SHARE_TARGET_BITRATE_CAP,
        Math.max(SCREEN_SHARE_MIN_BITRATE, calculatedTarget)
    );
    const existingTargetValue = existing.bitrateTarget;
    const existingTarget = positiveFinite(existingTargetValue) ? existingTargetValue : 0;
    const bitrateTarget = Math.min(SCREEN_SHARE_TARGET_BITRATE_CAP, Math.max(adaptiveTarget, existingTarget));
    const existingMaxValue = existing.bitrateMax;
    const existingMax = positiveFinite(existingMaxValue) ? existingMaxValue : SCREEN_SHARE_TARGET_BITRATE_CAP;

    return {
        bitrateMin: Math.min(SCREEN_SHARE_MIN_BITRATE, bitrateTarget),
        bitrateMax: Math.max(existingMax, SCREEN_SHARE_TARGET_BITRATE_CAP, bitrateTarget),
        bitrateTarget
    };
}
