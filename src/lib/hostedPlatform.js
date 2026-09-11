const SNOWFLAKE_RE = /^\d{17,20}$/;
const PROJECT_ID_RE = /^[^/]{1,1500}$/;
const BUILD_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export const JAM_PHASES = Object.freeze(['upcoming', 'active', 'voting', 'finished']);

const JAM_PHASE_TRANSITIONS = Object.freeze({
  upcoming: new Set(['active']),
  active: new Set(['voting']),
  voting: new Set(['finished']),
  finished: new Set(),
});

export function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE_RE.test(value);
}

export function isProjectId(value) {
  return typeof value === 'string' && PROJECT_ID_RE.test(value);
}

export function isBuildId(value) {
  return typeof value === 'string' && BUILD_ID_RE.test(value);
}

export function canTransitionJamPhase(from, to) {
  return JAM_PHASE_TRANSITIONS[from]?.has(to) ?? false;
}

export function makeJamRecord({
  jamId,
  discordThreadId,
  submissionTagId,
  eventsForumId,
  submissionsForumId,
  title,
  summary = null,
  phase = 'upcoming',
}) {
  if (![jamId, discordThreadId, submissionTagId, eventsForumId, submissionsForumId].every(isSnowflake)) {
    throw new Error('Jam identifiers must be Discord snowflakes.');
  }
  if (jamId !== discordThreadId) throw new Error('V1 Jam identity must be the exact Discord event thread ID.');
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) throw new Error('Jam title is invalid.');
  if (summary !== null && (typeof summary !== 'string' || summary.trim().length > 500)) throw new Error('Jam summary is invalid.');
  if (!JAM_PHASES.includes(phase)) throw new Error('Jam phase is invalid.');
  return {
    jamId,
    discordThreadId,
    submissionTagId,
    eventsForumId,
    submissionsForumId,
    title: title.trim(),
    summary: summary?.trim() || null,
    phase,
  };
}

export function deriveJamEligibility({ jam, thread, project }) {
  if (!jam || !thread || !project) return { eligible: false, reason: 'missing-record' };
  if (!isSnowflake(jam.jamId) || !isSnowflake(jam.submissionTagId) || !isSnowflake(jam.submissionsForumId)) {
    return { eligible: false, reason: 'invalid-jam' };
  }
  if (!isProjectId(project.id) || project.profileThreadId !== thread.threadId) {
    return { eligible: false, reason: 'project-thread-mismatch' };
  }
  if (thread.projectId !== project.id || thread.ownerId !== project.ownerId) {
    return { eligible: false, reason: 'thread-project-mismatch' };
  }
  if (thread.forumId !== jam.submissionsForumId) return { eligible: false, reason: 'wrong-forum' };
  if (!['upcoming', 'active'].includes(jam.phase)) return { eligible: false, reason: 'jam-not-open' };
  const tags = Array.isArray(thread.appliedTags) ? thread.appliedTags : [];
  if (!tags.includes(jam.submissionTagId)) return { eligible: false, reason: 'jam-tag-missing' };
  return {
    eligible: true,
    reason: 'eligible',
    jamId: jam.jamId,
    projectId: project.id,
    threadId: thread.threadId,
    ownerId: project.ownerId,
  };
}

export function runtimeReconciliationDecision({ project, buildState, build, approved }) {
  const requestedBuildId = buildState?.requestedBuildId;
  const publishedBuildId = buildState?.publishedBuildId;

  if (!project || project.publishToSite !== true || !requestedBuildId) {
    return publishedBuildId
      ? { action: 'revoke', buildId: publishedBuildId, reason: 'owner-publication-disabled' }
      : { action: 'none', reason: 'no-publication-intent' };
  }
  if (!approved) {
    return publishedBuildId
      ? { action: 'revoke', buildId: publishedBuildId, reason: 'moderator-approval-missing' }
      : { action: 'none', reason: 'moderator-approval-missing' };
  }
  if (!build || build.buildId !== requestedBuildId || build.projectId !== project.id || build.ownerId !== project.ownerId) {
    return publishedBuildId
      ? { action: 'revoke', buildId: publishedBuildId, reason: 'requested-build-invalid' }
      : { action: 'none', reason: 'requested-build-invalid' };
  }
  if (build.status !== 'ready') {
    return publishedBuildId
      ? { action: 'revoke', buildId: publishedBuildId, reason: 'requested-build-not-ready' }
      : { action: 'none', reason: 'requested-build-not-ready' };
  }
  if (build.runtimeState === 'disabled') {
    return publishedBuildId
      ? { action: 'revoke', buildId: publishedBuildId, reason: 'build-disabled' }
      : { action: 'none', reason: 'build-disabled' };
  }
  if (publishedBuildId === requestedBuildId && build.runtimeState === 'public') {
    return { action: 'none', reason: 'already-public' };
  }
  return { action: 'publish', buildId: requestedBuildId, previousBuildId: publishedBuildId || null, reason: 'approved' };
}

export function canLockJamSubmission(jam, submission) {
  return jam?.phase === 'voting' && submission?.state === 'submitted' && isBuildId(submission?.buildId);
}
