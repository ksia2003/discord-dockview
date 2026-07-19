/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@vencord/types/utils";
import { currentSettings } from "renderer/components/ScreenSharePicker";
import { State } from "renderer/settings";
import { isLinux } from "renderer/utils";
import { isCurrentScreenShareGeneration, requestsLinuxScreenShareAudio } from "shared/screenShareAudio";
import { getScreenShareQualityValues } from "shared/screenShareQuality";

const logger = new Logger("VesktopStreamFixes");

if (isLinux) {
    const original = navigator.mediaDevices.getDisplayMedia;
    type ShareGeneration = {
        settings: typeof currentSettings;
        audioRequested: boolean;
        temporaryAudio?: MediaStream;
        cleaned: boolean;
    };

    let activeGeneration: ShareGeneration | null = null;

    function isActiveGeneration(generation: ShareGeneration) {
        return isCurrentScreenShareGeneration(activeGeneration, generation, currentSettings, generation.settings);
    }

    function stopTracks(stream: MediaStream) {
        stream.getTracks().forEach(track => track.stop());
    }

    function removeAudioTracks(stream: MediaStream) {
        stream.getAudioTracks().forEach(track => {
            stream.removeTrack(track);
            track.stop();
        });
    }

    function stopVenmic(generation: ShareGeneration) {
        if (!generation.audioRequested || !isActiveGeneration(generation)) {
            return;
        }

        void VesktopNative.virtmic.stop().catch(error => {
            logger.error("Failed to stop Linux screen-share audio.", error);
        });
    }

    function cleanGeneration(generation: ShareGeneration, stopAudioLink: boolean) {
        if (generation.cleaned) {
            return;
        }

        generation.cleaned = true;

        if (generation.temporaryAudio) {
            stopTracks(generation.temporaryAudio);
            generation.temporaryAudio = undefined;
        }

        if (stopAudioLink) {
            stopVenmic(generation);
        }
    }

    async function getVirtmic() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioDevice = devices.find(({ label }) => label === "vencord-screen-share");
            return audioDevice?.deviceId;
        } catch (error) {
            return null;
        }
    }

    navigator.mediaDevices.getDisplayMedia = async function (opts) {
        const generation: ShareGeneration = {
            settings: currentSettings,
            audioRequested: requestsLinuxScreenShareAudio(currentSettings),
            cleaned: false
        };
        const previousGeneration = activeGeneration;
        activeGeneration = generation;

        if (previousGeneration) {
            cleanGeneration(previousGeneration, false);
        }

        let stream: MediaStream;
        try {
            stream = await original.call(this, opts);
        } catch (error) {
            cleanGeneration(generation, true);
            if (isActiveGeneration(generation)) {
                activeGeneration = null;
            }
            throw error;
        }

        const quality = getScreenShareQualityValues(
            Number(State.store.screenshareQuality?.resolution),
            Number(State.store.screenshareQuality?.frameRate)
        );
        const track = stream.getVideoTracks()[0];

        if (!track) {
            removeAudioTracks(stream);
            cleanGeneration(generation, true);
            if (isActiveGeneration(generation)) {
                activeGeneration = null;
            }
            return stream;
        }

        track.contentHint = String(generation.settings?.contentHint);

        const constraints: MediaTrackConstraints & { resizeMode?: string } = {
            ...track.getConstraints(),
            frameRate: { ideal: quality.framerate, max: quality.framerate },
            width: { ideal: quality.width, max: quality.width },
            height: { ideal: quality.height, max: quality.height }
        };
        delete constraints.advanced;
        delete constraints.resizeMode;

        const supportedConstraints =
            navigator.mediaDevices.getSupportedConstraints() as MediaTrackSupportedConstraints & {
                resizeMode?: boolean;
            };
        const supportsResizeMode = supportedConstraints.resizeMode === true;
        if (supportsResizeMode) {
            constraints.resizeMode = "crop-and-scale";
        }

        try {
            await track.applyConstraints(constraints);
            logger.info("Applied screen-share constraints successfully. New constraints: ", track.getConstraints());
        } catch (error) {
            if (!supportsResizeMode) {
                logger.error("Failed to apply screen-share constraints; continuing with the capture stream.", error);
            } else {
                delete constraints.resizeMode;
                try {
                    await track.applyConstraints(constraints);
                    logger.info(
                        "Applied screen-share constraints without resizeMode. New constraints:",
                        track.getConstraints()
                    );
                } catch (fallbackError) {
                    logger.error(
                        "Failed to apply screen-share constraints with and without resizeMode; continuing with the capture stream.",
                        fallbackError
                    );
                }
            }
        }

        if (!generation.audioRequested) {
            removeAudioTracks(stream);
            return stream;
        }

        const id = await getVirtmic();
        if (!id) {
            logger.warn("Linux screen-share audio was requested, but the virtual audio device was not found.");
            removeAudioTracks(stream);
            cleanGeneration(generation, true);
            if (isActiveGeneration(generation)) {
                activeGeneration = null;
            }
            return stream;
        }

        let audio: MediaStream | undefined;
        try {
            audio = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: {
                        exact: id
                    },
                    autoGainControl: false,
                    echoCancellation: false,
                    noiseSuppression: false,
                    channelCount: 2,
                    sampleRate: 48000,
                    sampleSize: 16
                }
            });

            const replacementTrack = audio.getAudioTracks()[0];
            if (!replacementTrack) {
                logger.warn("Linux screen-share audio capture returned no audio track.");
                removeAudioTracks(stream);
                cleanGeneration(generation, true);
                if (isActiveGeneration(generation)) {
                    activeGeneration = null;
                }
                stopTracks(audio);
                return stream;
            }

            if (!isActiveGeneration(generation)) {
                stopTracks(audio);
                removeAudioTracks(stream);
                return stream;
            }

            removeAudioTracks(stream);
            stream.addTrack(replacementTrack);
            generation.temporaryAudio = audio;

            const cleanOnEnd = () => {
                cleanGeneration(generation, true);
                if (isActiveGeneration(generation)) {
                    activeGeneration = null;
                }
            };
            track.addEventListener("ended", cleanOnEnd, { once: true });
            replacementTrack.addEventListener("ended", cleanOnEnd, { once: true });
        } catch (error) {
            if (audio) {
                stopTracks(audio);
            }
            removeAudioTracks(stream);
            cleanGeneration(generation, true);
            if (isActiveGeneration(generation)) {
                activeGeneration = null;
            }
            logger.error("Failed to capture Linux screen-share audio; continuing with video only.", error);
        }

        return stream;
    };
}
