// /nudgescreenshots (mod only): find showcase threads with no screenshot/GIF and send
// them the same friendly nudge the scheduled per-thread check would have sent, for
// threads that slipped through (bot downtime, disabled at post time, etc). Preview by
// default; pass apply:true to actually send. Shares the dedup collection with the
// scheduled check, so a thread is never nudged twice either way.

import { SlashCommandBuilder } from 'discord.js';
import { isMod } from '../lib/permissions.js';
import { getDb } from '../firebase.js';
import { listThreadsByMode } from '../services/threads.js';
import { threadHasScreenshot, sendScreenshotNudge } from '../services/screenshotNudge.js';

const MAX_NUDGES_PER_RUN = 100;
const SEND_DELAY_MS = 2000;
const PROGRESS_EVERY = 10;
const PREVIEW_TITLE_LIMIT = 25;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const data = new SlashCommandBuilder()
  .setName('nudgescreenshots')
  .setDescription('(Mod) Nudge showcase threads that have no screenshot.')
  .addBooleanOption((opt) =>
    opt
      .setName('apply')
      .setDescription('Actually send nudges. Default false (preview only).')
      .setRequired(false),
  )
  .addBooleanOption((opt) =>
    opt
      .setName('include_archived')
      .setDescription('Also check archived threads. Default false.')
      .setRequired(false),
  );

export async function execute(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({ content: 'This command is mods only.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const apply = interaction.options.getBoolean('apply') ?? false;
  const includeArchived = interaction.options.getBoolean('include_archived') ?? false;

  // Batch-read the dedup collection once, not per thread.
  const dedupSnap = await getDb().collection('screenshotNudges').get();
  const alreadyNudged = new Set(dedupSnap.docs.map((d) => d.id));

  const showcaseThreads = await listThreadsByMode('showcase');

  const missing = [];
  for (const doc of showcaseThreads) {
    if (alreadyNudged.has(doc.threadId)) continue;

    let thread;
    try {
      thread = await interaction.client.channels.fetch(doc.threadId);
    } catch {
      continue; // deleted
    }
    if (!thread) continue;
    if (thread.archived && !includeArchived) continue;

    let hasScreenshot;
    try {
      hasScreenshot = await threadHasScreenshot(thread);
    } catch (err) {
      console.error(`[nudgescreenshots] check failed for thread ${doc.threadId}:`, err.message);
      continue;
    }
    if (hasScreenshot) continue;

    missing.push({ threadId: doc.threadId, title: doc.title, ownerId: doc.ownerId, thread });
  }

  if (!apply) {
    const lines = [
      `Found **${missing.length}** showcase thread(s) without a screenshot` +
        (includeArchived ? '.' : ' (active only).'),
    ];
    if (missing.length > 0) {
      lines.push('');
      lines.push(missing.slice(0, PREVIEW_TITLE_LIMIT).map((m) => `- ${m.title}`).join('\n'));
      if (missing.length > PREVIEW_TITLE_LIMIT) {
        lines.push(`...and ${missing.length - PREVIEW_TITLE_LIMIT} more.`);
      }
      lines.push('');
      lines.push('Run again with `apply:true` to send nudges.');
    }
    await interaction.editReply(lines.join('\n'));
    return;
  }

  const toNudge = missing.slice(0, MAX_NUDGES_PER_RUN);
  let nudged = 0;
  let skipped = 0;
  let errored = 0;

  for (let i = 0; i < toNudge.length; i++) {
    const item = toNudge[i];
    try {
      const sent = await sendScreenshotNudge(item.thread, item.ownerId, { allowArchived: includeArchived });
      if (sent) nudged += 1;
      else skipped += 1;
    } catch (err) {
      errored += 1;
      console.error(`[nudgescreenshots] failed to nudge thread ${item.threadId}:`, err.message);
    }

    const done = i + 1;
    if (done % PROGRESS_EVERY === 0 && done < toNudge.length) {
      await interaction.editReply(
        `Progress: ${done}/${toNudge.length} processed (nudged ${nudged}, skipped ${skipped}, errored ${errored})...`,
      );
    }

    if (i < toNudge.length - 1) await sleep(SEND_DELAY_MS);
  }

  const remainder = missing.length - toNudge.length;
  await interaction.editReply(
    [
      '✅ **Nudge run complete**',
      `Nudged: ${nudged}`,
      `Skipped (already nudged): ${skipped}`,
      `Errored: ${errored}`,
      remainder > 0
        ? `Note: ${remainder} more thread(s) exceeded the ${MAX_NUDGES_PER_RUN}-per-run cap; run again to continue.`
        : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}
