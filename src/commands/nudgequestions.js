import { SlashCommandBuilder } from 'discord.js';
import { isMod } from '../lib/permissions.js';
import { getDb } from '../firebase.js';
import { listThreadsByMode } from '../services/threads.js';
import {
  threadFollowsGuidelines,
  sendGuidelinesNudge,
  isGuidelinesExempt,
} from '../services/guidelinesNudge.js';

const MAX_NUDGES_PER_RUN = 100;
const SEND_DELAY_MS = 2000;
const PROGRESS_EVERY = 10;
const PREVIEW_TITLE_LIMIT = 25;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const data = new SlashCommandBuilder()
  .setName('nudgequestions')
  .setDescription('(Mod) Nudge threads missing specific questions per the guidelines.')
  .addBooleanOption((opt) =>
    opt
      .setName('scan')
      .setDescription('Scan all showcase threads instead of nudging this thread.')
      .setRequired(false),
  )
  .addBooleanOption((opt) =>
    opt
      .setName('apply')
      .setDescription('Actually send nudges (scan mode). Default false (preview only).')
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

  const scan = interaction.options.getBoolean('scan') ?? false;

  if (scan) {
    await handleScan(interaction);
  } else {
    await handleSingleThread(interaction);
  }
}

async function handleSingleThread(interaction) {
  const thread = interaction.channel;
  if (!thread || typeof thread.isThread !== 'function' || !thread.isThread()) {
    await interaction.reply({
      content:
        'Run this inside a thread to nudge it, or use `scan:true` to check all showcase threads.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const ownerId = thread.ownerId;
  if (!ownerId) {
    await interaction.editReply('Could not determine the thread owner.');
    return;
  }

  try {
    const sent = await sendGuidelinesNudge(thread, ownerId, { allowArchived: true });
    if (sent) {
      await interaction.editReply('Nudge sent.');
    } else {
      await interaction.editReply('This thread was already nudged.');
    }
  } catch (err) {
    console.error(`[nudgequestions] failed to nudge thread ${thread.id}:`, err.message);
    await interaction.editReply(`Failed to send nudge: ${err.message}`);
  }
}

async function handleScan(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const apply = interaction.options.getBoolean('apply') ?? false;
  const includeArchived = interaction.options.getBoolean('include_archived') ?? false;

  const dedupSnap = await getDb().collection('guidelinesNudges').get();
  const alreadyNudged = new Set(dedupSnap.docs.map((d) => d.id));

  const showcaseThreads = await listThreadsByMode('showcase');

  const missing = [];
  for (const doc of showcaseThreads) {
    if (alreadyNudged.has(doc.threadId)) continue;

    let thread;
    try {
      thread = await interaction.client.channels.fetch(doc.threadId);
    } catch {
      continue;
    }
    if (!thread) continue;
    if (thread.archived && !includeArchived) continue;

    // Threads carrying an excluded tag (e.g. "just sharing") never get the guidelines
    // nudge — same rule the scheduled check applies, enforced here too so a batch run
    // can't sweep them up.
    try {
      if (await isGuidelinesExempt(thread)) continue;
    } catch (err) {
      console.error(
        `[nudgequestions] tag check failed for thread ${doc.threadId}:`,
        err.message,
      );
      continue;
    }

    let passes;
    try {
      passes = await threadFollowsGuidelines(thread);
    } catch (err) {
      console.error(
        `[nudgequestions] check failed for thread ${doc.threadId}:`,
        err.message,
      );
      continue;
    }
    if (passes) continue;

    missing.push({ threadId: doc.threadId, title: doc.title, ownerId: doc.ownerId, thread });
  }

  if (!apply) {
    const lines = [
      `Found **${missing.length}** showcase thread(s) missing specific questions` +
        (includeArchived ? '.' : ' (active only).'),
    ];
    if (missing.length > 0) {
      lines.push('');
      lines.push(
        missing
          .slice(0, PREVIEW_TITLE_LIMIT)
          .map((m) => `- ${m.title}`)
          .join('\n'),
      );
      if (missing.length > PREVIEW_TITLE_LIMIT) {
        lines.push(`...and ${missing.length - PREVIEW_TITLE_LIMIT} more.`);
      }
      lines.push('');
      lines.push('Run again with `scan:true apply:true` to send nudges.');
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
      const sent = await sendGuidelinesNudge(item.thread, item.ownerId, {
        allowArchived: includeArchived,
      });
      if (sent) nudged += 1;
      else skipped += 1;
    } catch (err) {
      errored += 1;
      console.error(
        `[nudgequestions] failed to nudge thread ${item.threadId}:`,
        err.message,
      );
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
      '**Nudge run complete**',
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
