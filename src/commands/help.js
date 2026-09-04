import { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';

const COMMUNITY_COMMANDS = [
  ['`/mystats`', 'See your feedback points, weekly count, and rank.'],
  ['`/leaderboard`', 'View the feedback leaderboard (weekly or all-time).'],
  ['`/needsreviews`', 'Find showcase posts that need more feedback.'],
  ['`/projecturl`', 'Owner: save playable URL metadata on the current registered thread; it does not publish.'],
  ['`/posttemplate`', 'Get a copyable template for build-help, playtest, or update posts.'],
  ['`/gameidea`', 'Byte generates a random game idea. Comical, occasionally good.'],
  ['`/help`', 'This command. Shows what every command does.'],
];

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0xd95d1e)
    .setTitle('Byte — Command Reference')
    .setDescription('Everything the bot can do, and when to use it.')
    .addFields({
      name: 'Commands',
      value: COMMUNITY_COMMANDS.map(([cmd, desc]) => `${cmd} — ${desc}`).join('\n'),
    })
    .setFooter({ text: 'Use any command in any channel.' });
}

const helpCommand = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Shows available bot commands and what they do.'),
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
    .setDescription('(Mod) Post and pin the command reference in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let msg;
    try {
      msg = await interaction.channel.send({ embeds: [buildHelpEmbed()] });
    } catch (err) {
      return interaction.editReply(`Could not send to this channel — the bot may be missing Send Messages or Embed Links permission here. (${err.message})`);
    }

    try {
      await msg.pin();
    } catch (err) {
      console.warn(`[help] could not pin help message: ${err.message}`);
    }

    await interaction.editReply('Help card posted and pinned.');
  },
};

export const commands = [helpCommand, postHelpCommand];
