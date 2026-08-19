// Floppy's daily digest: a short, dry recap of the day, posted to a general channel in
// the voice of a sentient floppy disk (persona lines in lib/floppy.js). The lead section
// is a summary of the actual chat — what people talked about — written by Claude from the
// day's messages (services/chatSummary.js); after it come template lines for the events
// the bot tracks (new builds, points, milestones, first-time posters).
//
// The disguise is a webhook: a webhook message carries its own username and avatar, so the
// digest shows up as "Floppy" with a floppy-disk avatar without touching the bot's real
// identity. Needs Manage Webhooks on the digest channel; without it the digest still posts,
// just as the bot itself.
//
// The event lines come from what is already in Firestore — threads registered (createdAt),
// points awarded (awardedAt), first-time posters (seenAt), milestones crossed (crossedAt) —
// four range queries and a template. Each query ranges over a single field with no extra
// equality filters, deliberately: that shape needs no composite Firestore index, so the
// feature deploys without console work.
//
// A digest day is anchored to the posting time, not midnight: digest date D covers
// [D-1 @ postTime, D @ postTime) UTC. Consecutive digests tile exactly — no event can fall
// between two windows or appear in both. Post markers live in `dailyPosts` (doc id = the
// date string), mirroring weeklyPosts: boot catch-up re-posts a day whose scheduled post
// never went out (restart across the boundary, or a since-fixed permission error) and
// never double-posts one that did.
//
// Prompt-injection note, since this is an AI server: the template lines carry no
// user-authored text — threads and users appear as <#id>/<@id> mentions, which Discord
// renders client-side. The chat recap is the one model-written part; its defences
// (untrusted-transcript prompt, delimiter stripping, output scrubbing, bounded spend)
// live in services/chatSummary.js. Everything is sent with allowedMentions: parse [] so
// nothing in the digest can ping anyone. When no ANTHROPIC_API_KEY is set, the chat
// section is simply absent and the digest is the template-only version.

import cron from 'node-cron';
import { getEffectiveConfig } from './config.js';
import { tally } from './leaderboard.js';
import {
  chatSummaryConfigured,
  collectTranscript,
  summariseChat,
  MIN_MESSAGES_FOR_SUMMARY,
} from './chatSummary.js';
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

// Gather the chat half: read the day's messages and summarise them. Which channels get
// read defaults to the digest channel itself (summarise #general, post in #general);
// DAILY_DIGEST_CHAT_CHANNEL_IDS widens that — never add channels the whole server
// shouldn't see recapped. Returns null when the feature is off (no API key, no client,
// no channels) or collection fails; a null chat never blocks the digest.
async function gatherChat(client, cfg, window, dateStr) {
  if (!client || !chatSummaryConfigured()) return null;

  const channelIds = (
    cfg.dailyDigestChatChannelIds?.length
      ? cfg.dailyDigestChatChannelIds
      : [cfg.dailyDigestChannelId]
  ).filter(Boolean);
  if (channelIds.length === 0) return null;

  try {
    const collected = await collectTranscript(client, channelIds, window);
    let summary = null;
    if (collected.messageCount >= MIN_MESSAGES_FOR_SUMMARY) {
      summary = await summariseChat({
        transcript: collected.transcript,
        dateStr,
        model: cfg.dailyDigestModel,
      });
    }
    return { ...collected, summary };
  } catch (err) {
    console.error('[dailyDigest] chat collection failed:', err.message);
    return null;
  }
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

// The chat section leads the digest — it is the part people asked for. Three shapes:
// a Claude-written recap under a count header, a "too few to bother" line, or a fallback
// when messages existed but summarisation failed (the digest never waits on a retry).
function chatLines(chat) {
  if (!chat || chat.messageCount === 0) return [];
  const n = chat.messageCount;

  if (chat.summary) {
    const where = chat.channelsRead > 1 ? ` across ${chat.channelsRead} channels` : '';
    return [`💬 **The chat, condensed** (${n} ${plural(n, 'message')}${where}):`, chat.summary];
  }
  if (n < MIN_MESSAGES_FOR_SUMMARY) {
    return [`💬 A quiet **${n} ${plural(n, 'message')}** in chat. Barely worth a sector.`];
  }
  return [
    `💬 **${n} messages** in chat today, but my summary sector corrupted. Scroll up, it's good exercise.`,
  ];
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

// Renderer. The template parts (header, opener, event lines, signoff) are deterministic
// for a given date — the rng is seeded by it — so template-only re-renders are identical.
// The chat recap is a live model output, so a re-post after a failure may word it
// differently; the per-day marker is what guarantees a day still posts only once.
export function describeDigest({ dateStr, stats, chat = null, live = false }) {
  const rng = dayRng(dateStr);
  const header = `💾 **FLOPPY.LOG — ${prettyDate(dateStr)}${live ? ' (so far)' : ''}**`;
  const signoff = `-# Floppy 💾 · ${pick(rng, SIGNOFFS)}`;
  const hasChat = Boolean(chat && chat.messageCount > 0);

  if (isQuietDay(stats) && !hasChat) {
    return [header, '', pick(rng, QUIET_DAYS), '', signoff].join('\n');
  }

  const opener = pick(rng, OPENERS);
  const parts = [header, '', opener, ''];
  let used = parts.join('\n').length + signoff.length + 2;

  // Chat first, then event lines; the budget loop drops whatever no longer fits, which
  // by construction is only ever trailing event lines (the recap itself is capped well
  // inside the budget).
  for (const line of [...chatLines(chat), ...buildLines(stats, rng)]) {
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
// `client` is needed to read chat; without it the digest renders template-only.
export async function prepareDigest({
  client = null,
  live = false,
  dateStr = null,
  now = new Date(),
  cfg = null,
} = {}) {
  const effective = cfg || (await getEffectiveConfig({ force: true }));
  const time = parsePostTime(effective.dailyDigestTimeUtc);

  const targetDate = dateStr || latestDigestDate(time, now);
  const window = live
    ? { start: scheduledEndFor(latestDigestDate(time, now), time), end: now }
    : windowFor(targetDate, time);
  const renderDate = live ? dateStrOf(now) : targetDate;

  const [stats, chat] = await Promise.all([
    gatherDayStats(window),
    gatherChat(client, effective, window, renderDate),
  ]);
  const quiet = isQuietDay(stats) && !(chat && chat.messageCount > 0);
  const content = describeDigest({ dateStr: renderDate, stats, chat, live });

  return { cfg: effective, dateStr: targetDate, window, stats, chat, quiet, content };
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
    prepared = await prepareDigest({ client, live, dateStr: day, cfg });
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
