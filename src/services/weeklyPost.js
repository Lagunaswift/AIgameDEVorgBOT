// Scheduled weekly leaderboard post.
//
// node-cron fires just after each ISO week rolls over (Monday 00:05 UTC) and posts the
// board for the week that just ended to leaderboardChannelId. Nothing is wiped: the new
// week starts empty automatically because every query filters by isoWeek.

import cron from 'node-cron';
import { getEffectiveConfig } from './config.js';
import { getDb } from '../firebase.js';
import { previousIsoWeek } from '../lib/week.js';

function pointsRef() {
  return getDb().collection('points');
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

export async function postWeeklyLeaderboard(client) {
  const cfg = await getEffectiveConfig({ force: true });
  if (!cfg.leaderboardChannelId) {
    console.warn('[weeklyPost] no leaderboardChannelId configured; skipping');
    return;
  }

  const week = previousIsoWeek();
  const board = await boardForWeek(week);

  let channel;
  try {
    channel = await client.channels.fetch(cfg.leaderboardChannelId);
  } catch (err) {
    console.error('[weeklyPost] could not fetch leaderboard channel:', err.message);
    return;
  }
  if (!channel || !channel.isTextBased()) {
    console.error('[weeklyPost] leaderboard channel is not text-based; skipping');
    return;
  }

  if (board.length === 0) {
    await channel.send(`🏆 **Feedback Leaderboard — ${week}**\n\nNo points were awarded this week.`);
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = board.map((e, i) => {
    const rank = medals[i] || `**${i + 1}.**`;
    const name = e.commenterTag || `<@${e.commenterId}>`;
    const pts = e.points === 1 ? '1 point' : `${e.points} points`;
    return `${rank} ${name} — ${pts}`;
  });

  await channel.send(
    [
      `🏆 **Feedback Leaderboard — ${week}**`,
      'Thanks to everyone who left helpful feedback! A fresh week starts now.',
      '',
      ...lines,
    ].join('\n'),
  );
  console.log(`[weeklyPost] posted leaderboard for ${week}`);
}

// Schedule the weekly post. Returns the cron task so callers can stop it if needed.
export function scheduleWeeklyPost(client) {
  // Monday 00:05 UTC — just after the ISO week boundary (weeks start Monday).
  const task = cron.schedule(
    '5 0 * * 1',
    () => {
      postWeeklyLeaderboard(client).catch((err) =>
        console.error('[weeklyPost] failed:', err.message),
      );
    },
    { timezone: 'UTC' },
  );
  console.log('[weeklyPost] scheduled for Mondays 00:05 UTC');
  return task;
}
