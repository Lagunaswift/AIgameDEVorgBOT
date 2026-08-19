// Floppy's daily digest: a short, dry summary of the day's server activity, posted to a
// general channel in the voice of a sentient floppy disk (persona lines in lib/floppy.js).
//
// The disguise is a webhook: a webhook message carries its own username and avatar, so the
// digest shows up as "Floppy" with a floppy-disk avatar without touching the bot's real
// identity. Needs Manage Webhooks on the digest channel; without it the digest still posts,
// just as the bot itself.
//
// Everything reported is already in Firestore — threads registered (createdAt), points
// awarded (awardedAt), first-time posters (seenAt), milestones crossed (crossedAt) — so
// this is four range queries and a template, no new event tracking. Each query ranges over
// a single field with no extra equality filters, deliberately: that shape needs no
// composite Firestore index, so the feature deploys without console work.
//
// A digest day is anchored to the posting time, not midnight: digest date D covers
// [D-1 @ postTime, D @ postTime) UTC. Consecutive digests tile exactly — no event can fall
// between two windows or appear in both. Post markers live in `dailyPosts` (doc id = the
// date string), mirroring weeklyPosts: boot catch-up re-posts a day whose scheduled post
// never went out (restart across the boundary, or a since-fixed permission error) and
// never double-posts one that did.
//
// Prompt-injection note, since this is an AI server: the digest body contains no
// user-authored text at all. Threads and users appear as <#id>/<@id> mentions, which
// Discord renders client-side; titles and names never enter the template. Mentions are
// sent with allowedMentions: parse [] so nobody gets pinged by their own shout-out.

import cron from 'node-cron';
import { getEffectiveConfig } from './config.js';
import { tally } from './leaderboard.js';
import { getDb, serverTimestamp } from '../firebase.js';
import {
  dayRng,
  pick,
  plural,
  OPENERS,
  QUIET_DAYS,
  SIGNOFFS,
  MVP_EPITHETS,
} from '../lib/floppy.js';

function dailyPostsRef() {
  return getDb().collection('dailyPosts');
}

// ---------------------------------------------------------------------------
// Posting time + window math
// ---------------------------------------------------------------------------

export const DEFAULT_POST_TIME = { hour: 20, minute: 0 };

// Parse "HH:MM" (or bare "HH") into { hour, minute }, falling back to the default on
// anything malformed — a bad env value should cost the configured hour, not the feature.
export function parsePostTime(value) {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(value ?? '').trim());
  if (!m) return DEFAULT_POST_TIME;
  const hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (hour > 23 || minute > 59) return DEFAULT_POST_TIME;
  return { hour, minute };
}

// UTC date string ("2026-08-19") for a Date.
function dateStrOf(date) {
  return date.toISOString().slice(0, 10);
}

// The scheduled posting instant for a digest date.
export function scheduledEndFor(dateStr, time) {
  const hh = String(time.hour).padStart(2, '0');
  const mm = String(time.minute).padStart(2, '0');
  return new Date(`${dateStr}T${hh}:${mm}:00Z`);
}

// The most recent digest date whose scheduled time is already past. This is the digest
// the cron would have fired last, and therefore the one boot catch-up checks.
export function latestDigestDate(time, now = new Date()) {
  const today = dateStrOf(now);
  const todayEnd = scheduledEndFor(today, time);
  if (now.getTime() >= todayEnd.getTime()) return today;
  return dateStrOf(new Date(now.getTime() - 24 * 60 * 60 * 1000));
}

