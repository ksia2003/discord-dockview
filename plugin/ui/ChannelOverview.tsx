/*
 * Guild-channel identity for the permanent CHANNEL tab.
 *
 * This is deliberately not a DockView-designed card or action dashboard. It borrows the
 * exact CSS modules Discord uses for a member-list row and its header icon buttons, so the
 * channel identity reads as part of the member list below it. The only DockView styling
 * left is the small amount needed to let a channel topic wrap beyond a member's one-line
 * status.
 *
 * Clicking the native-looking overflow control (or right-clicking the row) delegates to
 * Channel.handleContextMenu. Mute, notifications, copy link, edit, and every permission-
 * sensitive action therefore remain Discord's own localized menu and behaviour.
 */

import { findCssClasses } from "@vencord/types/webpack";
import {
    ChannelStore, Clickable, Parser, React, useStateFromStores
} from "@vencord/types/webpack/common";

import { openNativeChannelMenu } from "../host/channelView";

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

const memberMod = cssMod(
    "container", "clickable", "childContainer", "layout", "avatar",
    "content", "nameAndDecorators", "name", "subText"
);
const headerMod = cssMod("iconWrapper", "clickable", "icon");

const CLS = {
    row: `${memberMod.container || "container__91a9d"} ${memberMod.clickable || "clickable__91a9d"}`,
    child: memberMod.childContainer || "childContainer__91a9d",
    layout: memberMod.layout || "layout__91a9d",
    avatar: memberMod.avatar || "avatar__91a9d",
    content: memberMod.content || "content__91a9d",
    nameAndDecorators: memberMod.nameAndDecorators || "nameAndDecorators__91a9d",
    name: memberMod.name || "name__91a9d text-md/medium__91a9d",
    subText: memberMod.subText || "subText__91a9d",
    iconWrapper: headerMod.iconWrapper || "iconWrapper__9293f",
    iconClickable: headerMod.clickable || "clickable__9293f",
    icon: headerMod.icon || "icon__9293f"
};

const MORE_ICON = "M5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z";

function openMenu(event: any, channelId: string): void {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    openNativeChannelMenu(event, channelId);
}

export function ChannelOverview({ channelId }: { channelId: string; }) {
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

    return React.createElement(
        "section",
        {
            className: "dockview-channel-overview",
            "aria-label": channel.name,
            onContextMenu: (event: any) => openMenu(event, channel.id)
        },
        React.createElement(
            "div",
            { className: `${CLS.row} dockview-channel-native-row` },
            React.createElement(
                "div",
                { className: CLS.child },
                React.createElement(
                    "div",
                    { className: `${CLS.layout} dockview-channel-native-layout` },
                    React.createElement(
                        "div",
                        {
                            className: `${CLS.avatar} dockview-channel-native-icon`,
                            "aria-hidden": true
                        },
                        "#"
                    ),
                    React.createElement(
                        "div",
                        { className: `${CLS.content} dockview-channel-native-content` },
                        React.createElement(
                            "div",
                            { className: CLS.nameAndDecorators },
                            React.createElement(
                                "div",
                                { className: `${CLS.name} dockview-channel-native-name` },
                                channel.name
                            )
                        ),
                        topic != null
                            ? React.createElement(
                                "div",
                                { className: `${CLS.subText} dockview-channel-native-topic` },
                                topic
                            )
                            : null
                    ),
                    React.createElement(
                        Clickable,
                        {
                            className: `${CLS.iconWrapper} ${CLS.iconClickable} dockview-channel-native-more`,
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
                )
            )
        )
    );
}
