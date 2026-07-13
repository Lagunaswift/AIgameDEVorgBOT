import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLeaderboard } from '../services/leaderboard.js';
import { isoWeek } from '../lib/week.js';

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Show the feedback points leaderboard.')
  .addStringOption((opt) =>
    opt
      .setName('scope')
      .setDescription('Time scope (default: this week)')
      .addChoices(
        { name: 'This week', value: 'week' },
        { name: 'All time', value: 'all' },
      ),
  );

export async function execute(interaction) {
  const scope = interaction.options.getString('scope') || 'week';
  await interaction.deferReply({ ephemeral: true });

  const board = await getLeaderboard({ scope, limit: 10 });

  const title =
    scope === 'week' ? `Feedback Leaderboard — ${isoWeek()}` : 'Feedback Leaderboard — All time';

  const embed = new EmbedBuilder()
    .setColor(0x39FF14)
    .setFooter({ text: '▸ SHOWCASE BOT ◂' });

  if (board.length === 0) {
    embed.setDescription(
      `<:ShowcaseBotReact:1521124760220729445> **${title}**\n\nNo points yet — go leave some feedback!`,
    );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const lines = board.map((entry, i) => {
    const name = entry.commenterTag || `<@${entry.commenterId}>`;
    const pts = entry.points === 1 ? '1 pt' : `${entry.points} pts`;
    return `<:helpfulfeedback:1521124800204898386> **${i + 1}.** ${name} — **${pts}**`;
  });

  embed.setDescription(
    `<:ShowcaseBotReact:1521124760220729445> **${title}**\n\n${lines.join('\n')}`,
  );

  await interaction.editReply({ embeds: [embed] });
}
