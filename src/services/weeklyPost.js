// Scheduled weekly leaderboard post.
//
// node-cron fires just after each ISO week rolls over (Monday 00:05 UTC) and posts the
// board for the week that just ended to leaderboardChannelId. Nothing is wiped: the new
// week starts empty automatically because every query filters by isoWeek.
//
// The post is idempotent per week: a marker doc in `weeklyPosts` (id = week string) is
// written only after a successful send, so a restart across the Monday boundary, a
// redeploy, or a since-fixed permission error can't drop the post — a boot catch-up
// re-attempts any week that was never actually delivered, and never double-posts one
// that was.

import cron from 'node-cron';
import { getEffectiveConfig } from './config.js';
import { getDb, serverTimestamp } from '../firebase.js';
import { previousIsoWeek } from '../lib/week.js';

function pointsRef() {
  return getDb().collection('points');
}

// Marker collection recording which weeks have been posted (id = ISO week string).
function weeklyPostsRef() {
  return getDb().collection('weeklyPosts');
}

async function wasWeekPosted(week) {
  try {
    const snap = await weeklyPostsRef().doc(week).get();
    return snap.exists;
  } catch (err) {
    // If we can't read the marker, treat as not posted but log — better a possible
    // duplicate than silently skipping the post entirely.
    console.error(`[weeklyPost] could not read posted-marker for ${week}:`, err.message);
    return false;
  }
}

async function markWeekPosted(week, trigger) {
  await weeklyPostsRef().doc(week).set(
    { week, trigger, postedAt: serverTimestamp() },
    { merge: true },
  );
}

// Build the board for a specific ISO week string.
async function boardForWeek(week, limit = 10) {
  const snap = await pointsRef().where('isoWeek', '==', week).get();
  const counts = new Map();
  const tags = new Map();
  for (const doc of snap.docs) {
    const d = doc.data();
    counts.set(d.commenterId, (counts.get(d.commenterId) || 0) + 1);
    if (d.commenterTag) tags.set(d.commenterId, d.commenterTag);
  }
  return [...counts.entries()]
    .map(([commenterId, points]) => ({
      commenterId,
      commenterTag: tags.get(commenterId) || null,
      points,
    }))
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

// Render the message content for a week's board (empty board gets its own line).
function renderBoard(week, board) {
  if (board.length === 0) {
    return `<:ShowcaseBotReact:1521124760220729445> **Feedback Leaderboard — ${week}**\n\nNo points were awarded this week.`;
  }

  const lines = board.map((e, i) => {
    const rank = `**${i + 1}.**`;
    const name = e.commenterTag || `<@${e.commenterId}>`;
    const pts = e.points === 1 ? '1 point' : `${e.points} points`;
    return `<:helpfulfeedback:1521124800204898386> ${rank} ${name} — ${pts}`;
  });

  return [
    `<:ShowcaseBotReact:1521124760220729445> **Feedback Leaderboard — ${week}**`,
    'Thanks to everyone who left helpful feedback! A fresh week starts now.',
    '',
    ...lines,
  ].join('\n');
}

// Build and send the board for a given week to the configured leaderboard channel.
// Does NOT touch the posted-marker — callers decide whether to record the send.
//
// Returns a result object with a `status` describing the outcome:
//   'posted'       — message sent (count = number of board entries)
//   'no-config'    — no leaderboardChannelId configured
//   'fetch-failed' — the channel could not be fetched (error string in `error`)
//   'not-text'     — the configured channel is not text-based
//   'send-failed'  — channel.send() was rejected (error string in `error`, e.g. permissions)
export async function postLeaderboardForWeek(client, week) {
  const cfg = await getEffectiveConfig({ force: true });
  if (!cfg.leaderboardChannelId) {
    console.warn('[weeklyPost] no leaderboardChannelId configured; skipping');
    return { status: 'no-config', week };
  }

  let channel;
  try {
    channel = await client.channels.fetch(cfg.leaderboardChannelId);
  } catch (err) {
    console.error(
      `[weeklyPost] could not fetch leaderboard channel ${cfg.leaderboardChannelId}:`,
      err.message,
    );
    return { status: 'fetch-failed', week, error: err.message };
  }
  if (!channel || !channel.isTextBased()) {
    console.error(
      `[weeklyPost] leaderboard channel ${cfg.leaderboardChannelId} is not text-based; skipping`,
    );
    return { status: 'not-text', week };
  }

  const board = await boardForWeek(week);

  try {
    await channel.send(renderBoard(week, board));
  } catch (err) {
    console.error(
      `[weeklyPost] send to channel ${cfg.leaderboardChannelId} failed: ${err.message}. ` +
        'Grant the bot View Channel, Send Messages, and Use External Emojis on that channel.',
    );
    return { status: 'send-failed', week, error: err.message, channelId: cfg.leaderboardChannelId };
  }

  return { status: 'posted', week, count: board.length };
}

// Post the weekly leaderboard for a week (defaults to the one that just ended), guarded
// by the per-week idempotency marker. Used by the cron, the boot catch-up, and the manual
// /postleaderboard command.
//
//   trigger: label for logs/marker ('cron' | 'boot-catchup' | 'manual').
//   week:    ISO week string to post (default: previous week).
//   force:   when true, post even if the week is already marked (manual re-posts).
export async function runWeeklyPost(
  client,
  { trigger = 'cron', week = previousIsoWeek(), force = false } = {},
) {
  if (!force && (await wasWeekPosted(week))) {
    console.log(`[weeklyPost] ${week} already posted; skipping (${trigger})`);
    return { status: 'already', week };
  }

  const res = await postLeaderboardForWeek(client, week);

  if (res.status === 'posted') {
    await markWeekPosted(week, trigger);
    console.log(`[weeklyPost] posted leaderboard for ${week} (${trigger})`);
  } else {
    console.error(
      `[weeklyPost] did not post ${week} (${trigger}): ${res.status}` +
        (res.error ? ` — ${res.error}` : ''),
    );
  }

  return res;
}

// Post the previous week's board on boot if it never went out (restart across the Monday
// boundary, or a permission error that's since been fixed). Idempotent, so booting many
// times in a week posts at most once.
export async function catchUpWeeklyPost(client) {
  return runWeeklyPost(client, { trigger: 'boot-catchup' });
}

// Schedule the weekly post. Returns the cron task so callers can stop it if needed.
export function scheduleWeeklyPost(client) {
  // Monday 00:05 UTC — just after the ISO week boundary (weeks start Monday).
  const task = cron.schedule(
    '5 0 * * 1',
    () => {
      runWeeklyPost(client, { trigger: 'cron' }).catch((err) =>
        console.error('[weeklyPost] failed:', err.message),
      );
    },
    { timezone: 'UTC' },
  );
  console.log('[weeklyPost] scheduled for Mondays 00:05 UTC');
  return task;
}
