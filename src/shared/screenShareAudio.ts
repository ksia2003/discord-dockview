/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface LinuxScreenShareSettings {
    includeSources?: unknown;
}

export function requestsLinuxScreenShareAudio(settings: LinuxScreenShareSettings | null | undefined) {
    const includeSources = settings?.includeSources;

    if (includeSources === "Entire System") {
        return true;
    }

    return (
        Array.isArray(includeSources) &&
        includeSources.length > 0 &&
        includeSources.every(
            source =>
                typeof source === "object" &&
                source !== null &&
                !Array.isArray(source) &&
                Object.keys(source).length > 0 &&
                Object.values(source).every(value => typeof value === "string")
        )
    );
}

export function isCurrentScreenShareGeneration<T>(
    activeGeneration: T | null,
    generation: T,
    activeSettings: unknown,
    generationSettings: unknown
) {
    return activeGeneration === generation && activeSettings === generationSettings;
}
