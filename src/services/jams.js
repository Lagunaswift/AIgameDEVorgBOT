import { getDb, serverTimestamp } from '../firebase.js';
import { discordJamPhaseDecision, phaseTransitionAllowed, qualificationDecision } from '../lib/hostedBuilds.js';

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
    jam: {
      jamId: assertDiscordId(input.jamId, 'jamId'),
      discordThreadId: assertDiscordId(input.discordThreadId, 'discordThreadId'),
      submissionTagId: assertDiscordId(input.submissionTagId, 'submissionTagId'),
      eventsForumId: assertDiscordId(input.eventsForumId, 'eventsForumId'),
      submissionsForumId: assertDiscordId(input.submissionsForumId, 'submissionsForumId'),
      title,
      summary: summary || null,
    },
    discordConfig: {
      activeTagId: assertDiscordId(input.activeTagId, 'activeTagId'),
      votingTagId: assertDiscordId(input.votingTagId, 'votingTagId'),
      finishedTagId: assertDiscordId(input.finishedTagId, 'finishedTagId'),
    },
  };
}

export async function registerJam(input, { db = getDb(), timestamp = serverTimestamp() } = {}) {
  const { jam, discordConfig } = normalizeJamSetup(input);
  const jamRef = db.collection('jams').doc(jam.jamId);
  const configRef = db.collection('jamDiscordConfig').doc(jam.jamId);
  await db.runTransaction(async (transaction) => {
    const [jamSnap, configSnap] = await transaction.getAll(jamRef, configRef);
    if (jamSnap.exists || configSnap.exists) throw new Error('Jam is already registered');
    transaction.create(jamRef, { ...jam, phase: 'upcoming', createdAt: timestamp, updatedAt: timestamp });
    transaction.create(configRef, { jamId: jam.jamId, ...discordConfig, createdAt: timestamp, updatedAt: timestamp });
  });
  return { ...jam, phase: 'upcoming', discordConfig };
}

export async function getJam(jamId, { db = getDb() } = {}) {
  const normalized = assertDiscordId(jamId, 'jamId');
  const snap = await db.collection('jams').doc(normalized).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function getJamDiscordConfig(jamId, { db = getDb() } = {}) {
  const normalized = assertDiscordId(jamId, 'jamId');
  const snap = await db.collection('jamDiscordConfig').doc(normalized).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function setJamPhase(jamId, nextPhase, { db = getDb(), timestamp = serverTimestamp() } = {}) {
  const normalized = assertDiscordId(jamId, 'jamId');
  const ref = db.collection('jams').doc(normalized);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new Error('Jam is not registered');
    const jam = snap.data();
    if (jam.phase === nextPhase) return { ...jam, id: ref.id };
    if (!phaseTransitionAllowed(jam.phase, nextPhase)) throw new Error(`Jam cannot move from ${jam.phase} to ${nextPhase}`);
    const update = { phase: nextPhase, updatedAt: timestamp };
    if (nextPhase === 'active') update.openedAt = timestamp;
    if (nextPhase === 'voting') update.votingStartedAt = timestamp;
    if (nextPhase === 'finished') update.finishedAt = timestamp;
    transaction.update(ref, update);
    return { ...jam, ...update, id: ref.id };
  });
}

export async function setJamPhaseFromDiscord(thread, nextPhase, { db = getDb() } = {}) {
  const [jam, discordConfig] = await Promise.all([
    getJam(thread.id, { db }),
    getJamDiscordConfig(thread.id, { db }),
  ]);
  if (!jam || !discordConfig) throw new Error('Jam Discord lifecycle is not configured');
  if (jam.phase !== nextPhase && !phaseTransitionAllowed(jam.phase, nextPhase)) {
    throw new Error(`Jam cannot move from ${jam.phase} to ${nextPhase}`);
  }
  const targetTagId = discordConfig[`${nextPhase}TagId`];
  if (!targetTagId) throw new Error(`No Discord lifecycle tag is configured for ${nextPhase}`);
  const lifecycleTags = new Set([discordConfig.activeTagId, discordConfig.votingTagId, discordConfig.finishedTagId]);
  const preserved = (Array.isArray(thread.appliedTags) ? thread.appliedTags : []).filter((tagId) => !lifecycleTags.has(tagId));
  await thread.setAppliedTags([...preserved, targetTagId], `AIGAMEDEV Jam phase: ${nextPhase}`);
  return setJamPhase(thread.id, nextPhase, { db });
}

export async function reconcileJamPhaseFromThread(thread, { db = getDb() } = {}) {
  if (!thread?.id) return { status: 'invalid-thread' };
  const [jam, discordConfig] = await Promise.all([
    getJam(thread.id, { db }),
    getJamDiscordConfig(thread.id, { db }),
  ]);
  if (!jam || !discordConfig) return { status: 'not-jam' };
  const decision = discordJamPhaseDecision({
    appliedTags: thread.appliedTags,
    activeTagId: discordConfig.activeTagId,
    votingTagId: discordConfig.votingTagId,
    finishedTagId: discordConfig.finishedTagId,
  });
  if (!decision.phase) return { status: 'invalid-tags', reason: decision.reason };
  if (decision.phase === jam.phase) return { status: 'unchanged', phase: jam.phase };
  if (!phaseTransitionAllowed(jam.phase, decision.phase)) {
    return { status: 'blocked-transition', from: jam.phase, to: decision.phase, reason: decision.reason };
  }
  const updated = await setJamPhase(jam.id, decision.phase, { db });
  return { status: 'updated', phase: updated.phase };
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
  const [jam, discordConfig] = await Promise.all([getJam(jamId, { db }), getJamDiscordConfig(jamId, { db })]);
  if (!jam) return null;
  const snapshot = await db.collection('jamSubmissions').where('jamId', '==', jam.id).get();
  const counts = { total: 0, submitted: 0, locked: 0, withdrawn: 0, disqualified: 0, finished: 0 };
  for (const doc of snapshot.docs) {
    counts.total += 1;
    const state = doc.data()?.state;
    if (Object.hasOwn(counts, state)) counts[state] += 1;
  }
  return { jam, discordConfig, counts };
}
