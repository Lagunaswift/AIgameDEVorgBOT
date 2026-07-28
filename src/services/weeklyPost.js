import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import { getEffectiveConfig } from './config.js';
import { tally, rollNames } from './leaderboard.js';
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

// Everyone who earned at least one point in the week. No limit: this is a thank-you
// roll, so truncating it would silently drop people who did the work.
async function boardForWeek(week) {
  const snap = await pointsRef().where('isoWeek', '==', week).get();
  return tally(snap.docs.map((d) => d.data()));
}

// The public weekly post: names only, alphabetical, set as a run rather than a column.
//
// Deliberately carries no scores or positions. A vertical scored column reads as a
// ladder whether or not it is numbered, and on a quiet week that makes the board look
// like a contest nobody entered. Mods still see the real figures privately via
// /leaderboard; the ranking moved rather than disappearing.
export function describeRoll(week, board) {
  const header = `<:ShowcaseBotReact:1521124760220729445> **Thanks for the feedback — ${week}**`;

  if (board.length === 0) {
    return `${header}\n\nNo feedback was scored this week.`;
  }

  const all = rollNames(board).map((n) => `**${n}**`);

  // Discord rejects embed descriptions over 4096 characters. The roll is deliberately
  // unlimited, so trim only if a week is genuinely huge — and say how many were cut
  // rather than letting names vanish silently.
  const BUDGET = 3600;
  const names = [];
  let used = 0;
  for (const n of all) {
    if (used + n.length + 3 > BUDGET) break;
    names.push(n);
    used += n.length + 3;
  }
  const dropped = all.length - names.length;

  return [
    header,
    "These folks left helpful feedback on someone's project this week.",
    '',
    `<:helpfulfeedback:1521124800204898386> ${names.join(' · ')}` +
      (dropped > 0 ? ` _and ${dropped} more_` : ''),
  ].join('\n');
}

function renderEmbed(week, board) {
  return new EmbedBuilder()
    .setColor(0x39FF14)
    .setDescription(describeRoll(week, board));
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
