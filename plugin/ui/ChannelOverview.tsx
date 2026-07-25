/*
 * Guild-channel summary for the permanent CHANNEL tab.
 *
 * It follows Discord's live Channel/UserGuildSettings stores: a remote topic edit or a
 * notification change made through Discord's native menu updates this surface immediately.
 * Topic markup is rendered by Discord's own Parser.parseTopic so mentions, channel links,
 * emoji and formatting retain upstream behaviour.
 *
 * Mute/notification writes use Discord's current updateChannelOverrideSettings action.
 * No raw REST route is introduced. The compact menus mirror the native channel menu's
 * values/payloads; the ⋯ button delegates to Channel.handleContextMenu for every lower-
 * frequency/permission-sensitive action.
 */

import { findByPropsLazy } from "@vencord/types/webpack";
import {
    ChannelStore, ContextMenuApi, Menu, Parser, React, UserGuildSettingsStore,
    useStateFromStores
} from "@vencord/types/webpack/common";

import { copyText } from "../external/openExternal";
import { openNativeChannelMenu } from "../host/channelView";
import { STRINGS } from "../strings";

const NotificationActions = findByPropsLazy(
    "updateChannelOverrideSettings",
    "updateGuildNotificationSettings"
) as any;

const NOTIFICATION_DEFAULT = -1;
const NOTIFICATION_ALL = 0;
const NOTIFICATION_MENTIONS = 1;
const NOTIFICATION_NONE = 2;

const MUTE_DURATIONS = [
    [15 * 60, () => STRINGS.channel.mute15Minutes],
    [60 * 60, () => STRINGS.channel.mute1Hour],
    [3 * 60 * 60, () => STRINGS.channel.mute3Hours],
    [8 * 60 * 60, () => STRINGS.channel.mute8Hours],
    [24 * 60 * 60, () => STRINGS.channel.mute24Hours],
    [-1, () => STRINGS.channel.muteUntilTurnedBackOn]
] as const;

const ICON = {
    mute: "M13 3.5v2.08a6.5 6.5 0 0 1 4 5.92V15l2 2v1H5v-1l2-2v-3.5a6.5 6.5 0 0 1 4-5.92V3.5a1 1 0 1 1 2 0ZM9.5 20h5a2.5 2.5 0 0 1-5 0Z",
    notifications: "M12 2a2 2 0 0 1 2 2v.35A6.5 6.5 0 0 1 18.5 10v4l2 2v2h-17v-2l2-2v-4A6.5 6.5 0 0 1 10 4.35V4a2 2 0 0 1 2-2Zm-2.5 18h5a2.5 2.5 0 0 1-5 0Z",
    link: "M9.9 13.5a1 1 0 0 1 0-1.4l2.2-2.2a1 1 0 0 1 1.4 1.4l-2.2 2.2a1 1 0 0 1-1.4 0ZM7.6 18a3 3 0 0 1 0-4.2l2.1-2.1a1 1 0 0 1 1.4 1.4L9 15.2a1 1 0 0 0 1.4 1.4l2.1-2.1a1 1 0 1 1 1.4 1.4L11.8 18a3 3 0 0 1-4.2 0Zm9.9-9.9a3 3 0 0 1 0 4.2l-2.1 2.1A1 1 0 1 1 14 13l2.1-2.1a1 1 0 0 0-1.4-1.4l-2.1 2.1a1 1 0 0 1-1.4-1.4l2.1-2.1a3 3 0 0 1 4.2 0Z",
    more: "M5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"
};