// The 24h window a digest date covers.
export function windowFor(dateStr, time) {
  const end = scheduledEndFor(dateStr, time);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Gathering the day
// ---------------------------------------------------------------------------

async function gatherDayStats({ start, end }) {
  const db = getDb();

  const [threadsSnap, pointsSnap, seenSnap, milestonesSnap] = await Promise.all([
    db.collection('threads').where('createdAt', '>=', start).where('createdAt', '<', end).get(),
    db.collection('points').where('awardedAt', '>=', start).where('awardedAt', '<', end).get(),
    db.collection('seenUsers').where('seenAt', '>=', start).where('seenAt', '<', end).get(),
    db.collection('milestones').where('crossedAt', '>=', start).where('crossedAt', '<', end).get(),
  ]);

  const threads = threadsSnap.docs.map((d) => d.data());

  // A manual /points adjust can mark several thresholds for one user at once; only the
  // highest is news (same reasoning as services/milestones.js alertFor).
  const highestByUser = new Map();
  for (const m of milestonesSnap.docs.map((d) => d.data())) {
    const prev = highestByUser.get(m.userId) || 0;
    if (m.threshold > prev) highestByUser.set(m.userId, m.threshold);
  }

  return {
    showcaseThreads: threads.filter((t) => t.mode === 'showcase'),
    competitionThreads: threads.filter((t) => t.mode === 'competition'),
    points: pointsSnap.docs.map((d) => d.data()),
    newPosterCount: seenSnap.size,
    milestones: [...highestByUser.entries()].map(([userId, threshold]) => ({ userId, threshold })),
  };
}

export function isQuietDay(stats) {
  return (
    stats.showcaseThreads.length === 0 &&
    stats.competitionThreads.length === 0 &&
    stats.points.length === 0 &&
    stats.newPosterCount === 0 &&
    stats.milestones.length === 0
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function prettyDate(dateStr) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${dateStr}T00:00:00Z`));
}

// Discord message content caps at 2000 chars; stay well under so a mention that renders
// longer than its raw form can't tip a full day over the edge.
const CONTENT_BUDGET = 1800;
const MAX_BUILD_LINES = 6;
const MAX_MILESTONE_LINES = 4;

// Rotating epithet aside, this consumes rng in a fixed order so same-day renders match.
function mvpLine(stats, rng) {
  const board = tally(stats.points);
  const top = board[0];
  const tied = board.filter((e) => e.points === top.points);

  if (tied.length === 1) {
    return `Top helper: <@${top.commenterId}> with ${top.points}. ${pick(rng, MVP_EPITHETS)}.`;
  }
  if (tied.length === 2) {
    return `Top helpers, tied at ${top.points}: <@${tied[0].commenterId}> and <@${tied[1].commenterId}>. They can share the sector.`;
  }
  return `${tied.length} people tied at ${top.points} for top helper. Suspiciously wholesome.`;
}

function buildLines(stats, rng) {
  const lines = [];

  const builds = stats.showcaseThreads;
  if (builds.length > 0) {
    lines.push(`💾 **${builds.length} new ${plural(builds.length, 'build')}** hit the showcase:`);
    for (const t of builds.slice(0, MAX_BUILD_LINES)) {
      lines.push(`• <#${t.threadId}>${t.ownerId ? ` by <@${t.ownerId}>` : ''}`);
    }
    const dropped = builds.length - MAX_BUILD_LINES;
    if (dropped > 0) lines.push(`• plus ${dropped} more. Someone get me a Disk 2.`);
  }

  const entries = stats.competitionThreads;
  if (entries.length > 0) {
    lines.push(
      `🎨 **${entries.length} competition ${plural(entries.length, 'entry', 'entries')}** filed. May the best pixels win.`,
    );
  }

  if (stats.points.length > 0) {
    const n = stats.points.length;
    lines.push(`✅ **${n} feedback ${plural(n, 'point')}** changed hands.`);
    lines.push(mvpLine(stats, rng));
  }

  for (const m of stats.milestones.slice(0, MAX_MILESTONE_LINES)) {
    lines.push(`🏆 <@${m.userId}> passed **${m.threshold} points** all-time. No CD key required.`);
  }

  if (stats.newPosterCount > 0) {
    const n = stats.newPosterCount;
    lines.push(
      `👋 **${n} ${plural(n, 'person', 'people')} posted for the first time.** Say hi before they fragment.`,
    );
  }

  return lines;
}

