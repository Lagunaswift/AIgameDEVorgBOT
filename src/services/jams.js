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

function exactEligibility(eligibility, jam, submission) {
  return Boolean(eligibility)
    && eligibility.eligible === true
    && eligibility.jamId === jam.id
    && eligibility.projectId === submission.projectId
    && eligibility.buildId === submission.buildId
    && eligibility.threadId === submission.threadId
    && eligibility.ownerId === submission.ownerId;
}

function eligibilityBlockReason(eligibility, jam, submission) {
  if (exactEligibility(eligibility, jam, submission)) return null;
  if (eligibility?.eligible === true) return 'jam-eligibility-mismatch';
  return eligibility?.reason || 'jam-eligibility-missing';
}

async function submissionEvidence(db, jam, submission) {
  const key = `${jam.id}_${submission.projectId}`;
  const [projectSnap, buildSnap, buildStateSnap, eligibilitySnap] = await Promise.all([
    db.collection('projects').doc(submission.projectId).get(),
    db.collection('projectBuilds').doc(submission.buildId).get(),
    db.collection('projectBuildState').doc(submission.projectId).get(),
    db.collection('jamEligibility').doc(key).get(),
  ]);
  return {
    project: projectSnap.exists ? { id: projectSnap.id, ...projectSnap.data() } : null,
    build: buildSnap.exists ? { id: buildSnap.id, ...buildSnap.data() } : null,
    buildState: buildStateSnap.exists ? buildStateSnap.data() : {},
    eligibility: eligibilitySnap.exists ? eligibilitySnap.data() : null,
  };
}

export function jamReviewDecision({ jam, submission, project, build, buildState, eligibility }) {
  if (submission.state === 'locked') return { status: 'locked', reasons: [] };
  if (submission.state !== 'submitted') return { status: 'excluded', reasons: [`submission-${submission.state || 'unknown'}`] };

  const reasons = [];
  const eligibilityReason = eligibilityBlockReason(eligibility, jam, submission);
  if (eligibilityReason) reasons.push(eligibilityReason);
  if (!project) reasons.push('project-missing');
  else if (project.publishToSite !== true) reasons.push('owner-publication-off');
  if (buildState?.moderationApproved !== true) reasons.push('moderator-approval-missing');
  if (!build) reasons.push('build-missing');
  else if (build.status !== 'ready') reasons.push(`build-${build.status || 'unknown'}`);
  else if (build.runtimeState === 'revoked') reasons.push('build-revoked');

  return reasons.length
    ? { status: 'blocked', reasons: [...new Set(reasons)] }
    : { status: 'ready', reasons: [] };
}

export async function jamReviewQueue(jamId, { db = getDb() } = {}) {
  const jam = await getJam(jamId, { db });
  if (!jam) throw new Error('Jam is not registered');
  const snapshot = await db.collection('jamSubmissions').where('jamId', '==', jam.id).get();
  const entries = [];
  for (const doc of snapshot.docs) {
    const submission = { id: doc.id, ...doc.data() };
    const evidence = await submissionEvidence(db, jam, submission);
    const decision = jamReviewDecision({ jam, submission, ...evidence });
    entries.push({
      submissionId: doc.id,
      projectId: submission.projectId,
      buildId: submission.buildId,
      threadId: submission.threadId,
      state: submission.state,
      ...decision,
    });
  }
  const counts = { total: entries.length, ready: 0, blocked: 0, locked: 0, excluded: 0 };
  for (const entry of entries) counts[entry.status] += 1;
  entries.sort((a, b) => a.status.localeCompare(b.status) || String(a.projectId).localeCompare(String(b.projectId)));
  return { jam, counts, entries };
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
    const evidence = await submissionEvidence(db, jam, submission);
    const eligibilityReason = eligibilityBlockReason(evidence.eligibility, jam, submission);
    if (eligibilityReason) {
      results.push({ submissionId: doc.id, status: 'blocked', reason: eligibilityReason });
      continue;
    }
    const decision = qualificationDecision({
      project: evidence.project,
      build: evidence.build,
      submission,
      moderatorApproved: evidence.buildState.moderationApproved === true,
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
