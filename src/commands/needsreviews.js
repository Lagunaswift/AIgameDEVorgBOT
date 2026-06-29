// /needsreviews — registered showcase threads with the fewest comments, so reviewers
// know where to go. Directly attacks the empty-showcase problem by surfacing the posts
// nobody has reviewed yet.

import { SlashCommandBuilder } from 'discord.js';
import { listThreadsByMode } from '../services/threads.js';

export const data = new SlashCommandBuilder()
  .setName('needsreviews')
  .setDescription('Show showcase posts that need feedback (fewest comments first).');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const threads = await listThreadsByMode('showcase');
  if (threads.length === 0) {
    await interaction.editReply('No registered showcase threads yet.');
    return;
  }

  // Resolve live comment counts. In a forum thread, the first message is the post body,
  // so comments = messageCount - 1 (clamped at 0). Threads that 404 (deleted) are skipped.
  const withCounts = [];
  for (const t of threads) {
    try {
      const channel = await interaction.client.channels.fetch(t.threadId);
      if (!channel) continue;
      const total = channel.messageCount ?? channel.totalMessageSent ?? 0;
      const comments = Math.max(0, total - 1);
      withCounts.push({ ...t, comments });
    } catch {
      // Thread deleted or inaccessible; skip it.
    }
  }

  if (withCounts.length === 0) {
    await interaction.editReply('No accessible showcase threads to review right now.');
    return;
  }

  withCounts.sort((a, b) => a.comments - b.comments);
  const top = withCounts.slice(0, 10);

  const lines = top.map((t) => {
    const label = t.comments === 0 ? '**0 comments — needs a first look!**' : `${t.comments} comments`;
    return `• <#${t.threadId}> — ${label}`;
  });

  await interaction.editReply(
    ['🔍 **Showcase posts that need reviews**', '', ...lines].join('\n'),
  );
}
