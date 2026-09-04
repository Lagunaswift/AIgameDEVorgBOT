import { getDb, serverTimestamp } from '../firebase.js';

function dedupRef(threadId) {
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

  const ref = dedupRef(thread.id);
  try {
    await ref.create({
      threadId: thread.id,
      ownerId,
      nudgedAt: serverTimestamp(),
    });
  } catch {
    return false;
  }

  const message =
    `Hey <@${ownerId}>! Per the guidelines, please add 1-2 specific questions when looking ` +
    `for feedback. Also let us know how long you expect people to be playing for. ` +
    `Post will be deleted in 12 hours if you don't!`;

  try {
    await thread.send({ content: message });
  } catch (err) {
    try { await ref.delete(); } catch {}
    throw err;
  }

  return true;
}

export function scheduleGuidelinesCheck(thread, delayMs) {
  const threadId = thread.id;
  const client = thread.client;

  setTimeout(async () => {
    try {
      let fresh;
      try {
        fresh = await client.channels.fetch(threadId);
      } catch {
        return;
      }
      if (!fresh || fresh.archived) return;

      const ownerId = fresh.ownerId || thread.ownerId;
      if (!ownerId) return;

      const passes = await threadFollowsGuidelines(fresh);
      if (!passes) {
        await sendGuidelinesNudge(fresh, ownerId);
      }
    } catch (err) {
      console.warn(`[guidelinesNudge] scheduled check failed for thread ${threadId}:`, err.message);
    }
  }, delayMs);
}
