// Showcase award rules, enforced in the exact order from the spec. Every branch here
// is an anti-farm guard; getting the order or any check wrong silently breaks scoring.
//
// A point is one document in `points` with a deterministic id `${threadId}_${commentMessageId}`,
// so the same comment can never be scored twice and reaction-remove can find it exactly.

import { getDb, serverTimestamp } from '../firebase.js';
import { isoWeek } from '../lib/week.js';
import { assertScoringPolicy } from '../lib/scoringPolicy.js';

function pointsRef() {
  return getDb().collection('points');
}

function countersRef() {
  return getDb().collection('pointCounters');
}

export function pointDocId(threadId, commentMessageId) {
  return `${threadId}_${commentMessageId}`;
}

export function pointCounterDocId(threadId, commenterId) {
  return `${threadId}_${commenterId}`;
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

const MAX_COUNTER_COUNT = 100_000;

function canonicalPointCount(snapshot) {
  return snapshot.docs.filter((doc) => doc.data().source !== 'adjustment').length;
}

function assertCounter(counter, { threadId, commenterId, expectedCount }) {
  if (
    counter.threadId !== threadId ||
    counter.commenterId !== commenterId ||
    !Number.isInteger(counter.count) ||
    counter.count < 0 ||
    counter.count > MAX_COUNTER_COUNT ||
    (expectedCount != null && counter.count !== expectedCount)
  ) {
    throw new Error(`Invalid or inconsistent point counter for thread=${threadId} commenter=${commenterId}`);
  }
}

function counterData({ threadId, commenterId, count, timestamp }) {
  return { threadId, commenterId, count, updatedAt: timestamp };
}

export function buildPointEvent({ thread, comment, source, timestamp, week = isoWeek() }) {
  return {
    threadId: thread.threadId,
    commentMessageId: comment.id,
    commenterId: comment.author.id,
    commenterTag: comment.author.tag,
    threadOwnerId: thread.ownerId,
    source,
    isoWeek: source === 'live' ? week : null,
    eventAt: source === 'live' ? timestamp : null,
    awardedAt: timestamp,
  };
}

// Transaction core exported for focused tests. The production caller supplies Firestore
// refs/queries; all transaction reads happen before any write.
export async function awardPointTransaction({
  transaction,
  pointRef,
  counterRef,
  existingPointsQuery,
  point,
  cap,
  timestamp,
}) {
  const [existingPoint, counterSnap, existingPoints] = await Promise.all([
    transaction.get(pointRef),
    transaction.get(counterRef),
    transaction.get(existingPointsQuery),
  ]);

  if (existingPoint.exists) return { result: AwardResult.ALREADY_SCORED };

  const existingCount = canonicalPointCount(existingPoints);
  if (counterSnap.exists) {
    assertCounter(counterSnap.data(), {
      threadId: point.threadId,
      commenterId: point.commenterId,
      expectedCount: existingCount,
    });
  }

  // A missing counter is derived from canonical event records in this same transaction.
  // This migrates legacy points without ever treating manual adjustment events as thread
  // feedback. Persist it even when already at cap so the next event avoids another repair.
  if (existingCount >= cap) {
    if (!counterSnap.exists) {
      transaction.set(counterRef, counterData({ ...point, count: existingCount, timestamp }));
    }
    return { result: AwardResult.AT_CAP };
  }

  transaction.create(pointRef, point);
  transaction.set(counterRef, counterData({ ...point, count: existingCount + 1, timestamp }));
  return { result: AwardResult.AWARDED, point };
}

export async function revokePointTransaction({
  transaction,
  pointRef,
  counterRef,
  existingPointsQuery,
  threadId,
  commenterId,
  timestamp,
}) {
  const [pointSnap, counterSnap, existingPoints] = await Promise.all([
    transaction.get(pointRef),
    transaction.get(counterRef),
    transaction.get(existingPointsQuery),
  ]);

  if (!pointSnap.exists) return false;

  const existingCount = canonicalPointCount(existingPoints);
  if (existingCount < 1) {
    throw new Error(`Inconsistent points query while revoking thread=${threadId} commenter=${commenterId}`);
  }
  if (counterSnap.exists) {
    assertCounter(counterSnap.data(), { threadId, commenterId, expectedCount: existingCount });
  }

  transaction.delete(pointRef);
  transaction.set(counterRef, counterData({ threadId, commenterId, count: existingCount - 1, timestamp }));
  return true;
}

async function revokeCanonicalPointByRef({ pointRef, threadId, commenterId }) {
  const db = getDb();
  const counterRef = countersRef().doc(pointCounterDocId(threadId, commenterId));
  const existingPointsQuery = pointsRef()
    .where('threadId', '==', threadId)
    .where('commenterId', '==', commenterId);
  return db.runTransaction((transaction) => revokePointTransaction({
    transaction,
    pointRef,
    counterRef,
    existingPointsQuery,
    threadId,
    commenterId,
    timestamp: serverTimestamp(),
  }));
}

// Award a point for a helpful tick if and only if every rule passes, checked in order.
//
//   thread:     the registered `threads` doc data (has ownerId).
//   reactorId:  the user who added the reaction.
//   comment:    the discord.js Message that was reacted to (the comment being marked).
//   cfg:        effective config (minCommentLength, maxPointsPerThreadPerUser).
//
// Returns { result, point? }.
export async function tryAwardPoint({ thread, reactorId, comment, cfg, source = 'live' }) {
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

  assertScoringPolicy(cfg, 'effective scoring policy');
  if (source !== 'live' && source !== 'rescan') {
    throw new Error(`Unsupported point source: ${source}`);
  }

  const db = getDb();
  const docId = pointDocId(threadId, comment.id);
  const docRef = pointsRef().doc(docId);
  const counterRef = countersRef().doc(pointCounterDocId(threadId, commentAuthor.id));
  const existingPointsQuery = pointsRef()
    .where('threadId', '==', threadId)
    .where('commenterId', '==', commentAuthor.id);

  // 5-6. The cap and deterministic-event dedupe share one transaction. The counter is
  // checked against canonical point docs, making stale/corrupt counters fail closed.
  const point = buildPointEvent({
    thread,
    comment,
    source,
    // Recovery time is intentionally awardedAt only for rescans; it must not invent a
    // historical event time or weekly period.
    timestamp: serverTimestamp(),
  });
  return db.runTransaction((transaction) => awardPointTransaction({
    transaction,
    pointRef: docRef,
    counterRef,
    existingPointsQuery,
    point,
    cap: cfg.maxPointsPerThreadPerUser,
    timestamp: serverTimestamp(),
  }));
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
    for (const d of toDelete) {
      const data = d.data();
      if (data.source === 'adjustment') {
        await d.ref.delete();
        applied += 1;
      } else if (await revokeCanonicalPointByRef({
        pointRef: d.ref,
        threadId: data.threadId,
        commenterId: data.commenterId,
      })) {
        applied += 1;
      }
    }
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

  // Canonical point removals must also update their per-thread counters. Adjustment
  // events have no counter, so they can be deleted directly.
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.source === 'adjustment') {
      await doc.ref.delete();
    } else {
      await revokeCanonicalPointByRef({
        pointRef: doc.ref,
        threadId: data.threadId,
        commenterId: data.commenterId,
      });
    }
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

  const db = getDb();
  const docRef = pointsRef().doc(pointDocId(thread.threadId, commentMessageId));
  return db.runTransaction(async (transaction) => {
    const pointSnap = await transaction.get(docRef);
    if (!pointSnap.exists) return false;
    const commenterId = pointSnap.data().commenterId;
    const counterRef = countersRef().doc(pointCounterDocId(thread.threadId, commenterId));
    const existingPointsQuery = pointsRef()
      .where('threadId', '==', thread.threadId)
      .where('commenterId', '==', commenterId);
    return revokePointTransaction({
      transaction,
      pointRef: docRef,
      counterRef,
      existingPointsQuery,
      threadId: thread.threadId,
      commenterId,
      timestamp: serverTimestamp(),
    });
  });
}
