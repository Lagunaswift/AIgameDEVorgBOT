// /postleaderboard [week] — (Mod) post the weekly feedback leaderboard to the leaderboard
// channel on demand. Handy for verifying the bot's channel permissions and for recovering
// a week whose automated Monday post failed. Gated by isMod() in the handler.

import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { isMod } from '../lib/permissions.js';
import { runWeeklyPost } from '../services/weeklyPost.js';
import { isoWeek, previousIsoWeek } from '../lib/week.js';

export const data = new SlashCommandBuilder()
  .setName('postleaderboard')
  .setDescription('(Mod) Post the weekly feedback leaderboard to the leaderboard channel now.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((o) =>
    o
      .setName('week')
      .setDescription('Which week to post (default: last week, matching the automated post)')
      .addChoices(
        { name: 'Last week (automated default)', value: 'previous' },
        { name: 'This week (in progress)', value: 'current' },
      ),
  );

export async function execute(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({ content: 'This command is mods only.', ephemeral: true });
    return;
  }

  const scope = interaction.options.getString('week') || 'previous';
  const week = scope === 'current' ? isoWeek() : previousIsoWeek();

  await interaction.deferReply({ ephemeral: true });

  // force: this is an explicit on-demand action, so post even if the week is already marked.
  const res = await runWeeklyPost(interaction.client, { trigger: 'manual', week, force: true });

  switch (res.status) {
    case 'posted':
      await interaction.editReply(
        `✅ Posted the leaderboard for **${week}** to the leaderboard channel (${res.count} on the board).`,
      );
      break;
    case 'no-config':
      await interaction.editReply(
        '⚠️ No leaderboard channel is configured. Set `LEADERBOARD_CHANNEL_ID` (or the config doc).',
      );
      break;
    case 'fetch-failed':
      await interaction.editReply(
        `⚠️ Could not fetch the leaderboard channel: ${res.error}. Check the channel id and that the bot can see it.`,
      );
      break;
    case 'not-text':
      await interaction.editReply(
        '⚠️ The configured leaderboard channel is not a text channel.',
      );
      break;
    case 'send-failed':
      await interaction.editReply(
        `❌ Could not post to the leaderboard channel: **${res.error}**.\n` +
          'Grant the bot **View Channel**, **Send Messages**, and **Use External Emojis** on that channel, then try again.',
      );
      break;
    default:
      await interaction.editReply(`⚠️ Leaderboard was not posted (${res.status}).`);
  }
}
