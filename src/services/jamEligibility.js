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

export async function reconcileAllActiveJamEligibility(client, { db = getDb() } = {}) {
  const jamsSnap = await db.collection('jams').where('phase', '==', 'active').get();
  if (jamsSnap.empty) return { checked: 0, eligible: 0, blocked: 0, errors: [] };
  const activeJamIds = new Set(jamsSnap.docs.map((doc) => doc.id));
  const submissionsSnap = await db.collection('jamSubmissions').where('state', '==', 'submitted').get();
  let checked = 0;
  let eligible = 0;
  let blocked = 0;
  const errors = [];

  for (const doc of submissionsSnap.docs) {
    const submission = doc.data();
    if (!activeJamIds.has(submission.jamId)) continue;
    checked += 1;
    try {
      const channel = await client.channels.fetch(submission.threadId, { force: true });
      if (!channel?.isThread?.()) throw new Error('source thread unavailable');
      const result = await reconcileJamEligibilityForThread({ channel, db });
      const entry = result.updates.find((item) => item.key === doc.id);
      if (entry?.eligible) eligible += 1;
      else blocked += 1;
    } catch (error) {
      blocked += 1;
      errors.push({ submissionId: doc.id, error: error.message });
      await db.collection('jamEligibility').doc(doc.id).set({
        jamId: submission.jamId,
        projectId: submission.projectId,
        buildId: submission.buildId,
        threadId: submission.threadId,
        ownerId: submission.ownerId,
        eligible: false,
        reason: 'source-thread-unavailable',
        updatedAt: serverTimestamp(),
      }, { merge: false });
    }
  }
  return { checked, eligible, blocked, errors };
}

export async function clearFinishedJamEligibility(jamId, { db = getDb() } = {}) {
  const snapshot = await db.collection('jamEligibility').where('jamId', '==', jamId).get();
  if (snapshot.empty) return 0;
  const batch = db.batch();
  for (const doc of snapshot.docs) batch.delete(doc.ref);
  await batch.commit();
  return snapshot.size;
}
