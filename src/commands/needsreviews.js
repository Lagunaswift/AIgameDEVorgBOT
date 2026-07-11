import { SlashCommandBuilder } from 'discord.js';
import { listThreadsByMode } from '../services/threads.js';
import { getEffectiveConfig } from '../services/config.js';

export const data = new SlashCommandBuilder()
  .setName('needsreviews')
  .setDescription('Show showcase posts that need feedback (fewest comments first).');

function hasExcludedTag(channel, excludedNames) {
  if (!excludedNames.length) return false;
  if (!channel.appliedTags?.length) return false;

  const parent = channel.parent;
  if (!parent?.availableTags) return false;

  const excludedIds = parent.availableTags
    .filter((t) => excludedNames.includes(t.name.toLowerCase()))
    .map((t) => t.id);

  return channel.appliedTags.some((id) => excludedIds.includes(id));
}

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const cfg = await getEffectiveConfig();
  const excludedNames = (cfg.excludedTagNames || []).map((n) => n.toLowerCase());

  const threads = await listThreadsByMode('showcase');
  if (threads.length === 0) {
    await interaction.editReply('No registered showcase threads yet.');
    return;
  }

  const withCounts = [];
  for (const t of threads) {
    try {
      const channel = await interaction.client.channels.fetch(t.threadId);
      if (!channel) continue;

      if (hasExcludedTag(channel, excludedNames)) continue;

      const total = channel.messageCount ?? channel.totalMessageSent ?? 0;
      const comments = Math.max(0, total - 1);
      withCounts.push({ ...t, comments });
    } catch {
      // Thread deleted or inaccessible; skip it.
    }
  }

  if (withCounts.length === 0) {
    await interaction.editReply('No accessible showcase threads need reviews right now.');
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
