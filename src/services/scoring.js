// Showcase award rules, enforced in the exact order from the spec. Every branch here
// is an anti-farm guard; getting the order or any check wrong silently breaks scoring.
//
// A point is one document in `points` with a deterministic id `${threadId}_${commentMessageId}`,
// so the same comment can never be scored twice and reaction-remove can find it exactly.

import { getDb, serverTimestamp } from '../firebase.js';
import { isoWeek } from '../lib/week.js';

function pointsRef() {
  return getDb().collection('points');
}

export function pointDocId(threadId, commentMessageId) {
  return `${threadId}_${commentMessageId}`;
}

// Outcome codes returned by tryAwardPoint, so callers (and tests) can assert on the
// exact branch taken rather than parsing a message.
export const AwardResult = {
  AWARDED: 'awarded',
  NOT_OWNER: 'not_owner',
  SELF_COMMENT: 'self_comment',
  BOT_COMMENT: 'bot_comment',
  TOO_SHORT: 'too_short',
  AT_CAP: 'at_cap',
  ALREADY_SCORED: 'already_scored',
};

// Award a point for a helpful tick if and only if every rule passes, checked in order.
//
//   thread:     the registered `threads` doc data (has ownerId).
//   reactorId:  the user who added the reaction.
//   comment:    the discord.js Message that was reacted to (the comment being marked).
//   cfg:        effective config (minCommentLength, maxPointsPerThreadPerUser).
//
// Returns { result, point? }.
export async function tryAwardPoint({ thread, reactorId, comment, cfg }) {
  const threadId = thread.threadId;
  const commentAuthor = comment.author;

  // 1. The reactor must be the thread owner. Only the receiver of feedback validates it.
  if (reactorId !== thread.ownerId) {
    return { result: AwardResult.NOT_OWNER };
  }

  // 2. The comment author must not be the thread owner (no self-scoring).
  if (commentAuthor.id === thread.ownerId) {
    return { result: AwardResult.SELF_COMMENT };
  }

  // 3. The comment author must not be a bot.
  if (commentAuthor.bot) {
    return { result: AwardResult.BOT_COMMENT };
  }

  // 4. Comment text length floor (kills one-liners). Requires the MessageContent intent.
  const contentLength = (comment.content || '').trim().length;
  if (contentLength < cfg.minCommentLength) {
    return { result: AwardResult.TOO_SHORT };
  }

  const db = getDb();
  const docId = pointDocId(threadId, comment.id);
  const docRef = pointsRef().doc(docId);

  // 5. Per-commenter cap on this thread. Count existing points docs for this thread +
  //    commenter; stop if already at cap.
  const existingForCommenter = await pointsRef()
    .where('threadId', '==', threadId)
    .where('commenterId', '==', commentAuthor.id)
    .get();
  if (existingForCommenter.size >= cfg.maxPointsPerThreadPerUser) {
    return { result: AwardResult.AT_CAP };
  }

  // 6. No existing doc for this exact comment (no double-scoring the same comment).
  //    We let the create fail atomically on a race rather than read-then-write.
  const point = {
    threadId,
    commentMessageId: comment.id,
    commenterId: commentAuthor.id,
    commenterTag: commentAuthor.tag,
    threadOwnerId: thread.ownerId,
    isoWeek: isoWeek(),
    awardedAt: serverTimestamp(),
  };

  try {
    // create() throws if the doc already exists, giving us an atomic dedupe even if two
    // reaction events for the same comment arrive concurrently.
    await docRef.create(point);
  } catch (err) {
    if (err.code === 6 /* ALREADY_EXISTS */) {
      return { result: AwardResult.ALREADY_SCORED };
    }
    throw err;
  }

  return { result: AwardResult.AWARDED, point };
}

// Manual point adjustment (mod override for edge cases). Stays inside the event-sourced
// model: a positive amount creates that many point docs (so the leaderboard, which counts
// docs, reflects it); a negative amount deletes up to that many of the user's docs,
// preferring adjustment-sourced ones so genuine earned feedback is removed last. An audit
// doc is always written to `adjustments`, regardless of how many docs actually changed.
//
// Returns { applied, requested, auditId }.
export async function adjustPoints({ targetUserId, targetTag, amount, reason, modId, modTag }) {
  const db = getDb();
  const week = isoWeek();
  const now = Date.now();

  let applied = 0;

  if (amount > 0) {
    const batch = db.batch();
    for (let i = 0; i < amount; i += 1) {
      const id = `adj_${targetUserId}_${now}_${i}`;
      batch.create(pointsRef().doc(id), {
        threadId: '__adjustment__',
        commentMessageId: id,
        commenterId: targetUserId,
        commenterTag: targetTag,
        threadOwnerId: modId,
        isoWeek: week,
        source: 'adjustment',
        reason,
        awardedAt: serverTimestamp(),
      });
      applied += 1;
    }
    await batch.commit();
  } else if (amount < 0) {
    const want = Math.abs(amount);
    // Prefer removing adjustment-sourced docs first, then any others.
    const snap = await pointsRef().where('commenterId', '==', targetUserId).get();
    const docs = snap.docs.sort((a, b) => {
      const as = a.data().source === 'adjustment' ? 0 : 1;
      const bs = b.data().source === 'adjustment' ? 0 : 1;
      return as - bs;
    });
    const toDelete = docs.slice(0, want);
    const batch = db.batch();
    for (const d of toDelete) batch.delete(d.ref);
    await batch.commit();
    applied = toDelete.length;
  }

  // Always record the intent for the audit trail, even if applied < requested.
  const auditRef = db.collection('adjustments').doc();
  await auditRef.set({
    targetUserId,
    targetTag,
    requested: amount,
    applied: amount < 0 ? -applied : applied,
    reason,
    modId,
    modTag,
    isoWeek: week,
    createdAt: serverTimestamp(),
  });

  return { applied, requested: amount, auditId: auditRef.id };
}

// Delete every point doc for a user, returning them to zero. Writes an audit record like
// adjustPoints does, so a reset is as traceable as a manual adjustment.
//
// Milestone markers are NOT touched here — services/milestones.js owns that collection.
// The caller clears both so neither module reaches into the other's data.
//
// Returns { removed, auditId }.
export async function resetPoints({ targetUserId, targetTag, reason, modId, modTag }) {
  const db = getDb();

  const snap = await pointsRef().where('commenterId', '==', targetUserId).get();
  const removed = snap.size;

  // Firestore caps a batch at 500 writes; chunk so a heavy account can't fail the reset.
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    for (const doc of snap.docs.slice(i, i + 400)) batch.delete(doc.ref);
    await batch.commit();
  }

  const auditRef = db.collection('adjustments').doc();
  await auditRef.set({
    targetUserId,
    targetTag,
    kind: 'reset',
    requested: -removed,
    applied: -removed,
    reason,
    modId,
    modTag,
    isoWeek: isoWeek(),
    createdAt: serverTimestamp(),
  });

  return { removed, auditId: auditRef.id };
}

// Revoke a point (reaction removed by the thread owner). Only deletes if the doc exists
// and the remover is the thread owner. Returns true if a point was revoked.
export async function revokePoint({ thread, removerId, commentMessageId }) {
  if (removerId !== thread.ownerId) return false;

  const docRef = pointsRef().doc(pointDocId(thread.threadId, commentMessageId));
  const snap = await docRef.get();
  if (!snap.exists) return false;

  await docRef.delete();
  return true;
}
