// Posting-guidelines nudge: a one-time reminder for showcase threads whose starter
// message neither follows a /posttemplate structure nor asks a specific question.
//
// The scheduled check no longer lives here. Guidelines and screenshots are evaluated
// together and delivered as ONE message by services/postNudge.js, so a poster missing
// both never gets two nudges back to back. This module owns the guidelines half: the
// pass/fail rule, the tag exclusion, its share of the message, and the dedup doc
// (`guidelinesNudges`, doc id = threadId) that /nudgequestions also writes.

import { getDb, serverTimestamp } from '../firebase.js';
import { getEffectiveConfig } from './config.js';
import { threadHasExcludedTag } from '../lib/tags.js';

export function guidelinesDedupRef(threadId) {
  return getDb().collection('guidelinesNudges').doc(threadId);
}

const TEMPLATE_HEADERS = [
  '**feedback target:**',
  '**approximate play time:**',
  '**playable link:**',
  '**game/build:**',
  '**feedback wanted:**',
  '**what i\'m building:**',
  '**what changed:**',
];

// True when the thread carries a tag that opts it out of the guidelines nudge (for
// example "just sharing" posts, which aren't asking for feedback at all).
export async function isGuidelinesExempt(thread) {
  const cfg = await getEffectiveConfig();
  return threadHasExcludedTag(thread, {
    names: cfg.excludedTagNames || [],
    ids: cfg.excludedTagIds || [],
  });
}

export async function threadFollowsGuidelines(thread) {
  let starter = null;
  try {
    starter = await thread.fetchStarterMessage();
  } catch {
    starter = null;
  }
  if (!starter || !starter.content) return false;

  const lower = starter.content.toLowerCase();

  const usesTemplate = TEMPLATE_HEADERS.some((h) => lower.includes(h));
  if (usesTemplate) return true;

  const questions = (starter.content.match(/\?/g) || []).length;
  return questions >= 1;
}

// The guidelines ask, split from its closing warning so the photo ask (see
// screenshotNudge.js) can sit between them in the combined message.
export const GUIDELINES_BODY =
  'Per the guidelines, please add 1-2 specific questions when looking for feedback. ' +
  'Also let us know how long you expect people to be playing for.';

export const GUIDELINES_WARNING =
  "Post will be deleted in 12 hours if you don't!";

export function buildGuidelinesMessage(ownerId) {
  return `Hey <@${ownerId}>! ${GUIDELINES_BODY} ${GUIDELINES_WARNING}`;
}

export async function sendGuidelinesNudge(thread, ownerId, { allowArchived = false } = {}) {
  if (!allowArchived) {
    let fresh = thread;
    try {
      fresh = await thread.fetch();
    } catch {
      return false;
    }
    if (!fresh || fresh.archived) return false;
  }

  const ref = guidelinesDedupRef(thread.id);
  try {
    await ref.create({
      threadId: thread.id,
      ownerId,
      nudgedAt: serverTimestamp(),
    });
  } catch {
    return false;
  }

  try {
    await thread.send({ content: buildGuidelinesMessage(ownerId) });
  } catch (err) {
    try { await ref.delete(); } catch {}
    throw err;
  }

  return true;
}
