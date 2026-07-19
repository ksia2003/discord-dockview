/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface AudioServiceMetric {
    name?: string;
    serviceName?: string;
    pid?: number;
}

const AUDIO_SERVICE_DISPLAY_NAME = "Audio Service";
const AUDIO_SERVICE_IDENTIFIERS = new Set(["Audio Service", "audio.mojom.AudioService"]);

export function getAudioServicePids(metrics: readonly AudioServiceMetric[]) {
    const pids = new Set<string>();

    for (const metric of metrics) {
        if (metric.name !== AUDIO_SERVICE_DISPLAY_NAME && !AUDIO_SERVICE_IDENTIFIERS.has(metric.serviceName ?? "")) {
            continue;
        }

        if (typeof metric.pid === "number" && Number.isFinite(metric.pid)) {
            pids.add(metric.pid.toString());
        }
    }

    return [...pids];
}

export function getAudioServiceExclusions(pids: readonly string[]) {
    return pids.map(pid => ({ "application.process.id": pid }));
}

export function getAudioServiceWorkarounds(pids: readonly string[]) {
    return pids.map(pid => ({ "application.process.id": pid, "media.name": "RecordStream" }));
}