// Pure renderer: same date + same stats always produce the same message (the rng is
// seeded by the date), so previews, retries and catch-ups all agree.
export function describeDigest({ dateStr, stats, live = false }) {
  const rng = dayRng(dateStr);
  const header = `💾 **FLOPPY.LOG — ${prettyDate(dateStr)}${live ? ' (so far)' : ''}**`;
  const signoff = `-# Floppy 💾 · ${pick(rng, SIGNOFFS)}`;

  if (isQuietDay(stats)) {
    return [header, '', pick(rng, QUIET_DAYS), '', signoff].join('\n');
  }

  const opener = pick(rng, OPENERS);
  const parts = [header, '', opener, ''];
  let used = parts.join('\n').length + signoff.length + 2;

  for (const line of buildLines(stats, rng)) {
    if (used + line.length + 1 > CONTENT_BUDGET) break;
    parts.push(line);
    used += line.length + 1;
  }

  parts.push('', signoff);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Posting (webhook persona, with plain-bot fallback)
// ---------------------------------------------------------------------------

// Webhooks are cached per channel; a stale entry (webhook deleted by a mod) fails the
// send, drops the cache and falls back to a plain message for that run.
const hookCache = new Map();

async function getOrCreateHook(channel, cfg) {
  const cached = hookCache.get(channel.id);
  if (cached) return cached;

  const hooks = await channel.fetchWebhooks();
  let hook =
    hooks.find((w) => w.token && w.name === cfg.dailyDigestName) ||
    hooks.find((w) => w.token && w.applicationId === channel.client.user.id) ||
    null;

  if (!hook) {
    hook = await channel.createWebhook({
      name: cfg.dailyDigestName,
      reason: 'Daily digest persona',
    });
  }

  hookCache.set(channel.id, hook);
  return hook;
}

// Returns "webhook" or "bot" depending on which path delivered the message. Throws only
// if both paths fail.
async function sendAsFloppy(channel, content, cfg) {
  const allowedMentions = { parse: [] };

  try {
    const hook = await getOrCreateHook(channel, cfg);
    await hook.send({
      content,
      username: cfg.dailyDigestName,
      avatarURL: cfg.dailyDigestAvatarUrl || undefined,
      allowedMentions,
    });
    return 'webhook';
  } catch (err) {
    hookCache.delete(channel.id);
    console.warn(
      `[dailyDigest] webhook persona unavailable (${err.message}); posting as the bot. ` +
        'Grant the bot Manage Webhooks on the digest channel for the floppy avatar.',
    );
  }

  await channel.send({ content, allowedMentions });
  return 'bot';
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function wasDayPosted(dateStr) {
  try {
    const snap = await dailyPostsRef().doc(dateStr).get();
    return snap.exists;
  } catch (err) {
    console.error(`[dailyDigest] could not read posted-marker for ${dateStr}:`, err.message);
    return false;
  }
}

async function markDayPosted(dateStr, trigger, quiet) {
  await dailyPostsRef().doc(dateStr).set(
    { date: dateStr, trigger, quiet, postedAt: serverTimestamp() },
    { merge: true },
  );
}

// Gather + render for a digest without sending it — the /dailydigest preview path.
// live=true covers [last scheduled digest, now) instead of a completed 24h window.
export async function prepareDigest({ live = false, dateStr = null, now = new Date(), cfg = null } = {}) {
  const effective = cfg || (await getEffectiveConfig({ force: true }));
  const time = parsePostTime(effective.dailyDigestTimeUtc);

  const targetDate = dateStr || latestDigestDate(time, now);
  const window = live
    ? { start: scheduledEndFor(latestDigestDate(time, now), time), end: now }
    : windowFor(targetDate, time);

  const stats = await gatherDayStats(window);
  const renderDate = live ? dateStrOf(now) : targetDate;
  const content = describeDigest({ dateStr: renderDate, stats, live });

  return { cfg: effective, dateStr: targetDate, window, stats, quiet: isQuietDay(stats), content };
}

export async function runDailyDigest(
  client,
  { trigger = 'cron', dateStr = null, force = false, live = false } = {},
) {
  const cfg = await getEffectiveConfig({ force: true });

  if (!cfg.dailyDigestChannelId) {
    console.warn('[dailyDigest] no dailyDigestChannelId configured; skipping');
    return { status: 'no-config' };
  }

  // Cheap checks before the Firestore sweep: the marker decides whether there is anything
  // to do at all. A live window is a bonus post outside the daily cadence; it never
  // consults or writes the per-day marker, so it can't make the scheduled digest skip a day.
  const time = parsePostTime(cfg.dailyDigestTimeUtc);
  const day = dateStr || latestDigestDate(time);
  if (!live && !force && (await wasDayPosted(day))) {
    console.log(`[dailyDigest] ${day} already posted; skipping (${trigger})`);
    return { status: 'already', dateStr: day };
  }

  let prepared;
  try {
    prepared = await prepareDigest({ live, dateStr: day, cfg });
  } catch (err) {
    console.error('[dailyDigest] gathering the day failed:', err.message);
    return { status: 'gather-failed', dateStr: day, error: err.message };
  }

  const { quiet, content } = prepared;

  if (quiet && cfg.dailyDigestSkipQuiet) {
    if (!live) await markDayPosted(day, trigger, true);
    console.log(`[dailyDigest] ${day} was quiet; skipping per config (${trigger})`);
    return { status: 'quiet-skipped', dateStr: day };
  }

  let channel;
  try {
    channel = await client.channels.fetch(cfg.dailyDigestChannelId);
  } catch (err) {
    console.error(
      `[dailyDigest] could not fetch digest channel ${cfg.dailyDigestChannelId}:`,
      err.message,
    );
    return { status: 'fetch-failed', dateStr: day, error: err.message };
  }
  if (!channel || !channel.isTextBased()) {
    console.error(
      `[dailyDigest] digest channel ${cfg.dailyDigestChannelId} is not text-based; skipping`,
    );
    return { status: 'not-text', dateStr: day };
  }

  let via;
  try {
    via = await sendAsFloppy(channel, content, cfg);
  } catch (err) {
    console.error(
      `[dailyDigest] send to channel ${cfg.dailyDigestChannelId} failed: ${err.message}. ` +
        'Grant the bot View Channel and Send Messages there (plus Manage Webhooks for the avatar).',
    );
    return { status: 'send-failed', dateStr: day, error: err.message };
  }

  if (!live) await markDayPosted(day, trigger, quiet);
  console.log(`[dailyDigest] posted digest for ${day} via ${via} (${trigger})`);
  return { status: 'posted', dateStr: day, via, quiet };
}

// Boot catch-up: post the most recent due digest if it never went out. The per-day marker
// keeps this to at most one post per day, exactly like the weekly leaderboard's catch-up.
export async function catchUpDailyDigest(client) {
  return runDailyDigest(client, { trigger: 'boot-catchup' });
}

export async function scheduleDailyDigest(client) {
  const cfg = await getEffectiveConfig({ force: true });
  const time = parsePostTime(cfg.dailyDigestTimeUtc);

  const task = cron.schedule(
    `${time.minute} ${time.hour} * * *`,
    () => {
      runDailyDigest(client, { trigger: 'cron' }).catch((err) =>
        console.error('[dailyDigest] failed:', err.message),
      );
    },
    { timezone: 'UTC' },
  );
  console.log(
    `[dailyDigest] scheduled daily at ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')} UTC`,
  );
  return task;
}
