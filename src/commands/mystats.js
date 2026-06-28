// /mystats — the caller's total points, weekly points, and weekly rank.

import { SlashCommandBuilder } from 'discord.js';
import { getUserStats } from '../services/leaderboard.js';
import { isoWeek } from '../lib/week.js';

export const data = new SlashCommandBuilder()
  .setName('mystats')
  .setDescription('Show your feedback points: total, this week, and rank.');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const stats = await getUserStats(interaction.user.id);

  const rankLine =
    stats.rank == null
      ? 'No points yet this week.'
      : `Rank this week: **#${stats.rank}** of ${stats.totalRanked}`;

  await interaction.editReply(
    [
      `📊 **Your feedback stats** — ${isoWeek()}`,
      ``,
      `This week: **${stats.weekly}**`,
      `All time: **${stats.total}**`,
      rankLine,
    ].join('\n'),
  );
}
