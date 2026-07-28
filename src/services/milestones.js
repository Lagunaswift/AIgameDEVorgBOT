// Milestone alerts: tell the mod feed when someone's all-time total crosses a threshold.
//
// Deliberately separate from services/rewards.js. That module ties its notification to a
// role assignment — it skips any threshold without a roleId, and uses "does the member
// already hold the role?" as its dedup — so it cannot alert without also handing out a
// role. Here the reward is applied by hand after a conversation, so the alert has to
// stand on its own. Dedup lives in Firestore instead: one marker doc per user per
// threshold, created atomically, which survives restarts and role changes alike.

import { EmbedBuilder } from 'discord.js';
import { getDb, serverTimestamp } from '../firebase.js';
import { getEffectiveConfig } from './config.js';

function pointsRef() {
  return getDb().collection('points');
}

function milestonesRef() {
  return getDb().collection('milestones');
}

// Coerce a configured threshold list into ascending unique positive integers. Config can
// arrive from env (a comma string) or a Firestore doc (an array), and a malformed entry
// should drop out rather than take the whole feature down.
export function normaliseThresholds(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const ints = raw
    .map((v) => Number.parseInt(String(v).trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(ints)].sort((a, b) => a - b);
}

// Every threshold at or below the running total, ascending.
export function crossedThresholds(total, thresholds) {
  return normaliseThresholds(thresholds).filter((t) => total >= t);
}

// Which newly-crossed threshold to actually announce.
//
// A manual /points adjust can jump someone from 8 to 22, clearing 10 and 20 at once. All
// of them get marked so they never fire later, but only the highest is worth a message —
// two alerts for one action is noise a mod has to read past.
export function alertFor(newlyCrossed) {
  if (!newlyCrossed.length) return null;
  return Math.max(...newlyCrossed);
}

// Claim a marker for (user, threshold). Returns true only for the caller that created it,
// so concurrent reactions can't both announce the same milestone.
async function claimMilestone(userId, threshold, total) {
  try {
    await milestonesRef().doc(`${userId}_${threshold}`).create({
      userId,
      threshold,
      totalAtCrossing: total,
      crossedAt: serverTimestamp(),
    });
    return true;
  } catch (err) {
    // ALREADY_EXISTS (code 6) is the normal path: already announced.
    if (err.code === 6) return false;
    console.error(`[milestones] could not claim ${userId}_${threshold}:`, err.message);
    return false;
  }
}

async function notify({ guild, userId, userTag, threshold, total }) {
  const cfg = await getEffectiveConfig();
  if (!cfg.modFeedChannelId) {
    console.warn('[milestones] no modFeedChannelId configured; alert not sent');
    return false;
  }

  const channel = await guild.client.channels.fetch(cfg.modFeedChannelId);
  if (!channel || !channel.isTextBased()) {
    console.error(`[milestones] mod feed ${cfg.modFeedChannelId} is not text-based`);
    return false;
  }

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setDescription(
      [
        '<:ShowcaseBotReact:1521124760220729445> **Milestone reached**',
        '',
        `<@${userId}>${userTag ? ` (${userTag})` : ''} just passed **${threshold} points**.`,
        `All-time total: **${total}**`,
        '',
        '_No role was applied — send them a thank-you and assign a reward if it fits._',
      ].join('\n'),
    )
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  return true;
}

// Drop every marker for a user, so thresholds can alert again from scratch.
//
// Without this, zeroing someone's points leaves their markers behind and the next
// crossing silently does nothing — the reset would look like it worked and the alert
// would never come back.
//
// Returns the number of markers cleared.
export async function clearMilestones(userId) {
  const db = getDb();
  const snap = await milestonesRef().where('userId', '==', userId).get();

  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    for (const doc of snap.docs.slice(i, i + 400)) batch.delete(doc.ref);
    await batch.commit();
  }

  return snap.size;
}

// Recount a user's all-time total and announce any thresholds newly crossed.
//
// Never throws: called from the reaction hot path and from /points adjust, and a failed
// alert must not cost someone their point or fail a mod's command.
export async function checkMilestones({ guild, userId, userTag, cfg }) {
  if (!guild) return null;

  const thresholds = normaliseThresholds(cfg?.milestoneThresholds);
  if (thresholds.length === 0) return null;

  let total;
  try {
    const snap = await pointsRef().where('commenterId', '==', userId).get();
    total = snap.size;
  } catch (err) {
    console.error('[milestones] failed to count points:', err.message);
    return null;
  }

  const reached = crossedThresholds(total, thresholds);
  if (reached.length === 0) return null;

  const newly = [];
  for (const threshold of reached) {
    if (await claimMilestone(userId, threshold, total)) newly.push(threshold);
  }

  const announce = alertFor(newly);
  if (announce === null) return null;

  try {
    await notify({ guild, userId, userTag, threshold: announce, total });
    console.log(`[milestones] ${userTag || userId} crossed ${announce} (total ${total})`);
  } catch (err) {
    console.error('[milestones] alert failed to send:', err.message);
  }

  return { total, announced: announce, marked: newly };
}
