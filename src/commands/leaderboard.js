// /leaderboard — the private, ranked view.
//
// Always ephemeral: the public weekly post is a flat thank-you roll with no scores, and
// this is where the real figures live. Mods use it to decide who to thank personally, so
// tied scores must show as tied rather than being ordered arbitrarily.

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLeaderboard, rankBoard, isTiedRank, displayName } from '../services/leaderboard.js';
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
;

  if (board.length === 0) {
    embed.setDescription(
      `<:ShowcaseBotReact:1521124760220729445> **${title}**\n\nNo points yet — go leave some feedback!`,
    );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const ranked = rankBoard(board);

  const lines = ranked.map((entry) => {
    const pts = entry.points === 1 ? '1 pt' : `${entry.points} pts`;
    // "T1." marks a shared position so nobody gets congratulated for a tie they didn't win.
    const pos = isTiedRank(ranked, entry.rank) ? `T${entry.rank}.` : `${entry.rank}.`;
    return `<:helpfulfeedback:1521124800204898386> **${pos}** ${displayName(entry)} — **${pts}**`;
  });

  embed.setDescription(
    `<:ShowcaseBotReact:1521124760220729445> **${title}**\n\n${lines.join('\n')}`,
  );

  await interaction.editReply({ embeds: [embed] });
}
