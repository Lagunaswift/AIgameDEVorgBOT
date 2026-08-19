// /gameidea [theme] — everyone. Byte rolls a random ingredient collision and develops it
// into a game pitch (services/gameIdeas.js). Replies publicly: the fun is communal, and
// the seed footer shows the machinery. Throttled per user (cooldown; mods bypass) and per
// day (server-wide cap on API calls). With no API key it serves the raw mad-lib instead.

import { SlashCommandBuilder } from 'discord.js';
import { isMod } from '../lib/permissions.js';
import { parseDisplayEmoji } from '../lib/emoji.js';
import { getEffectiveConfig } from '../services/config.js';
import { cooldownRemaining, noteUse, generateIdea } from '../services/gameIdeas.js';

export const data = new SlashCommandBuilder()
  .setName('gameidea')
  .setDescription('Byte generates a game idea. Comical, occasionally accidentally good.')
  .addStringOption((o) =>
    o
      .setName('theme')
      .setDescription('Optional flavour to aim for (e.g. "horror", "cats", "co-op")')
      .setMaxLength(120),
  );

function formatWait(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export async function execute(interaction) {
  const cfg = await getEffectiveConfig();

  const wait = cooldownRemaining(interaction.user.id, cfg.gameIdeaCooldownSeconds);
  if (wait > 0 && !isMod(interaction)) {
    await interaction.reply({
      content: `Idea chip cooling down. Try again in ${formatWait(wait)}. I only have 1.44 megabytes, pace yourself.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();
  noteUse(interaction.user.id);

  const res = await generateIdea({
    theme: interaction.options.getString('theme'),
    model: cfg.gameIdeaModel,
    dailyCap: cfg.gameIdeaDailyCap,
  });

  if (res.status === 'capped') {
    await interaction.editReply(
      `Today's idea quota (${res.cap}) is spent. The drive refills at midnight UTC. Rationing, like the old days.`,
    );
    return;
  }

  // Byte signs his work: the configured :byte: emoji (or 💾) leads the footer.
  const byteTag = parseDisplayEmoji(cfg.byteEmoji).tag;
  const footer =
    res.status === 'madlib'
      ? `-# ${byteTag} seed: ${res.seedLabel} · raw ingredients — no API key configured`
      : `-# ${byteTag} seed: ${res.seedLabel} · idea #${res.number}`;

  await interaction.editReply({
    content: `${res.text}\n\n${footer}`,
    allowedMentions: { parse: [] },
  });
}
