import { FieldValue, Timestamp, getDb } from '../firebase.js';
import { canLockJamSubmission, canTransitionJamPhase, deriveJamEligibility, makeJamRecord } from '../lib/hostedPlatform.js';

function jamRef(jamId) {
  return getDb().collection('jams').doc(jamId);
}

function phaseTimestampUpdate(nextPhase, now) {
  if (nextPhase === 'active') return { openedAt: now };
  if (nextPhase === 'voting') return { votingStartedAt: now };
  if (nextPhase === 'finished') return { finishedAt: now };
  return {};
}

export async function registerJam(input) {
  const record = makeJamRecord(input);
  const now = Timestamp.now();
  const ref = jamRef(record.jamId);
  await getDb().runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) throw new Error('Jam is already registered.');
    transaction.create(ref, { ...record, createdAt: now, updatedAt: now });
  });
  return record;
}

export async function getJam(jamId) {
  const snap = await jamRef(jamId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function setJamPhase(jamId, nextPhase) {
  const db = getDb();
  const ref = jamRef(jamId);
  const [jamSnap, submissionsSnap] = await Promise.all([
    ref.get(),
    db.collection('jamSubmissions').where('jamId', '==', jamId).get(),
  ]);
  if (!jamSnap.exists) return { status: 'missing' };
  const jam = jamSnap.data();
  if (!canTransitionJamPhase(jam.phase, nextPhase)) return { status: 'state', from: jam.phase, to: nextPhase };
  if (submissionsSnap.size > 450) return { status: 'too-many-submissions' };

  const now = Timestamp.now();
  const batch = db.batch();
  batch.update(ref, { phase: nextPhase, ...phaseTimestampUpdate(nextPhase, now), updatedAt: now });

  let locked = 0;
  let finished = 0;
  if (nextPhase === 'voting') {
    for (const doc of submissionsSnap.docs) {
      const submission = doc.data();
      if (canLockJamSubmission({ phase: 'voting' }, submission)) {
        batch.update(doc.ref, { state: 'locked', lockedAt: now, updatedAt: now });
        locked += 1;
      }
    }
  } else if (nextPhase === 'finished') {
    for (const doc of submissionsSnap.docs) {
      const submission = doc.data();
      if (submission?.state === 'locked') {
        batch.update(doc.ref, { state: 'finished', updatedAt: now });
        finished += 1;
      }
    }
  }

  await batch.commit();
  return { status: 'ok', phase: nextPhase, locked, finished };
}

async function markExistingEligibilityUnavailable(threadId, reason) {
  const snap = await getDb().collection('jamEligibility').where('threadId', '==', threadId).get();
  if (snap.empty) return 0;
  const batch = getDb().batch();
  const now = Timestamp.now();
  for (const doc of snap.docs) batch.set(doc.ref, { eligible: false, reason, updatedAt: now }, { merge: true });
  await batch.commit();
  return snap.size;
}

export async function syncThreadJamEligibility(thread) {
  if (!thread?.id) return { status: 'ignored', reason: 'missing-thread-id' };
  const db = getDb();
  const threadRef = db.collection('threads').doc(thread.id);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) return { status: 'ignored', reason: 'unregistered-thread' };
  const storedThread = threadSnap.data();
  const projectId = storedThread?.projectId;
  if (!projectId) {
    const cleared = await markExistingEligibilityUnavailable(thread.id, 'project-unlinked');
    return { status: 'ok', eligible: 0, ineligible: cleared };
  }

  const [projectSnap, jamsSnap] = await Promise.all([
    db.collection('projects').doc(projectId).get(),
    db.collection('jams').get(),
  ]);
  if (!projectSnap.exists) {
    const cleared = await markExistingEligibilityUnavailable(thread.id, 'project-missing');
    return { status: 'ok', eligible: 0, ineligible: cleared };
  }

  const project = { id: projectSnap.id, ...projectSnap.data() };
  const liveThread = {
    threadId: thread.id,
    forumId: thread.parentId ?? storedThread.forumId ?? null,
    ownerId: storedThread.ownerId,
    projectId,
    appliedTags: Array.isArray(thread.appliedTags) ? [...thread.appliedTags] : [],
  };
  const now = Timestamp.now();
  const batch = db.batch();
  batch.set(threadRef, { appliedTags: liveThread.appliedTags, forumId: liveThread.forumId, updatedAt: now }, { merge: true });

  let eligible = 0;
  let ineligible = 0;
  for (const doc of jamsSnap.docs) {
    const jam = { jamId: doc.id, ...doc.data() };
    const derived = deriveJamEligibility({ jam, thread: liveThread, project });
    const ref = db.collection('jamEligibility').doc(`${doc.id}_${projectId}`);
    if (derived.eligible) {
      batch.set(ref, { ...derived, updatedAt: now }, { merge: false });
      eligible += 1;
    } else {
      batch.set(ref, {
        jamId: doc.id,
        projectId,
        threadId: liveThread.threadId,
        ownerId: project.ownerId,
        eligible: false,
        reason: derived.reason,
        updatedAt: now,
      }, { merge: false });
      ineligible += 1;
    }
  }
  await batch.commit();
  return { status: 'ok', eligible, ineligible };
}

export async function jamStatus(jamId) {
  const db = getDb();
  const [jamSnap, submissionsSnap, eligibilitySnap] = await Promise.all([
    jamRef(jamId).get(),
    db.collection('jamSubmissions').where('jamId', '==', jamId).get(),
    db.collection('jamEligibility').where('jamId', '==', jamId).get(),
  ]);
  if (!jamSnap.exists) return null;
  const submissions = submissionsSnap.docs.map((doc) => doc.data());
  return {
    jam: { id: jamSnap.id, ...jamSnap.data() },
    submissions: submissions.length,
    submitted: submissions.filter((value) => value.state === 'submitted').length,
    locked: submissions.filter((value) => value.state === 'locked').length,
    finished: submissions.filter((value) => value.state === 'finished').length,
    withdrawn: submissions.filter((value) => value.state === 'withdrawn').length,
    disqualified: submissions.filter((value) => value.state === 'disqualified').length,
    eligibleProjects: eligibilitySnap.docs.filter((doc) => doc.data()?.eligible === true).length,
  };
}
