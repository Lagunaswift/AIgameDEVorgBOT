// Register / lookup forum threads in the `threads` collection.
//
// Document id = threadId. Registration is the foundation: every watched forum post
// becomes a doc with its owner and mode, which is what every reaction handler looks up
// to decide whether (and how) to score.

import { getDb, serverTimestamp, Timestamp } from '../firebase.js';
import { normalizeJamId } from '../lib/publicMetadata.js';

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
    ...(!current || !Object.hasOwn(current, 'publishOnProject') ? { publishOnProject: false } : {}),
    ...(!current || !Object.hasOwn(current, 'activityTitle') ? { activityTitle: null } : {}),
    ...(!current || !Object.hasOwn(current, 'activitySummary') ? { activitySummary: null } : {}),
  };
  transaction.set(ref, registration, { merge: true });
  return registration;
}

// Register a thread. Idempotent: re-registering an existing thread leaves Project links
// intact, while a newly registered thread starts with no Project relationship or
// Project-page publication consent.
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

// Legacy thread.projectUrl values are retained read-only for unlinked records.
// Project destinations are edited only through the authenticated owner editor.
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
