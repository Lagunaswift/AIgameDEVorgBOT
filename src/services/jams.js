import { getDb, serverTimestamp } from '../firebase.js';
import { phaseTransitionAllowed, qualificationDecision } from '../lib/hostedBuilds.js';

const DISCORD_ID_RE = /^\d{17,20}$/;

function assertDiscordId(value, name) {
  if (typeof value !== 'string' || !DISCORD_ID_RE.test(value)) throw new Error(`${name} must be a Discord ID`);
  return value;
}

export function normalizeJamSetup(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Jam setup is required');
  const title = String(input.title ?? '').trim();
  if (!title || title.length > 120) throw new Error('Jam title is invalid');
  const summary = input.summary == null ? null : String(input.summary).trim();
  if (summary && summary.length > 500) throw new Error('Jam summary is too long');
  return {
    jamId: assertDiscordId(input.jamId, 'jamId'),
    discordThreadId: assertDiscordId(input.discordThreadId, 'discordThreadId'),
    submissionTagId: assertDiscordId(input.submissionTagId, 'submissionTagId'),
    eventsForumId: assertDiscordId(input.eventsForumId, 'eventsForumId'),
    submissionsForumId: assertDiscordId(input.submissionsForumId, 'submissionsForumId'),
    title,
    summary: summary || null,
  };
}

export async function registerJam(input, { db = getDb(), timestamp = serverTimestamp() } = {}) {
  const jam = normalizeJamSetup(input);
  const ref = db.collection('jams').doc(jam.jamId);
  const snap = await ref.get();
  if (snap.exists) throw new Error('Jam is already registered');
  await ref.create({ ...jam, phase: 'upcoming', createdAt: timestamp, updatedAt: timestamp });
  return { ...jam, phase: 'upcoming' };
}

export async function getJam(jamId, { db = getDb() } = {}) {
  const normalized = assertDiscordId(jamId, 'jamId');
  const snap = await db.collection('jams').doc(normalized).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function setJamPhase(jamId, nextPhase, { db = getDb(), timestamp = serverTimestamp() } = {}) {
  const normalized = assertDiscordId(jamId, 'jamId');
  const ref = db.collection('jams').doc(normalized);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new Error('Jam is not registered');
    const jam = snap.data();
    if (!phaseTransitionAllowed(jam.phase, nextPhase)) throw new Error(`Jam cannot move from ${jam.phase} to ${nextPhase}`);
    const update = { phase: nextPhase, updatedAt: timestamp };
    if (nextPhase === 'active') update.openedAt = timestamp;
    if (nextPhase === 'voting') update.votingStartedAt = timestamp;
    if (nextPhase === 'finished') update.finishedAt = timestamp;
    transaction.update(ref, update);
    return { ...jam, ...update };
  });
}

export async function lockQualifiedJamSubmissions(jamId, { db = getDb(), timestamp = serverTimestamp() } = {}) {
  const jam = await getJam(jamId, { db });
  if (!jam) throw new Error('Jam is not registered');
  if (jam.phase !== 'voting') throw new Error('Jam must be in voting phase before submissions are locked');

  const snapshot = await db.collection('jamSubmissions').where('jamId', '==', jam.id).get();
  const results = [];
  for (const doc of snapshot.docs) {
    const submission = { id: doc.id, ...doc.data() };
    if (submission.state !== 'submitted') {
      results.push({ submissionId: doc.id, status: 'skipped', reason: 'submission-state' });
      continue;
    }
    const [projectSnap, buildSnap, buildStateSnap] = await Promise.all([
      db.collection('projects').doc(submission.projectId).get(),
      db.collection('projectBuilds').doc(submission.buildId).get(),
      db.collection('projectBuildState').doc(submission.projectId).get(),
    ]);
    const project = projectSnap.exists ? { id: projectSnap.id, ...projectSnap.data() } : null;
    const build = buildSnap.exists ? { id: buildSnap.id, ...buildSnap.data() } : null;
    const buildState = buildStateSnap.exists ? buildStateSnap.data() : {};
    const decision = qualificationDecision({
      project,
      build,
      submission,
      moderatorApproved: buildState.moderationApproved === true,
      jamPhase: jam.phase,
    });
    if (!decision.qualified) {
      results.push({ submissionId: doc.id, status: 'blocked', reason: decision.reason });
      continue;
    }
    await doc.ref.update({ state: 'locked', lockedAt: timestamp, updatedAt: timestamp });
    results.push({ submissionId: doc.id, status: 'locked', buildId: submission.buildId });
  }
  return results;
}

export async function jamStatus(jamId, { db = getDb() } = {}) {
  const jam = await getJam(jamId, { db });
  if (!jam) return null;
  const snapshot = await db.collection('jamSubmissions').where('jamId', '==', jam.id).get();
  const counts = { total: 0, submitted: 0, locked: 0, withdrawn: 0, disqualified: 0, finished: 0 };
  for (const doc of snapshot.docs) {
    counts.total += 1;
    const state = doc.data()?.state;
    if (Object.hasOwn(counts, state)) counts[state] += 1;
  }
  return { jam, counts };
}
