// /logovotes — tally a logo-design competition and show the top entries.
//
// Reads the vote emoji reactions across a competition channel (forum/media threads, or
// messages in a text channel), ranks entries by how many DISTINCT non-bot people voted, and
// by default does not count an entry owner's vote for their own entry. Mod-only and
// ephemeral: the standings are the organiser's to see before any public reveal.

import { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { isMod } from '../lib/permissions.js';
import { config } from '../config.js';
import {
  tallyLogoVotes,
  parseEmojiSpec,
  emojiLabel,
  isThreadedChannel,
  VoterScope,
} from '../services/logoVotes.js';

const MEDALS = ['🥇', '🥈', '🥉'];

const SCOPE_LABEL = {
  [VoterScope.EXCLUDE_SELF]: "everyone except each entry's own owner",
  [VoterScope.NON_CONTESTANTS]: 'only members who did not submit an entry',
  [VoterScope.ALL]: 'everyone, including entry owners',
};

export const data = new SlashCommandBuilder()
  .setName('logovotes')
  .setDescription('(Mod) Tally logo-competition votes and show the top entries.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((o) =>
    o
      .setName('channel')
      .setDescription('Competition channel (defaults to LOGO_COMPETITION_CHANNEL_ID).')
      .addChannelTypes(
        ChannelType.GuildForum,
        ChannelType.GuildMedia,
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
      ),
  )
  .addStringOption((o) =>
    o.setName('emoji').setDescription('Vote emoji name or id (default: logocomp).'),
  )
  .addStringOption((o) =>
    o
      .setName('voters')
      .setDescription('Whose votes count (default: everyone except the entry owner).')
      .addChoices(
        { name: "Everyone except the entry's own owner", value: VoterScope.EXCLUDE_SELF },
        { name: 'Only non-contestants (exclude all entrants)', value: VoterScope.NON_CONTESTANTS },
        { name: 'Everyone (count all votes)', value: VoterScope.ALL },
      ),
  )
  .addIntegerOption((o) =>
    o
      .setName('top')
      .setDescription('How many entries to show (default 10, max 25).')
      .setMinValue(1)
      .setMaxValue(25),
  );

export async function execute(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({ content: 'This command is mods only.', ephemeral: true });
    return;
  }

  const channelOpt = interaction.options.getChannel('channel');
  const channelId = channelOpt?.id || config.logoCompetitionChannelId;
  const emojiRaw = interaction.options.getString('emoji') || config.logoVoteEmoji || 'logocomp';
  const voterScope = interaction.options.getString('voters') || VoterScope.EXCLUDE_SELF;
  const top = interaction.options.getInteger('top') || 10;

  if (!channelId) {
    await interaction.reply({
      content:
        'Pick a channel, or set `LOGO_COMPETITION_CHANNEL_ID`.\n' +
        'Example: `/logovotes channel:#logo-competition`.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Resolve the channel (the option is already a channel; otherwise fetch the configured id).
  let channel = channelOpt;
  if (!channel) {
    try {
      channel = await interaction.client.channels.fetch(channelId);
    } catch {
      channel = null;
    }
  }

  const textLike =
    channel &&
    (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement);
  if (!channel || (!isThreadedChannel(channel) && !textLike)) {
    await interaction.editReply(
      `I can't read <#${channelId}> as a competition channel. Point me at the forum/media ` +
        'channel where each logo is its own post, or a text channel where each logo is a message.',
    );
    return;
  }

  const emojiSpec = parseEmojiSpec(emojiRaw);
  if (!emojiSpec) {
    await interaction.editReply('That vote emoji looks empty — try `emoji:logocomp`.');
    return;
  }

  const { entries, totals } = await tallyLogoVotes({ channel, emojiSpec, voterScope });

  if (entries.length === 0) {
    await interaction.editReply(
      `No entries found in <#${channelId}>. ` +
        (isThreadedChannel(channel)
          ? 'Are the logos posted as threads in that forum?'
          : `Are people voting with ${emojiLabel(emojiSpec)} on the logo messages?`),
    );
    return;
  }

  // Keep any entries tied with the last shown one, so a boundary tie is never hidden.
  const shown = sliceKeepingTies(entries, top);
  const withVotes = shown.filter((e) => e.votes > 0);

  const lines = (withVotes.length ? withVotes : shown).map((entry) => {
    const tie = entries.filter((e) => e.rank === entry.rank).length > 1;
    const pos = entry.rank <= MEDALS.length && !tie ? MEDALS[entry.rank - 1] : `**${tie ? 'T' : ''}${entry.rank}.**`;
    const votes = entry.votes === 1 ? '1 vote' : `${entry.votes} votes`;
    const owner = entry.ownerId ? ` · by <@${entry.ownerId}>` : '';
    return `${pos} ${entry.link} — **${votes}**${owner}`;
  });

  const zeroCount = entries.length - entries.filter((e) => e.votes > 0).length;
  const footerBits = [];
  if (zeroCount > 0) footerBits.push(`${zeroCount} entr${zeroCount === 1 ? 'y' : 'ies'} with 0 counted votes`);
  if (voterScope !== VoterScope.ALL && totals.ownerSelfVotes > 0) {
    footerBits.push(`${totals.ownerSelfVotes} owner self-vote${totals.ownerSelfVotes === 1 ? '' : 's'} not counted`);
  }
  if (totals.truncated) footerBits.push('scan limit reached — some older messages skipped');

  const header = [
    `Channel: <#${channelId}> · Vote: ${emojiLabel(emojiSpec)}`,
    `Counting: ${SCOPE_LABEL[voterScope]}`,
    `${totals.entryCount} entr${totals.entryCount === 1 ? 'y' : 'ies'} · ${totals.totalCounted} vote${totals.totalCounted === 1 ? '' : 's'} counted`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x39ff14)
    .setTitle('🏆 Logo Competition — Vote Tally')
    .setDescription([header, '', ...lines].join('\n'));

  if (footerBits.length) embed.setFooter({ text: footerBits.join(' · ') });

  await interaction.editReply({ embeds: [embed] });
}

// Cut to `limit`, then keep going while the next entry is tied with the last one kept.
function sliceKeepingTies(entries, limit) {
  if (limit == null || entries.length <= limit) return entries;
  let end = limit;
  const boundary = entries[limit - 1].votes;
  while (end < entries.length && entries[end].votes === boundary) end += 1;
  return entries.slice(0, end);
}
