// /mystats — feedback totals, weekly count and weekly rank.
//
// Defaults to the caller. Mods can pass `user:` to look someone else up, which is the
// companion to the private /leaderboard view: check what a person has actually earned
// before sending them a personal thank-you.

import { SlashCommandBuilder } from 'discord.js';
import { getUserStats } from '../services/leaderboard.js';
import { isMod } from '../lib/permissions.js';
import { isoWeek } from '../lib/week.js';

export const data = new SlashCommandBuilder()
  .setName('mystats')
  .setDescription('Show feedback points: total, this week, and rank.')
  .addUserOption((o) =>
    o.setName('user').setDescription('(Mod) Look up another member instead of yourself'),
  );

export async function execute(interaction) {
  const requested = interaction.options.getUser('user');

  // Gate the lookup, not the command: anyone may check themselves.
  if (requested && requested.id !== interaction.user.id && !isMod(interaction)) {
    await interaction.reply({
      content: 'Looking up other members is mods only.',
      ephemeral: true,
    });
    return;
  }

  const target = requested || interaction.user;
  const self = target.id === interaction.user.id;

  await interaction.deferReply({ ephemeral: true });

  const stats = await getUserStats(target.id);

  // A shared rank is reported as such — "#1 of 3" when all three are level would read as
  // an outright win to whoever is deciding who to thank.
  const rankLine =
    stats.rank == null
      ? `No points yet this week.`
      : `Rank this week: **#${stats.rank}** of ${stats.totalRanked}${stats.tied ? ' _(tied)_' : ''}`;

  await interaction.editReply(
    [
      self
        ? `📊 **Your feedback stats** — ${isoWeek()}`
        : `📊 **Feedback stats for ${target.tag}** — ${isoWeek()}`,
      ``,
      `This week: **${stats.weekly}**`,
      `All time: **${stats.total}**`,
      rankLine,
    ].join('\n'),
  );
}
