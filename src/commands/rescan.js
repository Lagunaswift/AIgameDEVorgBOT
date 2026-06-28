// /rescan (mod only) — re-read recent threads in the watched forums and their reactions
// to backfill anything missed while the bot was offline. Discord does not replay
// downtime events, so this is the only recovery path. Idempotent (see services/rescan.js).

import { SlashCommandBuilder } from 'discord.js';
import { isMod } from '../lib/permissions.js';
import { rescanAll } from '../services/rescan.js';

export const data = new SlashCommandBuilder()
  .setName('rescan')
  .setDescription('(Mod) Backfill thread registration and showcase points from watched forums.');

export async function execute(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({ content: 'This command is mods only.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const summary = await rescanAll(interaction.client);

  await interaction.editReply(
    [
      '✅ **Rescan complete**',
      `Forums scanned: ${summary.forums}`,
      `Threads seen: ${summary.threadsSeen}`,
      `Newly registered: ${summary.threadsRegistered}`,
      `Points backfilled: ${summary.pointsAwarded}`,
    ].join('\n'),
  );
}
