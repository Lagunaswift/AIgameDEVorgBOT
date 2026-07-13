import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import { getEffectiveConfig } from './config.js';
import { getDb, serverTimestamp } from '../firebase.js';
import { previousIsoWeek } from '../lib/week.js';

function pointsRef() {
  return getDb().collection('points');
}

function weeklyPostsRef() {
  return getDb().collection('weeklyPosts');
}

async function wasWeekPosted(week) {
  try {
    const snap = await weeklyPostsRef().doc(week).get();
    return snap.exists;
  } catch (err) {
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

function renderEmbed(week, board) {
  const embed = new EmbedBuilder()
    .setColor(0x39FF14)
    .setFooter({ text: '▸ SHOWCASE BOT ◂' });

  if (board.length === 0) {
    embed.setDescription(
      `<:ShowcaseBotReact:1521124760220729445> **Feedback Leaderboard — ${week}**\n\nNo points were awarded this week.`,
    );
    return embed;
  }

  const lines = board.map((e, i) => {
    const name = e.commenterTag || `<@${e.commenterId}>`;
    const pts = e.points === 1 ? '1 pt' : `${e.points} pts`;
    return `<:helpfulfeedback:1521124800204898386> **${i + 1}.** ${name} — **${pts}**`;
  });

  embed.setDescription(
    [
      `<:ShowcaseBotReact:1521124760220729445> **Feedback Leaderboard — ${week}**`,
      'Thanks to everyone who left helpful feedback! A fresh week starts now.',
      '',
      ...lines,
    ].join('\n'),
  );

  return embed;
}

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
    await channel.send({ embeds: [renderEmbed(week, board)] });
  } catch (err) {
    console.error(
      `[weeklyPost] send to channel ${cfg.leaderboardChannelId} failed: ${err.message}. ` +
        'Grant the bot View Channel, Send Messages, and Use External Emojis on that channel.',
    );
    return { status: 'send-failed', week, error: err.message, channelId: cfg.leaderboardChannelId };
  }

  return { status: 'posted', week, count: board.length };
}

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

export async function catchUpWeeklyPost(client) {
  return runWeeklyPost(client, { trigger: 'boot-catchup' });
}

export function scheduleWeeklyPost(client) {
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
