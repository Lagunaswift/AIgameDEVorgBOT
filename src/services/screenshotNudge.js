// Screenshot nudge: a friendly one-time reminder for showcase threads that have no image.
//
// Image-presence rule (shared with /nudgescreenshots): a thread "has a screenshot" when
// EITHER its starter message has an image attachment, OR any of the first 50 messages
// fetched after the starter that were authored by the thread owner has one. Dedup is
// tracked in the `screenshotNudges` collection (doc id = threadId) so a thread is ever
// nudged at most once, whether that happens via the scheduled check or the mod command.

import { getDb, serverTimestamp } from '../firebase.js';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

function isImageAttachment(attachment) {
  if (!attachment) return false;
  if (attachment.contentType && attachment.contentType.startsWith('image/')) return true;

  const name = attachment.name || '';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return IMAGE_EXTENSIONS.includes(ext);
}

function messageHasImage(message) {
  if (!message || !message.attachments) return false;
  for (const attachment of message.attachments.values()) {
    if (isImageAttachment(attachment)) return true;
  }
  return false;
}

function dedupRef(threadId) {
  return getDb().collection('screenshotNudges').doc(threadId);
}

// Implements the shared image-presence rule against live gateway objects.
export async function threadHasScreenshot(thread) {
  // Starter message (id === thread.id in a forum thread). It may have been deleted, in
  // which case fetchStarterMessage can throw or resolve null; either way, fall through.
  let starter = null;
  try {
    starter = await thread.fetchStarterMessage();
  } catch {
    starter = null;
  }
  if (messageHasImage(starter)) return true;

  const ownerId = thread.ownerId;
  if (!ownerId) return false;

  let recent;
  try {
    recent = await thread.messages.fetch({ after: thread.id, limit: 50 });
  } catch (err) {
    console.warn(`[screenshotNudge] failed to fetch messages for thread ${thread.id}:`, err.message);
    return false;
  }

  const ownerMessages = [...recent.values()]
    .filter((m) => m.author?.id === ownerId)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

  return ownerMessages.some((m) => messageHasImage(m));
}

// Sends the nudge once, guarded by the Firestore dedup doc. Returns true if a nudge was
// sent, false if it was skipped (dedup hit, or the thread is archived and the caller did
// not opt in). Send failures propagate so callers can decide how to handle them.
//
// Two guards enforced HERE, at the point of send, not just at discovery time:
// 1. Archived re-check: sending into an archived thread un-archives it. Discovery can be
//    minutes before send in a big batch, so state is re-fetched immediately before send.
// 2. Atomic dedup: ref.create() claims the doc before sending (it throws when the doc
//    already exists), so two concurrent callers (scheduled timer + mod command) can never
//    both send. The claim is rolled back if the send itself fails, keeping retries alive.
export async function sendScreenshotNudge(thread, ownerId, { allowArchived = false } = {}) {
  if (!allowArchived) {
    let fresh = thread;
    try {
      fresh = await thread.fetch();
    } catch {
      return false; // deleted between discovery and send
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
    return false; // doc already exists: someone else nudged first
  }

  const message =
    `Hey <@${ownerId}>, nice post! Add a screenshot or short GIF to your first message ` +
    `and this game will show up on the AIGAMEDEV site showcase. Games with images can ` +
    `get featured on the homepage.`;

  try {
    await thread.send({ content: message });
  } catch (err) {
    // Roll back the claim so a later retry is possible; then let the caller see the error.
    try {
      await ref.delete();
    } catch {}
    throw err;
  }

  return true;
}

// Fire-and-forget timer: after delayMs, re-check the thread and nudge only if it still
// has no screenshot. Never throws (a bot restart during the window is acceptably covered
// by the /nudgescreenshots mod command as a backfill).
export function scheduleNudgeCheck(thread, delayMs) {
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

      const hasScreenshot = await threadHasScreenshot(fresh);
      if (!hasScreenshot) {
        await sendScreenshotNudge(fresh, ownerId);
      }
    } catch (err) {
      console.warn(`[screenshotNudge] scheduled check failed for thread ${threadId}:`, err.message);
    }
  }, delayMs);
}
