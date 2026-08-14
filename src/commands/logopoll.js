// /logopoll — narrow the field by reaction tally, then post a native Discord poll of the
// finalists so the winner is chosen one-vote-per-account.
//
// A Discord poll caps at 10 options and can't hold images, so this shortlists the top
// entries by :logocomp: reactions (reusing the /logovotes tally), then posts a single-select
// poll whose options are numbered to match a legend of links to each finalist's post. The
// poll is public (people vote on it); the command's own reply is an ephemeral confirmation.

import { SlashCommandBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { isMod } from '../lib/permissions.js';
import { config } from '../config.js';
import {
  tallyLogoVotes,
  parseEmojiSpec,
  isThreadedChannel,
  buildFinalistPoll,
  clampPollHours,
  VoterScope,
  POLL_MAX_ANSWERS,
} from '../services/logoVotes.js';

export const data = new SlashCommandBuilder()
  .setName('logopoll')
  .setDescription('(Mod) Post a native Discord poll of the top logo finalists.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((o) =>
    o
      .setName('channel')
      .setDescription('Competition channel to read entries from (defaults to configured).')
      .addChannelTypes(
        ChannelType.GuildForum,
        ChannelType.GuildMedia,
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
      ),
  )
  .addChannelOption((o) =>
    o
      .setName('post_to')
      .setDescription('Where to post the poll (defaults to this channel).')
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ),
  )
  .addIntegerOption((o) =>
    o
      .setName('finalists')
      .setDescription(`How many top entries to put on the poll (2–${POLL_MAX_ANSWERS}, default ${POLL_MAX_ANSWERS}).`)
      .setMinValue(2)
      .setMaxValue(POLL_MAX_ANSWERS),
  )
  .addIntegerOption((o) =>
    o
      .setName('hours')
      .setDescription('How long the poll stays open, in hours (1–768, default 24).')
      .setMinValue(1)
      .setMaxValue(768),
  )
  .addStringOption((o) =>
    o.setName('question').setDescription('Poll question (default: "Which logo should win?").'),
  )
  .addStringOption((o) =>
    o.setName('emoji').setDescription('Vote emoji used to shortlist (default: logocomp).'),
  )
  .addStringOption((o) =>
    o
      .setName('voters')
      .setDescription('Whose reactions decide the shortlist (default: everyone except the entry owner).')
      .addChoices(
        { name: "Everyone except the entry's own owner", value: VoterScope.EXCLUDE_SELF },
        { name: 'Only non-contestants (exclude all entrants)', value: VoterScope.NON_CONTESTANTS },
        { name: 'Everyone (count all votes)', value: VoterScope.ALL },
      ),
  );

export async function execute(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({ content: 'This command is mods only.', ephemeral: true });
    return;
  }

  const channelOpt = interaction.options.getChannel('channel');
  const channelId = channelOpt?.id || config.logoCompetitionChannelId;
  const postTo = interaction.options.getChannel('post_to') || interaction.channel;
  const finalists = interaction.options.getInteger('finalists') || POLL_MAX_ANSWERS;
  const hours = clampPollHours(interaction.options.getInteger('hours') ?? 24);
  const question = interaction.options.getString('question') || 'Which logo should win?';
  const emojiRaw = interaction.options.getString('emoji') || config.logoVoteEmoji;
  const voterScope = interaction.options.getString('voters') || VoterScope.EXCLUDE_SELF;

  if (!channelId) {
    await interaction.reply({
      content:
        'Pick a `channel`, or set `LOGO_COMPETITION_CHANNEL_ID`.\n' +
        'Example: `/logopoll channel:#logo-competition`.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Where the poll will be posted must be a channel the bot can send to.
  if (!postTo || typeof postTo.send !== 'function') {
    await interaction.editReply(
      'I can\'t post a poll here. Run the command in a normal text channel, or pass `post_to:#a-channel`.',
    );
    return;
  }

  // Resolve the competition channel to read entries from.
  let source = channelOpt;
  if (!source) {
    try {
      source = await interaction.client.channels.fetch(channelId);
    } catch {
      source = null;
    }
  }
  const textLike =
    source &&
    (source.type === ChannelType.GuildText || source.type === ChannelType.GuildAnnouncement);
  if (!source || (!isThreadedChannel(source) && !textLike)) {
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

  // Tally reactions and shortlist the finalists.
  const { entries } = await tallyLogoVotes({ channel: source, emojiSpec, voterScope });
  const poll = buildFinalistPoll({ entries, finalists, question });

  if (poll.answers.length < 2) {
    await interaction.editReply(
      `Not enough entries with votes to shortlist (found ${poll.answers.length}). ` +
        'Let people react with the vote emoji first, then run this again — or run ' +
        '`/logovotes` to see the current tally.',
    );
    return;
  }

  // Compose the message: a numbered legend linking each option to its post, then the poll.
  const closing = hours === 1 ? '1 hour' : hours % 24 === 0 && hours >= 24 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hours`;
  const content = [
    '🏆 **Logo Competition — Final Vote**',
    `The top ${poll.answers.length} by reactions are below. One vote each — the poll closes in **${closing}**.`,
    '',
    ...poll.legend,
  ].join('\n');

  let message;
  try {
    message = await postTo.send({
      content,
      // Render owner mentions as names without pinging everyone on the finalist list.
      allowedMentions: { parse: [] },
      poll: {
        question: { text: poll.question },
        answers: poll.answers,
        duration: hours,
        allowMultiselect: false,
      },
    });
  } catch (err) {
    await interaction.editReply(
      `Couldn't post the poll to <#${postTo.id}>: ${err.message}\n` +
        'Check I have **View Channel** and **Send Messages** there (and **Send Messages in Threads** if it\'s a thread).',
    );
    return;
  }

  const notes = [];
  if (poll.droppedTie > 0) {
    notes.push(
      `⚠️ ${poll.droppedTie} entr${poll.droppedTie === 1 ? 'y was' : 'ies were'} tied with the last finalist ` +
        `but left off — a poll can only hold ${POLL_MAX_ANSWERS} options. Raise the bar with more reactions, or split into rounds.`,
    );
  }
  notes.push(
    'ℹ️ Only I can end this poll early (Discord rule for bot-made polls); otherwise it closes itself at the deadline.',
  );

  await interaction.editReply(
    [`✅ Poll posted: ${message.url}`, `Finalists: **${poll.answers.length}** · Closes in **${closing}**`, '', ...notes].join('\n'),
  );
}
