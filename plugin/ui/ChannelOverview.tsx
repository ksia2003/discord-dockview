/*
 * Guild-channel identity for the permanent CHANNEL tab.
 *
 * This is deliberately not a DockView-designed card or action dashboard. It follows the
 * grammar of Discord's CHANNEL HEADER: its exact native title and toolbar, muted topic
 * copy, and a separator. It does NOT impersonate a member row (no fake avatar/status slot
 * or member hover surface).
 *
 * The toolbar remains owned by Discord's original header React tree and is portaled into
 * this detached root, so its local popover state and permission-aware behavior survive.
 * The overflow fallback and row right-click delegate to Channel.handleContextMenu.
 */

import { findCssClasses } from "@vencord/types/webpack";
import {
    ChannelStore, Clickable, Parser, React, useStateFromStores
} from "@vencord/types/webpack/common";

import {
    getNativeChannelHeaderSubtitle, openNativeChannelMenu
} from "../host/channelView";
import {
    bindUnifiedChannelToolbarTarget, getUnifiedChannelHeaderTitle
} from "../host/unifiedHeader";

type ClassMap = Record<string, string>;

function cssMod(...keys: string[]): ClassMap {
    try {
        const value = (findCssClasses as any)?.(...keys);
        if (value && typeof value === "object") return value;
    } catch {
        /* fall through to the dated class fallbacks */
    }
    return {};
}

const headerMod = cssMod(
    "titleWrapper", "title", "channelIcon", "iconWrapper", "clickable", "icon"
);

const CLS = {
    titleWrapper: headerMod.titleWrapper || "titleWrapper__9293f",
    title: headerMod.title || "title__9293f",
    channelIcon: headerMod.channelIcon || "channelIcon__9293f",
    iconWrapper: headerMod.iconWrapper || "iconWrapper__9293f",
    iconClickable: headerMod.clickable || "clickable__9293f",
    icon: headerMod.icon || "icon__9293f"
};

const MORE_ICON = "M5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z";

let NativeTopicBoundaryClass: any = null;
function nativeTopicBoundary(): any {
    if (NativeTopicBoundaryClass) return NativeTopicBoundaryClass;
    class NativeTopicBoundary extends (React.Component as any) {
        declare props: any;
        state = { failed: false };
        static getDerivedStateFromError() { return { failed: true }; }
        componentDidCatch() { /* parsed fallback below remains interactive content */ }
        render() {
            return this.state.failed ? this.props.fallback : this.props.children;
        }
    }
    NativeTopicBoundaryClass = NativeTopicBoundary;
    return NativeTopicBoundaryClass;
}

function openMenu(event: any, channelId: string): void {
    if (!openNativeChannelMenu(event, channelId)) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
}

export function ChannelOverview({ channelId }: { channelId: string; }) {
    const { useCallback, useRef } = React;
    const toolbarElement = useRef<HTMLElement | null>(null);
    const bindToolbar = useCallback(
        (element: HTMLElement | null) => {
            const previous = toolbarElement.current;
            toolbarElement.current = element;
            bindUnifiedChannelToolbarTarget(channelId, element, previous);
        },
        [channelId]
    );
    const channel = useStateFromStores(
        [ChannelStore],
        () => ChannelStore.getChannel(channelId),
        [channelId]
    ) as any;

    if (!channel?.guild_id) return null;

    let topic: any = null;
    if (typeof channel.topic === "string" && channel.topic.trim()) {
        try {
            topic = Parser.parseTopic(channel.topic, false, { channelId: channel.id });
        } catch {
            topic = channel.topic;
        }
    }
    // Discord still returns an empty subtitle fragment for some topic-less channels.
    // Gate on the real channel topic so Channel does not keep a zero-height clickable
    // wrapper after switching away from a channel that had one.
    const nativeTopic = topic != null
        ? getNativeChannelHeaderSubtitle(channel.id)
        : null;
    const nativeTitle = getUnifiedChannelHeaderTitle(channel.id);
    const topicContent = nativeTopic != null
        ? React.createElement(
            nativeTopicBoundary(),
            { fallback: topic },
            nativeTopic
        )
        : topic;

    return React.createElement(
        "section",
        {
            className: "dockview-channel-overview",
            "aria-label": channel.name,
            onContextMenu: (event: any) => openMenu(event, channel.id)
        },
        React.createElement(
            "div",
            { className: "dockview-channel-heading" },
            nativeTitle != null
                ? React.createElement(
                    "div",
                    { className: "dockview-channel-native-title" },
                    nativeTitle
                )
                : [
                    React.createElement(
                        "div",
                        { key: "hash", className: `${CLS.channelIcon} ${CLS.iconWrapper} dockview-channel-hash`, "aria-hidden": true },
                        "#"
                    ),
                    React.createElement(
                        "div",
                        { key: "title", className: `${CLS.titleWrapper} dockview-channel-title-wrap` },
                        React.createElement(
                            "h2",
                            { className: `${CLS.title} dockview-channel-title` },
                            channel.name
                        )
                    )
                ],
            React.createElement("div", {
                className: "dockview-channel-native-toolbar",
                "data-channel-id": channel.id,
                ref: bindToolbar
            }),
            nativeTitle == null
                ? React.createElement(
                    Clickable,
                    {
                        className: `${CLS.iconWrapper} ${CLS.iconClickable} dockview-channel-more`,
                        "aria-label": channel.name,
                        "aria-haspopup": "menu",
                        onClick: (event: any) => openMenu(event, channel.id)
                    },
                    React.createElement(
                        "svg",
                        {
                            className: CLS.icon,
                            width: 20,
                            height: 20,
                            viewBox: "0 0 24 24",
                            "aria-hidden": true
                        },
                        React.createElement("path", { fill: "currentColor", d: MORE_ICON })
                    )
                )
                : null
        ),
        topicContent != null
            ? React.createElement(
                "div",
                {
                    className: "dockview-channel-topic"
                        + (nativeTopic != null ? " dockview-channel-topic--native" : "")
                },
                topicContent
            )
            : null
    );
}
