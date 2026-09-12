import { getDb, serverTimestamp } from '../firebase.js';
import { jamSubmissionDocId } from '../lib/hostedBuilds.js';

function hasAppliedTag(channel, tagId) {
  return Boolean(tagId) && Array.isArray(channel?.appliedTags) && channel.appliedTags.includes(tagId);
}

export async function reconcileJamEligibilityForThread({
  channel,
  db = getDb(),
  timestamp = serverTimestamp(),
}) {
  if (!channel?.id) return { status: 'invalid-thread', updates: [] };
  const threadSnap = await db.collection('threads').doc(channel.id).get();
  if (!threadSnap.exists) return { status: 'unregistered-thread', updates: [] };
  const thread = threadSnap.data();
  if (thread.mode !== 'showcase' || !thread.projectId || !thread.ownerId || thread.threadId !== channel.id) {
    return { status: 'not-project-source', updates: [] };
  }

  const jamsSnap = await db.collection('jams').where('phase', '==', 'active').get();
  const updates = [];
  for (const jamDoc of jamsSnap.docs) {
    const jam = jamDoc.data();
    if (!jam?.submissionTagId) continue;
    const key = jamSubmissionDocId(jamDoc.id, thread.projectId);
    const submissionSnap = await db.collection('jamSubmissions').doc(key).get();
    const submission = submissionSnap.exists ? submissionSnap.data() : null;
    const eligible = Boolean(submission)
      && submission.state === 'submitted'
      && submission.ownerId === thread.ownerId
      && submission.projectId === thread.projectId
      && submission.threadId === channel.id
      && hasAppliedTag(channel, jam.submissionTagId);

    const record = {
      jamId: jamDoc.id,
      projectId: thread.projectId,
      buildId: submission?.buildId ?? null,
      threadId: channel.id,
      ownerId: thread.ownerId,
      eligible,
      reason: eligible
        ? 'eligible'
        : !submission
          ? 'no-submission'
          : !hasAppliedTag(channel, jam.submissionTagId)
            ? 'jam-tag-missing'
            : 'submission-mismatch',
      updatedAt: timestamp,
    };
    await db.collection('jamEligibility').doc(key).set(record, { merge: false });
    updates.push({ key, eligible, reason: record.reason, buildId: record.buildId });
  }
  return { status: 'ok', updates };
}

export async function clearFinishedJamEligibility(jamId, { db = getDb() } = {}) {
  const snapshot = await db.collection('jamEligibility').where('jamId', '==', jamId).get();
  if (snapshot.empty) return 0;
  const batch = db.batch();
  for (const doc of snapshot.docs) batch.delete(doc.ref);
  await batch.commit();
  return snapshot.size;
}
