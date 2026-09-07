// Shared bounded search for raw REST and discord.js message adapters. Existing early
// images keep priority; a recent-page fallback lets an owner add an image to a long thread.
export const THREAD_IMAGE_PAGE_SIZE = 100;
export const THREAD_IMAGE_MAX_PAGES = 5;

function orderedMessages(messages) {
  if (!Array.isArray(messages) || messages.some((message) => !/^\d{17,20}$/.test(message?.id))) {
    throw new Error('Thread image search returned invalid message data');
  }
  return [...messages].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
}

function ownerImage(messages, ownerId, findImage) {
  for (const message of messages) {
    if (message.author?.id !== ownerId || message.author.bot) continue;
    const image = findImage(message);
    if (image) return image;
  }
  return null;
}

export async function findOwnerReplyImage({ threadId, ownerId, fetchPage, findImage }) {
  if (!ownerId) return null;
  let after = threadId;
  for (let page = 0; page < THREAD_IMAGE_MAX_PAGES; page++) {
    const messages = orderedMessages(await fetchPage({ after, limit: THREAD_IMAGE_PAGE_SIZE }));
    const replies = messages.filter((message) => BigInt(message.id) > BigInt(after));
    const image = ownerImage(replies, ownerId, findImage);
    if (image) return image;
    if (messages.length < THREAD_IMAGE_PAGE_SIZE) return null;
    if (!replies.length) break; // No cursor progress: never loop forever on a repeated page.
    after = replies.at(-1).id;
  }

  // No early image found within the budget. Check the newest page as well so posting
  // a fresh screenshot works even when the original thread has thousands of replies.
  const recent = orderedMessages(await fetchPage({ limit: THREAD_IMAGE_PAGE_SIZE }))
    .filter((message) => BigInt(message.id) > BigInt(threadId));
  const image = ownerImage(recent, ownerId, findImage);
  if (image) return image;
  if (recent.length < THREAD_IMAGE_PAGE_SIZE || BigInt(recent[0].id) <= BigInt(after)) return null;
  // There is an unsearched gap. Do not claim the thread has no image, send a false
  // reminder, or clear an earlier exported image merely because it left the recent page.
  throw new Error(`Thread ${threadId} image search reached its history limit; a fresh owner image reply or manual review is needed`);
}
