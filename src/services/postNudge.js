// Combined post nudge: ONE delayed check, ONE posted message.
//
// A new showcase thread can fail two things at once — no specific questions (posting
// guidelines) and no image. Running the two checks as separate timers meant the poster
// got two bot messages back to back. This module evaluates both and sends a single
// message containing only the parts that apply:
//
//   guidelines missing + no photo -> guidelines ask + photo ask + deletion warning
//   guidelines missing + photo    -> guidelines ask + deletion warning
//   guidelines ok + no photo      -> photo ask only (no deletion warning: it's friendly)
//   both fine                     -> nothing sent
//
// Each half keeps its own dedup doc (`guidelinesNudges` / `screenshotNudges`), claimed
// atomically before the send, so the /nudgequestions and /nudgescreenshots mod commands
// never re-nudge a thread this check already covered — and a half that was already
// covered by a mod command is dropped from the message rather than repeated.

import { serverTimestamp } from '../firebase.js';
import { config } from '../config.js';
import {
  threadFollowsGuidelines,
  isGuidelinesExempt,
  guidelinesDedupRef,
  GUIDELINES_BODY,
  GUIDELINES_WARNING,
} from './guidelinesNudge.js';
import {
  threadHasScreenshot,
  screenshotDedupRef,
  buildScreenshotBody,
} from './screenshotNudge.js';

export function buildCombinedNudge(ownerId, { needsGuidelines, needsPhoto }) {
  if (!needsGuidelines && !needsPhoto) return null;

  const parts = [`Hey <@${ownerId}>!`];
  if (needsGuidelines) parts.push(GUIDELINES_BODY);
  if (needsPhoto) parts.push(buildScreenshotBody({ standalone: !needsGuidelines }));
  if (needsGuidelines) parts.push(GUIDELINES_WARNING);

  return parts.join(' ');
}

// The two halves share one timer, so they share one delay: the shorter of whichever
// halves are enabled, keeping each nudge at least as prompt as it was on its own.
export function combinedNudgeDelayMinutes(cfg = config) {
  const delays = [];
  if (cfg.guidelinesNudgeEnabled) delays.push(cfg.guidelinesNudgeDelayMinutes);
  if (cfg.screenshotNudgeEnabled) delays.push(cfg.screenshotNudgeDelayMinutes);
  return delays.length ? Math.min(...delays) : null;
}

async function claim(ref, thread, ownerId) {
  try {
    await ref.create({ threadId: thread.id, ownerId, nudgedAt: serverTimestamp() });
    return true;
  } catch {
    return false; // already nudged for this half (mod command, or a previous run)
  }
}

// Evaluates both halves and sends at most one message. Returns what was included, so
// callers can log it. Send failures roll the dedup claims back and propagate.
export async function sendCombinedNudge(thread, ownerId, { cfg = config } = {}) {
  // Sending into an archived thread un-archives it. The scheduler re-fetches state
  // immediately before calling, so this reads that fresh value rather than fetching again.
  if (thread.archived) return { sent: false, guidelines: false, photo: false };

  const wantGuidelines = cfg.guidelinesNudgeEnabled && !(await isGuidelinesExempt(thread));
  const wantPhoto = cfg.screenshotNudgeEnabled;

  let needsGuidelines = false;
  if (wantGuidelines) needsGuidelines = !(await threadFollowsGuidelines(thread));

  let needsPhoto = false;
  if (wantPhoto) needsPhoto = !(await threadHasScreenshot(thread));

  if (!needsGuidelines && !needsPhoto) return { sent: false, guidelines: false, photo: false };

  // Claim before sending so a concurrent mod command can't produce a duplicate. A half
  // whose claim is refused was already nudged, so it drops out of this message.
  const claimed = [];
  if (needsGuidelines) {
    const ref = guidelinesDedupRef(thread.id);
    if (await claim(ref, thread, ownerId)) claimed.push(ref);
    else needsGuidelines = false;
  }
  if (needsPhoto) {
    const ref = screenshotDedupRef(thread.id);
    if (await claim(ref, thread, ownerId)) claimed.push(ref);
    else needsPhoto = false;
  }

  const message = buildCombinedNudge(ownerId, { needsGuidelines, needsPhoto });
  if (!message) return { sent: false, guidelines: false, photo: false };

  try {
    await thread.send({ content: message });
  } catch (err) {
    for (const ref of claimed) {
      try { await ref.delete(); } catch {}
    }
    throw err;
  }

  return { sent: true, guidelines: needsGuidelines, photo: needsPhoto };
}

// Fire-and-forget timer: after delayMs, re-check the thread and send whichever halves
// still apply. Never throws (a bot restart during the window is acceptably covered by the
// /nudgequestions and /nudgescreenshots mod commands as a backfill).
export function schedulePostNudgeCheck(thread, delayMs) {
  const threadId = thread.id;
  const client = thread.client;

  setTimeout(async () => {
    try {
      let fresh;
      try {
        fresh = await client.channels.fetch(threadId);
      } catch {
        return; // deleted
      }
      if (!fresh || fresh.archived) return; // deleted or archived: bail silently

      const ownerId = fresh.ownerId || thread.ownerId;
      if (!ownerId) return;

      await sendCombinedNudge(fresh, ownerId);
    } catch (err) {
      console.warn(`[postNudge] scheduled check failed for thread ${threadId}:`, err.message);
    }
  }, delayMs);
}
