import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import { getEffectiveConfig } from './config.js';
import { getDb } from '../firebase.js';
import { previousIsoWeek } from '../lib/week.js';

function pointsRef() {
  return getDb().collection('points');
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

function pixelBar(points, max) {
  const len = 10;
  const filled = max > 0 ? Math.round((points / max) * len) : 0;
  return '█'.repeat(Math.max(filled, 1)) + '░'.repeat(len - Math.max(filled, 1));
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

  const embed = new EmbedBuilder()
    .setColor(0x39FF14)
    .setFooter({ text: '▸ SHOWCASE BOT ◂' });

  if (board.length === 0) {
    embed.setDescription(
      `<:ShowcaseBotReact:1521124760220729445> **Feedback Leaderboard — ${week}**\n\n\`░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░\`\n No points were awarded this week.\n\`░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░\``,
    );
    await channel.send({ embeds: [embed] });
    return;
  }

  const maxPoints = board[0].points;
  const lines = board.map((e, i) => {
    const name = e.commenterTag || `<@${e.commenterId}>`;
    const pts = e.points === 1 ? '1 pt' : `${e.points} pts`;
    const bar = pixelBar(e.points, maxPoints);
    return `<:helpfulfeedback:1521124800204898386> **${i + 1}.** ${name} — **${pts}**\n\`${bar}\``;
  });

  embed.setDescription(
    [
      `<:ShowcaseBotReact:1521124760220729445> **Feedback Leaderboard — ${week}**`,
      'Thanks to everyone who left helpful feedback! A fresh week starts now.',
      '',
      ...lines,
    ].join('\n'),
  );

  await channel.send({ embeds: [embed] });
  console.log(`[weeklyPost] posted leaderboard for ${week}`);
}

export function scheduleWeeklyPost(client) {
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
