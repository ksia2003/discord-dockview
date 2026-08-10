import { ChannelStore, NavigationRouter } from "@vencord/types/webpack/common";

export function jumpToSourceMessage(source: { channelId: string; messageId: string; }): void {
    const guildId = ChannelStore.getChannel(source.channelId)?.guild_id ?? "@me";
    NavigationRouter.transitionTo(`/channels/${guildId}/${source.channelId}/${source.messageId}`);
}