function icon(path: string) {
    return React.createElement(
        "svg",
        { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
        React.createElement("path", { fill: "currentColor", d: path })
    );
}

function updateOverride(channel: any, change: Record<string, any>): void {
    if (!channel?.guild_id || !channel?.id) return;
    try {
        NotificationActions.updateChannelOverrideSettings(
            channel.guild_id,
            channel.id,
            change
        );
    } catch { /* Discord's native action was unavailable; leave the current state alone. */ }
}

function mutePayload(seconds: number) {
    return {
        muted: true,
        mute_config: {
            selected_time_window: seconds,
            end_time: seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : null
        }
    };
}

function MuteMenu({ channel, muted }: { channel: any; muted: boolean; }) {
    const items: any[] = [];
    if (muted) {
        items.push(React.createElement(Menu.MenuItem, {
            key: "unmute",
            id: "dockview-channel-unmute",
            label: STRINGS.channel.unmute,
            action: () => updateOverride(channel, { muted: false })
        }));
    }
    for (const [seconds, label] of MUTE_DURATIONS) {
        items.push(React.createElement(Menu.MenuItem, {
            key: seconds,
            id: `dockview-channel-mute-${seconds}`,
            label: label(),
            action: () => updateOverride(channel, mutePayload(seconds))
        }));
    }
    return React.createElement(
        Menu.Menu,
        { navId: "dockview-channel-mute", onClose: ContextMenuApi.closeContextMenu },
        React.createElement(Menu.MenuGroup, null, ...items)
    );
}

function NotificationMenu({ channel, direct }: { channel: any; direct: number; }) {
    const choices = [
        [NOTIFICATION_DEFAULT, STRINGS.channel.notificationDefault],
        [NOTIFICATION_ALL, STRINGS.channel.notificationAll],
        [NOTIFICATION_MENTIONS, STRINGS.channel.notificationMentions],
        [NOTIFICATION_NONE, STRINGS.channel.notificationNothing]
    ] as const;
    return React.createElement(
        Menu.Menu,
        { navId: "dockview-channel-notifications", onClose: ContextMenuApi.closeContextMenu },
        React.createElement(
            Menu.MenuGroup,
            null,
            ...choices.map(([value, label]) => React.createElement(Menu.MenuRadioItem, {
                key: value,
                id: `dockview-channel-notifications-${value}`,
                group: "dockview-channel-notifications",
                label,
                checked: direct === value,
                action: () => updateOverride(channel, { message_notifications: value })
            }))
        )
    );
}

function actionButton(opts: {
    key: string;
    label: string;
    subtext?: string;
    path: string;
    active?: boolean;
    onClick(event: any): void;
}) {
    return React.createElement(
        "button",
        {
            key: opts.key,
            type: "button",
            className: "dockview-channel-action" + (opts.active ? " dockview-channel-action--active" : ""),
            "aria-label": opts.label,
            title: opts.subtext ? `${opts.label}: ${opts.subtext}` : opts.label,
            onClick: opts.onClick
        },
        icon(opts.path),
        React.createElement(
            "span",
            { className: "dockview-channel-action-copy" },
            React.createElement("span", { className: "dockview-channel-action-label" }, opts.label),
            opts.subtext
                ? React.createElement("span", { className: "dockview-channel-action-subtext" }, opts.subtext)
                : null
        )
    );
}

function notificationLabel(value: number): string {
    switch (value) {
        case NOTIFICATION_ALL: return STRINGS.channel.notificationAll;
        case NOTIFICATION_MENTIONS: return STRINGS.channel.notificationMentions;
        case NOTIFICATION_NONE: return STRINGS.channel.notificationNothing;
        default: return STRINGS.channel.notificationDefault;
    }
}

export function ChannelOverview({ channelId }: { channelId: string; }) {
    const channel = useStateFromStores(
        [ChannelStore],
        () => ChannelStore.getChannel(channelId),
        [channelId]
    ) as any;
    const guildId = channel?.guild_id ?? "";
    const muted = useStateFromStores(
        [UserGuildSettingsStore],
        () => !!guildId && UserGuildSettingsStore.isChannelMuted(guildId, channelId),
        [guildId, channelId]
    );
    const notification = useStateFromStores(
        [UserGuildSettingsStore],
        () => channel ? UserGuildSettingsStore.resolvedMessageNotifications(channel) : NOTIFICATION_DEFAULT,
        [channel]
    );
    const directNotification = useStateFromStores(
        [UserGuildSettingsStore],
        () => {
            if (!guildId) return NOTIFICATION_DEFAULT;
            const value = UserGuildSettingsStore.getChannelOverrides(guildId)?.[channelId]?.message_notifications;
            return typeof value === "number" ? value : NOTIFICATION_DEFAULT;
        },
        [guildId, channelId]
    );

    if (!channel?.guild_id) return null;

    let topic: any = STRINGS.channel.noTopic;
    let hasTopic = false;
    if (typeof channel.topic === "string" && channel.topic.trim()) {
        hasTopic = true;
        try {
            topic = Parser.parseTopic(channel.topic, false, { channelId: channel.id });
        } catch {
            topic = channel.topic;
        }
    }

    const canUseNotificationShortcuts = !channel.isThread?.() && !channel.isForumPost?.();
    const actions: any[] = [];
    if (canUseNotificationShortcuts) {
        actions.push(actionButton({
            key: "mute",
            label: muted ? STRINGS.channel.muted : STRINGS.channel.mute,
            path: ICON.mute,
            active: muted,
            onClick: event => ContextMenuApi.openContextMenu(
                event,
                () => React.createElement(MuteMenu, { channel, muted })
            )
        }));
        actions.push(actionButton({
            key: "notifications",
            label: STRINGS.channel.notifications,
            subtext: notificationLabel(notification),
            path: ICON.notifications,
            onClick: event => ContextMenuApi.openContextMenu(
                event,
                () => React.createElement(NotificationMenu, { channel, direct: directNotification })
            )
        }));
    }
    actions.push(actionButton({
        key: "copy-link",
        label: STRINGS.channel.copyLink,
        path: ICON.link,
        onClick: () => copyText(`https://discord.com/channels/${channel.guild_id}/${channel.id}`)
    }));
    actions.push(actionButton({
        key: "more",
        label: STRINGS.channel.more,
        path: ICON.more,
        onClick: event => openNativeChannelMenu(event, channel.id)
    }));

    return React.createElement(
        "section",
        { className: "dockview-channel-overview", "aria-label": STRINGS.channel.overview },
        React.createElement(
            "div",
            { className: "dockview-channel-heading" },
            React.createElement("span", { className: "dockview-channel-hash", "aria-hidden": true }, "#"),
            React.createElement("h2", { className: "dockview-channel-name" }, channel.name)
        ),
        React.createElement(
            "div",
            {
                className: "dockview-channel-topic" + (hasTopic ? "" : " dockview-channel-topic--empty")
            },
            topic
        ),
        React.createElement("div", { className: "dockview-channel-actions" }, ...actions)
    );
}
