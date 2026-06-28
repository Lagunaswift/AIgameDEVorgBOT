// Backfill path for downtime. Discord does not replay events the bot missed while
// offline, so /rescan re-reads recent threads in the watched forums and their reactions
// and re-applies registration + showcase scoring. Everything here is idempotent: thread
// registration merges, and point doc ids are deterministic, so a rescan never
// double-counts.

import { ChannelType } from 'discord.js';
import { getEffectiveConfig } from './config.js';
import { registerThread, getThread } from './threads.js';
import { emojiMatches } from '../lib/emoji.js';
import { tryAwardPoint, AwardResult } from './scoring.js';

// Fetch active + recently archived threads for a forum channel.
async function fetchForumThreads(forum) {
  const collected = new Map();
  try {
    const active = await forum.threads.fetchActive();
    for (const [id, th] of active.threads) collected.set(id, th);
  } catch (err) {
    console.error(`[rescan] fetchActive failed for ${forum.id}:`, err.message);
  }
  try {
    const archived = await forum.threads.fetchArchived({ limit: 100 });
    for (const [id, th] of archived.threads) collected.set(id, th);
  } catch (err) {
    console.error(`[rescan] fetchArchived failed for ${forum.id}:`, err.message);
  }
  return [...collected.values()];
}

// Re-apply showcase scoring for one thread by walking its messages and the helpful
// reactions on each. Returns the number of points awarded during this scan.
async function rescanShowcaseThread(thread, threadDoc, cfg) {
  let awarded = 0;

  const messages = await thread.messages.fetch({ limit: 100 });
  for (const message of messages.values()) {
    // Find the helpful reaction on this message, if any.
    const reaction = message.reactions.cache.find((r) => emojiMatches(cfg.helpfulEmoji, r.emoji));
    if (!reaction) continue;

    // Did the thread owner react? Only the owner's tick validates feedback.
    let reactors;
    try {
      reactors = await reaction.users.fetch();
    } catch {
      continue;
    }
    if (!reactors.has(threadDoc.ownerId)) continue;

    const { result } = await tryAwardPoint({
      thread: threadDoc,
      reactorId: threadDoc.ownerId,
      comment: message,
      cfg,
    });
    if (result === AwardResult.AWARDED) awarded += 1;
  }

  return awarded;
}

// Rescan all watched forums. Returns a summary the command can report.
export async function rescanAll(client) {
  const cfg = await getEffectiveConfig({ force: true });
  const summary = { threadsSeen: 0, threadsRegistered: 0, pointsAwarded: 0, forums: 0 };

  const showcaseForums = cfg.watchedShowcaseForumIds.map((id) => ({ id, mode: 'showcase' }));
  const competitionForums = cfg.watchedCompetitionForumIds.map((id) => ({ id, mode: 'competition' }));

  for (const { id, mode } of [...showcaseForums, ...competitionForums]) {
    let forum;
    try {
      forum = await client.channels.fetch(id);
    } catch {
      console.error(`[rescan] could not fetch forum ${id}`);
      continue;
    }
    if (!forum || forum.type !== ChannelType.GuildForum) {
      console.error(`[rescan] channel ${id} is not a forum channel; skipping`);
      continue;
    }
    summary.forums += 1;

    const threads = await fetchForumThreads(forum);
    for (const thread of threads) {
      summary.threadsSeen += 1;

      // Register if missing (idempotent merge).
      let threadDoc = await getThread(thread.id);
      if (!threadDoc) {
        threadDoc = await registerThread(thread, mode);
        summary.threadsRegistered += 1;
      }

      if (mode === 'showcase') {
        try {
          summary.pointsAwarded += await rescanShowcaseThread(thread, threadDoc, cfg);
        } catch (err) {
          console.error(`[rescan] scoring failed for thread ${thread.id}:`, err.message);
        }
      }
    }
  }

  return summary;
}
