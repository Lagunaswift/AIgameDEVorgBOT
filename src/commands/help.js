import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { isMod } from '../lib/permissions.js';

const COMMUNITY_COMMANDS = [
  ['`/mystats`', 'See your feedback points, weekly count, and rank.'],
  ['`/leaderboard`', 'View the feedback leaderboard (weekly or all-time).'],
  ['`/needsreviews`', 'Find showcase posts that need more feedback.'],
  ['`/projecturl`', 'Set the public play/test link on your showcase thread.'],
  ['`/posttemplate`', 'Get a copyable template for build-help, playtest, or update posts.'],
  ['`/gameidea`', 'Byte generates a random game idea. Comical, occasionally good.'],
  ['`/help`', 'This command. Shows what every command does.'],
];

const MOD_COMMANDS = [
  ['`/dailydigest`', 'Preview or post the daily digest on demand.'],
  ['`/nudgescreenshots`', 'Find showcase threads missing a screenshot.'],
  ['`/rescan`', 'Backfill thread data after downtime.'],
  ['`/postleaderboard`', 'Manually post the weekly leaderboard.'],
  ['`/points adjust`', 'Add or remove feedback points with an audit record.'],
  ['`/points reset`', "Zero a user's points and milestone markers."],
  ['`/registerforum`', 'Add a forum channel to the watch list.'],
  ['`/seedusers`', 'Pre-populate known users from recent activity.'],
  ['`/logopoll`', 'Post a poll of logo-competition finalists.'],
  ['`/logovotes`', 'Tally logo-competition reaction votes.'],
  ['`/jamvotes`', 'Tally votes for a jam by forum tag.'],
  ['`/assignjam`', 'Assign the current thread to a jam ID.'],
  ['`/communitynote nominate`', 'Community note curation checklist.'],
  ['`/posthelp`', 'Post and pin this help card in the current channel.'],
];

function buildHelpEmbed({ showMod = false } = {}) {
  const embed = new EmbedBuilder()
    .setColor(0xd95d1e)
    .setTitle('Byte — Command Reference')
    .setDescription('Everything the bot can do, and when to use it.')
    .addFields({
      name: 'Community',
      value: COMMUNITY_COMMANDS.map(([cmd, desc]) => `${cmd} — ${desc}`).join('\n'),
    });

  if (showMod) {
    embed.addFields({
      name: 'Mod-only',
      value: MOD_COMMANDS.map(([cmd, desc]) => `${cmd} — ${desc}`).join('\n'),
    });
  }

  embed.setFooter({ text: 'Use any community command anywhere. Mod commands require Manage Server or the mod role.' });
  return embed;
}

const helpCommand = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Shows available bot commands and what they do.'),
  async execute(interaction) {
    const showMod = isMod(interaction);
    await interaction.reply({
      embeds: [buildHelpEmbed({ showMod })],
      ephemeral: true,
    });
  },
};

const postHelpCommand = {
  data: new SlashCommandBuilder()
    .setName('posthelp')
    .setDescription('(Mod) Post and pin the command reference in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    if (!isMod(interaction)) {
      return interaction.reply({ content: 'Mod-only command.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const embed = buildHelpEmbed({ showMod: true });
    const msg = await interaction.channel.send({ embeds: [embed] });

    try {
      await msg.pin();
    } catch (err) {
      console.warn(`[help] could not pin help message: ${err.message}`);
    }

    await interaction.editReply('Help card posted and pinned.');
  },
};

export const commands = [helpCommand, postHelpCommand];
