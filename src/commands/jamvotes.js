// /jamvotes (mod only) - tally jam-entry votes and show the standings.
//
// Jam entries are showcase posts carrying the jam's forum tag. Members vote by reacting
// to an entry's starter message with the jam vote emoji (JAM_VOTE_EMOJI, falling back to
// the logo-competition emoji). This command filters the showcase forum's threads down to
// the given jam tag, counts DISTINCT non-bot voters per entry via the shared logo-votes
// tally (no owner self-votes by default), and shows a ranked, mod-only standings embed.
// The mod then applies the 1st/2nd/3rd placement tags to the winners, which is what
// lights up the medals on the website.

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

// Normalise a tag or jam name for matching: lowercase, alphanumerics joined by dashes.
// "One-Verb Jam" and a forum tag named "one-verb-jam" (or "One Verb Jam") all coincide.
function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const data = new SlashCommandBuilder()
  .setName('jamvotes')
  .setDescription('(Mod) Tally votes for a jam by its tag and show the standings.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((o) =>
    o
      .setName('tag')
      .setDescription('The jam tag on the showcase forum (e.g. one-verb-jam).')
      .setRequired(true),
  )
  .addChannelOption((o) =>
    o
      .setName('channel')
      .setDescription('Showcase forum holding the entries (defaults to the watched forum).')
      .addChannelTypes(ChannelType.GuildForum, ChannelType.GuildMedia),
  )
  .addStringOption((o) =>
    o.setName('emoji').setDescription('Vote emoji name or id (default: JAM_VOTE_EMOJI).'),
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

  const tagRaw = interaction.options.getString('tag');
  const channelOpt = interaction.options.getChannel('channel');
  const channelId =
    channelOpt?.id || config.jamSubmissionsForumId || config.watchedShowcaseForumIds[0] || null;
  const emojiRaw =
    interaction.options.getString('emoji') || config.jamVoteEmoji || config.logoVoteEmoji;
  const voterScope = interaction.options.getString('voters') || VoterScope.EXCLUDE_SELF;
  const top = interaction.options.getInteger('top') || 10;

  if (!channelId) {
    await interaction.reply({
      content:
        'Pick a channel, or configure `WATCHED_SHOWCASE_FORUM_IDS`.\n' +
        'Example: `/jamvotes tag:one-verb-jam channel:#looking-for-feedback`.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Always fetch fresh by id: an interaction-resolved channel option is a partial
  // payload without available_tags, so relying on it can misreport "no tags".
  let channel = null;
  try {
    channel = await interaction.client.channels.fetch(channelId, { force: true });
  } catch {
    channel = null;
  }

  if (!channel || !isThreadedChannel(channel)) {
    await interaction.editReply(
      `I can't read <#${channelId}> as a forum. Point me at the showcase forum where each ` +
        'jam entry is its own post.',
    );
    return;
  }

  // Resolve the jam tag. Literal name match wins first (so pasting a tag's exact name,
  // emoji included, is always unambiguous), then slug-insensitive exact, then contains.
  // An input that slugifies to nothing (whitespace/punctuation only) matches nothing,
  // never everything.
  const availableTags = channel.availableTags || [];
  const wantedLiteral = String(tagRaw || '').trim().toLowerCase();
  const wantedSlug = slugify(tagRaw);

  let matches = availableTags.filter((t) => t.name.trim().toLowerCase() === wantedLiteral);
  if (!matches.length && wantedSlug) {
    const exact = availableTags.filter((t) => slugify(t.name) === wantedSlug);
    matches = exact.length
      ? exact
      : availableTags.filter((t) => slugify(t.name).includes(wantedSlug));
  }

  if (matches.length === 0) {
    const names = availableTags.map((t) => `\`${t.name}\``).join(', ') || '(none)';
    await interaction.editReply(
      `No tag matching \`${tagRaw}\` on <#${channelId}>. Tags there: ${names}`,
    );
    return;
  }
  if (matches.length > 1) {
    await interaction.editReply(
      `\`${tagRaw}\` matches more than one tag: ${matches.map((t) => `\`${t.name}\``).join(', ')}. ` +
        'Paste the exact tag name (emoji included) to disambiguate.',
    );
    return;
  }

  const jamTag = matches[0];

  const emojiSpec = parseEmojiSpec(emojiRaw);
  if (!emojiSpec) {
    await interaction.editReply(
      'No vote emoji configured. Pass `emoji:` or set `JAM_VOTE_EMOJI` in the env.',
    );
    return;
  }

  const { entries, totals } = await tallyLogoVotes({
    channel,
    emojiSpec,
    voterScope,
    threadFilter: (thread) =>
      Array.isArray(thread.appliedTags) && thread.appliedTags.includes(jamTag.id),
  });

  if (entries.length === 0) {
    await interaction.editReply(
      `No entries tagged \`${jamTag.name}\` found in <#${channelId}>. ` +
        'Are the jam entries posted there with the jam tag applied?',
    );
    return;
  }

  const shown = sliceKeepingTies(entries, top);
  const withVotes = shown.filter((e) => e.votes > 0);

  const lines = (withVotes.length ? withVotes : shown).map((entry) => {
    const tie = entries.filter((e) => e.rank === entry.rank).length > 1;
    const pos =
      entry.rank <= MEDALS.length && !tie ? MEDALS[entry.rank - 1] : `**${tie ? 'T' : ''}${entry.rank}.**`;
    const votes = entry.votes === 1 ? '1 vote' : `${entry.votes} votes`;
    const owner = entry.ownerId ? ` · by <@${entry.ownerId}>` : '';
    return `${pos} ${entry.link} - **${votes}**${owner}`;
  });

  const zeroCount = entries.length - entries.filter((e) => e.votes > 0).length;
  const footerBits = [];
  if (zeroCount > 0) footerBits.push(`${zeroCount} entr${zeroCount === 1 ? 'y' : 'ies'} with 0 counted votes`);
  if (voterScope !== VoterScope.ALL && totals.ownerSelfVotes > 0) {
    footerBits.push(`${totals.ownerSelfVotes} owner self-vote${totals.ownerSelfVotes === 1 ? '' : 's'} not counted`);
  }
  footerBits.push('Apply the 1st/2nd/3rd place tags to the winners to show medals on the site');

  const header = [
    `Jam tag: \`${jamTag.name}\` · Forum: <#${channelId}> · Vote: ${emojiLabel(emojiSpec)}`,
    `Counting: ${SCOPE_LABEL[voterScope]}`,
    `${totals.entryCount} entr${totals.entryCount === 1 ? 'y' : 'ies'} · ${totals.totalCounted} vote${totals.totalCounted === 1 ? '' : 's'} counted`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(0xd95d1e)
    .setTitle(`🏆 Jam Vote Tally - ${jamTag.name}`)
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
