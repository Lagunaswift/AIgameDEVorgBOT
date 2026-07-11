import { Events, EmbedBuilder } from 'discord.js';
import { getDb, serverTimestamp } from '../firebase.js';
import { getEffectiveConfig } from '../services/config.js';

export const name = Events.MessageCreate;
export const once = false;

function seenUsersRef() {
  return getDb().collection('seenUsers');
}

export async function execute(message) {
  if (message.author.bot) return;
  if (!message.guild) return;

  try {
    const cfg = await getEffectiveConfig();
    if (!cfg.modFeedChannelId) return;

    const userId = message.author.id;
    const docRef = seenUsersRef().doc(userId);

    const snap = await docRef.get();
    if (snap.exists) return;

    await docRef.set({
      userId,
      tag: message.author.tag,
      firstMessageChannelId: message.channelId,
      firstMessageId: message.id,
      joinedAt: message.member?.joinedAt || null,
      seenAt: serverTimestamp(),
    });

    const feedChannel = await message.client.channels.fetch(cfg.modFeedChannelId);
    if (!feedChannel || !feedChannel.isTextBased()) return;

    const preview = message.content.length > 100
      ? message.content.slice(0, 100) + '…'
      : message.content || '*[no text content]*';

    const embed = new EmbedBuilder()
      .setColor(0xFF6B35)
      .setDescription(
        `<:ShowcaseBotReact:1521124760220729445> **New Poster Detected**\n\n` +
        `**Who:** <@${userId}> (${message.author.tag})\n` +
        `**Where:** <#${message.channelId}>\n` +
        `**Said:** ${preview}`,
      )
      .setFooter({ text: '▸ SHOWCASE BOT ◂' })
      .setTimestamp();

    await feedChannel.send({ embeds: [embed] });
    console.log(`[newPoster] first post from ${message.author.tag} in #${message.channelId}`);
  } catch (err) {
    console.error('[messageCreate] new poster check failed:', err.message);
  }
}
