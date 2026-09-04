// Register / lookup forum threads in the `threads` collection.
//
// Document id = threadId. Registration is the foundation: every watched forum post
// becomes a doc with its owner and mode, which is what every reaction handler looks up
// to decide whether (and how) to score.

import { getDb, serverTimestamp, Timestamp } from '../firebase.js';
import { normalizeJamId, normalizeProjectUrl } from '../lib/publicMetadata.js';

function threadsRef() {
  return getDb().collection('threads');
}

// Transaction core keeps Project links intact when a thread is re-registered by a rescan.
export async function registerThreadTransaction({ transaction, ref, data }) {
  const existing = await transaction.get(ref);
  const current = existing.exists ? existing.data() : null;
  const registration = {
    ...data,
    ...(!current || !Object.hasOwn(current, 'projectId') ? { projectId: null } : {}),
    ...(!current || !Object.hasOwn(current, 'purpose') ? { purpose: null } : {}),
  };
  transaction.set(ref, registration, { merge: true });
  return registration;
}

// Register a thread. Idempotent: re-registering an existing thread leaves Project links
// intact, while a newly registered thread starts with no Project relationship.
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

  return getDb().runTransaction((transaction) => registerThreadTransaction({ transaction, ref, data }));
}

// Look up a registered thread by id. Returns the doc data or null.
export async function getThread(threadId) {
  const snap = await threadsRef().doc(threadId).get();
  return snap.exists ? snap.data() : null;
}

// Public metadata is set only by slash-command handlers after their ownership/mod checks.
// Keeping it in the thread record means the exporter never has to infer it from prose.
export async function setThreadProjectUrl(threadId, projectUrl) {
  const normalized = normalizeProjectUrl(projectUrl);
  if (!normalized) throw new Error('project URL must be an http(s) URL');
  await threadsRef().doc(threadId).update({ projectUrl: normalized });
}

export async function assignThreadJam(threadId, jamId) {
  const normalized = normalizeJamId(jamId);
  if (!normalized) throw new Error('jam ID is invalid');
  await threadsRef().doc(threadId).update({ jamId: normalized });
}

// All registered threads for a given mode.
export async function listThreadsByMode(mode) {
  const snap = await threadsRef().where('mode', '==', mode).get();
  return snap.docs.map((d) => d.data());
}
