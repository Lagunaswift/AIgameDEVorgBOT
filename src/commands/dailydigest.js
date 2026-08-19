// /dailydigest [action] [window] — (Mod) preview or post Floppy's daily digest on demand.
// Preview renders the message ephemerally: the template parts are exactly what the cron
// would post (same seed); the chat recap is generated fresh per render, so its wording can
// differ between preview and post. Post sends it to the digest channel now: with the
// default "latest" window this is the recovery path for a failed scheduled post (it
// re-posts the completed 24h window and marks the day); with "live" it posts what's
// happened since the last digest as a bonus, without touching the daily cadence.

import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { isMod } from '../lib/permissions.js';
import { prepareDigest, runDailyDigest } from '../services/dailyDigest.js';
import { chatSummaryConfigured } from '../services/chatSummary.js';

export const data = new SlashCommandBuilder()
  .setName('dailydigest')
  .setDescription("(Mod) Preview or post Floppy's daily digest now.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((o) =>
    o
      .setName('action')
      .setDescription('Preview privately (default) or post to the digest channel')
      .addChoices(
        { name: 'Preview (only you see it)', value: 'preview' },
        { name: 'Post to the digest channel', value: 'post' },
      ),
  )
  .addStringOption((o) =>
    o
      .setName('window')
      .setDescription('Which day to cover (default: latest, matching the automated post)')
      .addChoices(
        { name: 'Latest completed day (automated default)', value: 'latest' },
        { name: 'Live: since the last digest', value: 'live' },
      ),
  );

export async function execute(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({ content: 'This command is mods only.', ephemeral: true });
    return;
  }

  const action = interaction.options.getString('action') || 'preview';
  const live = (interaction.options.getString('window') || 'latest') === 'live';

  await interaction.deferReply({ ephemeral: true });

  if (action === 'preview') {
    let prepared;
    try {
      prepared = await prepareDigest({ client: interaction.client, live });
    } catch (err) {
      await interaction.editReply(`⚠️ Could not gather the day: ${err.message}`);
      return;
    }

    const where = prepared.cfg.dailyDigestChannelId
      ? `<#${prepared.cfg.dailyDigestChannelId}>`
      : '**no channel configured** (set `DAILY_DIGEST_CHANNEL_ID`)';
    const notes = [];
    if (!chatSummaryConfigured()) {
      notes.push('Chat recap is off (no `ANTHROPIC_API_KEY`), so this is the template-only version.');
    }
    if (prepared.quiet && prepared.cfg.dailyDigestSkipQuiet) {
      notes.push('Quiet day + skip-quiet is on, so the cron would post nothing.');
    }
    const note = notes.length ? ` ${notes.join(' ')}` : '';

    await interaction.editReply({
      content: `Would post to ${where}.${note}\n\n${prepared.content}`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  // Explicit on-demand post. "latest" forces past the per-day marker (recovery); "live"
  // never marks, so tonight's scheduled digest still goes out.
  const res = await runDailyDigest(interaction.client, {
    trigger: 'manual',
    force: true,
    live,
  });

  switch (res.status) {
    case 'posted':
      await interaction.editReply(
        `✅ Posted the digest${live ? ' (live window)' : ` for **${res.dateStr}**`} via ${res.via === 'webhook' ? 'the Floppy webhook' : 'the bot (no Manage Webhooks — no floppy avatar)'}.`,
      );
      break;
    case 'no-config':
      await interaction.editReply(
        '⚠️ No digest channel is configured. Set `DAILY_DIGEST_CHANNEL_ID` (or `dailyDigestChannelId` in the config doc).',
      );
      break;
    case 'quiet-skipped':
      await interaction.editReply(
        '💤 Nothing happened in that window and skip-quiet is on, so nothing was posted.',
      );
      break;
    case 'fetch-failed':
      await interaction.editReply(
        `⚠️ Could not fetch the digest channel: ${res.error}. Check the channel id and that the bot can see it.`,
      );
      break;
    case 'not-text':
      await interaction.editReply('⚠️ The configured digest channel is not a text channel.');
      break;
    case 'gather-failed':
      await interaction.editReply(`⚠️ Could not gather the day: ${res.error}`);
      break;
    case 'send-failed':
      await interaction.editReply(
        `❌ Could not post to the digest channel: **${res.error}**.\n` +
          'Grant the bot **View Channel** and **Send Messages** there (plus **Manage Webhooks** for the floppy avatar), then try again.',
      );
      break;
    default:
      await interaction.editReply(`⚠️ Digest was not posted (${res.status}).`);
  }
}
