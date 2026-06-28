// Register / lookup forum threads in the `threads` collection.
//
// Document id = threadId. Registration is the foundation: every watched forum post
// becomes a doc with its owner and mode, which is what every reaction handler looks up
// to decide whether (and how) to score.

import { getDb, serverTimestamp, Timestamp } from '../firebase.js';

function threadsRef() {
  return getDb().collection('threads');
}

// Register a thread. Idempotent: re-registering an existing thread leaves the original
// createdAt/registeredAt and owner intact (merge), so /rescan never clobbers history.
export async function registerThread(thread, mode) {
  const ref = threadsRef().doc(thread.id);

  const ownerId = thread.ownerId || null;
  let ownerTag = null;
  try {
    // ownerId resolves to the post author in a forum thread. Fetch the tag best-effort.
    const owner = ownerId ? await thread.client.users.fetch(ownerId) : null;
    ownerTag = owner ? owner.tag : null;
  } catch {
    ownerTag = null;
  }

  const createdAt = thread.createdAt
    ? Timestamp.fromDate(thread.createdAt)
    : serverTimestamp();

  const data = {
    threadId: thread.id,
    forumId: thread.parentId,
    ownerId,
    ownerTag,
    title: thread.name,
    mode,
    createdAt,
    registeredAt: serverTimestamp(),
  };

  // merge:true so a backfill rescan updates title/mode without resetting registeredAt
  // ordering or overwriting fields we intentionally leave undefined.
  await ref.set(data, { merge: true });
  return data;
}

// Look up a registered thread by id. Returns the doc data or null.
export async function getThread(threadId) {
  const snap = await threadsRef().doc(threadId).get();
  return snap.exists ? snap.data() : null;
}

// All registered threads for a given mode.
export async function listThreadsByMode(mode) {
  const snap = await threadsRef().where('mode', '==', mode).get();
  return snap.docs.map((d) => d.data());
}
