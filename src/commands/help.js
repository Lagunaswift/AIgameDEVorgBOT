import { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';

const COMMUNITY_COMMANDS = [
  ['`/mystats`', 'See your feedback points, weekly count, and rank.'],
  ['`/leaderboard`', 'View the feedback leaderboard (weekly or all-time).'],
  ['`/needsreviews`', 'Find showcase posts that need more feedback.'],
  ['`/mygame publish`', 'Owner: request publication for this moderator-approved game thread.'],
  ['`/projecturl`', 'Owner: save the playable URL for this thread. It does not publish a Project page.'],
  ['`/posttemplate`', 'Get a copyable template for build-help, playtest, or update posts.'],
  ['`/gameidea`', 'Ask Byte for a random game idea.'],
  ['`/help`', 'Show this command list.'],
];

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0xd95d1e)
    .setTitle('Byte: command reference')
    .setDescription('Commands and what they do.')
    .addFields({
      name: 'Commands',
      value: COMMUNITY_COMMANDS.map(([cmd, desc]) => `${cmd}: ${desc}`).join('\n'),
    })
    .setFooter({ text: 'Owner commands must be run inside your registered thread.' });
}

const helpCommand = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show available bot commands.'),
  async execute(interaction) {
    await interaction.reply({
      embeds: [buildHelpEmbed()],
      flags: MessageFlags.Ephemeral,
    });
  },
};

const postHelpCommand = {
  data: new SlashCommandBuilder()
    .setName('posthelp')
    .setDescription('(Mod) Post and pin the command reference here.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let msg;
    try {
      msg = await interaction.channel.send({ embeds: [buildHelpEmbed()] });
    } catch (err) {
      return interaction.editReply(`Could not send to this channel. The bot may be missing Send Messages or Embed Links permission here. (${err.message})`);
    }

    try {
      await msg.pin();
    } catch (err) {
      console.warn(`[help] could not pin help message: ${err.message}`);
    }

    await interaction.editReply('Help card posted. Check the channel pins.');
  },
};

export const commands = [helpCommand, postHelpCommand];
