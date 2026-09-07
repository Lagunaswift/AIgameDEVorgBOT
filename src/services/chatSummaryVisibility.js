import { ChannelType, PermissionFlagsBits } from 'discord.js';

// A recap source must be visible to every server member, not merely to the bot. Fetch both
// records with force so a cached channel or role cannot turn a later-restricted source into
// transcript input. `false` disables Discord's Administrator shortcut: the two permissions
// must be explicitly effective for @everyone.
export async function fetchPublicRecapChannel(client, channelId, guildId) {
  if (!guildId) return null;

  let channel;
  try {
    channel = await client.channels.fetch(channelId, { force: true });
  } catch (err) {
    console.warn(`[chatSummary] could not refresh chat channel ${channelId}: ${err.message}`);
    return null;
  }

  if (
    !channel ||
    channel.id !== channelId ||
    channel.guildId !== guildId ||
    !channel.guild ||
    channel.guild.id !== guildId ||
    channel.nsfw !== false ||
    ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
    typeof channel.permissionsFor !== 'function' ||
    typeof channel.messages?.fetch !== 'function'
  ) {
    console.warn(`[chatSummary] chat channel ${channelId} is not an approved public guild channel; skipping`);
    return null;
  }

  let everyone;
  try {
    everyone = await channel.guild.roles.fetch(guildId, { force: true });
  } catch (err) {
    console.warn(`[chatSummary] could not refresh @everyone for chat channel ${channelId}: ${err.message}`);
    return null;
  }

  if (!everyone || everyone.id !== guildId || everyone.guild?.id !== guildId) {
    console.warn(`[chatSummary] @everyone metadata is unavailable for chat channel ${channelId}; skipping`);
    return null;
  }

  try {
    const permissions = channel.permissionsFor(everyone, false);
    if (
      !permissions ||
      !permissions.has(PermissionFlagsBits.ViewChannel, false) ||
      !permissions.has(PermissionFlagsBits.ReadMessageHistory, false)
    ) {
      console.warn(`[chatSummary] chat channel ${channelId} is not publicly readable; skipping`);
      return null;
    }
  } catch {
    console.warn(`[chatSummary] permissions unavailable for chat channel ${channelId}; skipping`);
    return null;
  }

  return channel;
}
