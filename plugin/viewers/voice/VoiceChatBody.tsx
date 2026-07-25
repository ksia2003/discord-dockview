/*
 * Controller for the permanent voice CHAT tab.
 *
 * The real chat lives in an isolated body-level portal; this component owns its show
 * claim, drives one hidden capture on first use, and leaves a backdrop/position target in
 * DockView's body.
 */

import { React } from "@vencord/types/webpack/common";

import { getCurrentChannelMemId } from "../../engine/channelMemory";
import { requestRender } from "../../engine/forceRender";
import {
    captureVoiceChat, getVoiceChatType, primeVoiceChat
} from "../../host/voiceChatCapture";
import { STRINGS } from "../../strings";
import {
    releaseVoiceChatPortals, showVoiceChatPortal
} from "./voiceChatPortal";

export function VoiceChatBody() {
    const { useEffect, useState } = React;
    const channelId = getCurrentChannelMemId();
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (!channelId) return;
        let alive = true;
        let claim = 0;

        const show = () => {
            if (!alive) return;
            claim = showVoiceChatPortal(channelId);
            requestRender();
        };

        try {
            if (getVoiceChatType() || captureVoiceChat(channelId)) {
                show();
            } else {
                primeVoiceChat(channelId).then(ok => {
                    if (!alive) return;
                    if (ok) show();
                    else setFailed(true);
                });
            }
        } catch {
            setFailed(true);
        }

        return () => {
            alive = false;
            try { if (claim) releaseVoiceChatPortals(claim); } catch { /* ignore */ }
        };
    }, [channelId]);

    return React.createElement(
        "div",
        { className: "dockview-voice-chat-slot dockview-voice-chat-backdrop" },
        failed
            ? React.createElement(
                "div",
                { className: "dockview-voice-chat-status" },
                STRINGS.voiceChat.fail
            )
            : !getVoiceChatType()
                ? React.createElement(
                    "div",
                    { className: "dockview-voice-chat-status", role: "status" },
                    STRINGS.voiceChat.loading
                )
                : null
    );
}
