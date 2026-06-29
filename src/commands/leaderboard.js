// /leaderboard [scope] — top 10 commenters by points. scope = week (default) or all.

import { SlashCommandBuilder } from 'discord.js';
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

  const heading =
    scope === 'week' ? `🏆 Feedback Leaderboard — ${isoWeek()}` : '🏆 Feedback Leaderboard — All time';

  if (board.length === 0) {
    await interaction.editReply(`${heading}\n\nNo points yet. Go leave some helpful feedback!`);
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = board.map((entry, i) => {
    const rank = medals[i] || `**${i + 1}.**`;
    const name = entry.commenterTag || `<@${entry.commenterId}>`;
    const pts = entry.points === 1 ? '1 point' : `${entry.points} points`;
    return `${rank} ${name} — ${pts}`;
  });

  await interaction.editReply(`${heading}\n\n${lines.join('\n')}`);
}
