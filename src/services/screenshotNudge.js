// Screenshot nudge: a friendly one-time reminder for showcase threads that have no image.
//
// Image-presence rule (shared with the exporter): use the owner's starter attachment,
// then scan bounded early reply history and a recent-page fallback for owner uploads. Dedup is
// tracked in the `screenshotNudges` collection (doc id = threadId) so a thread is ever
// nudged at most once, whether that happens via the scheduled check or the mod command.

import { getDb, serverTimestamp } from '../firebase.js';
import { findOwnerReplyImage } from '../lib/threadImages.js';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

function isImageAttachment(attachment) {
  if (!attachment) return false;
  if (typeof attachment.contentType === 'string' && attachment.contentType.toLowerCase().startsWith('image/')) return true;

  const name = attachment.name || '';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return IMAGE_EXTENSIONS.includes(ext);
}

function messageImage(message) {
  if (!message || !message.attachments) return null;
  for (const attachment of message.attachments.values()) {
    if (isImageAttachment(attachment)) return attachment;
  }
  return null;
}

export function buildScreenshotNudgeMessage(ownerId) {
  return `Hey <@${ownerId}>, attach a screenshot or short gameplay GIF to a new reply in this thread. ` +
    `Upload it from your own account so Byte can find your game's image. Link previews and other members' uploads won't be used.`;
}

function dedupRef(threadId) {
  return getDb().collection('screenshotNudges').doc(threadId);
}

// Implements the shared image-presence rule against live gateway objects.
export async function threadHasScreenshot(thread) {
  const ownerId = thread.ownerId;
  if (!ownerId) return false;
  // Starter message (id === thread.id in a forum thread). It may have been deleted, in
  // which case fetchStarterMessage can throw or resolve null; either way, fall through.
  let starter = null;
  try {
    starter = await thread.fetchStarterMessage();
  } catch {
    starter = null;
  }
  if (starter?.author?.id === ownerId && !starter.author.bot && messageImage(starter)) return true;

  // Lookup failures propagate to callers, which skip the nudge rather than permanently
  // marking a thread as missing an image when its history could not be read.
  return Boolean(await findOwnerReplyImage({
    threadId: thread.id,
    ownerId,
    fetchPage: async (options) => [...(await thread.messages.fetch(options)).values()],
    findImage: messageImage,
  }));
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

  const message = buildScreenshotNudgeMessage(ownerId);

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
