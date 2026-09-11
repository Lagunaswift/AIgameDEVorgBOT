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

function validOwnedReadyBuild(build, project) {
  return build?.status === 'ready'
    && isBuildId(build?.buildId)
    && build?.projectId === project?.id
    && build?.ownerId === project?.ownerId;
}

export function runtimeReconciliationPlan({
  project,
  buildState,
  builds = [],
  submissions = [],
  jams = [],
  eligibilities = [],
  approved,
}) {
  const buildById = new Map(builds.filter((build) => isBuildId(build?.buildId)).map((build) => [build.buildId, build]));
  const jamById = new Map(jams.filter((jam) => isSnowflake(jam?.jamId)).map((jam) => [jam.jamId, jam]));
  const eligibilityByKey = new Map(eligibilities.map((value) => [`${value?.jamId}_${value?.projectId}`, value]));
  const desired = new Set();

  if (project?.publishToSite === true && approved === true) {
    const requested = buildById.get(buildState?.requestedBuildId);
    if (validOwnedReadyBuild(requested, project)) desired.add(requested.buildId);

    for (const submission of submissions) {
      if (submission?.projectId !== project.id || submission?.ownerId !== project.ownerId || !isBuildId(submission?.buildId)) continue;
      const build = buildById.get(submission.buildId);
      if (!validOwnedReadyBuild(build, project)) continue;
      const jam = jamById.get(submission.jamId);
      if (!jam) continue;

      let publicJamReference = false;
      if (submission.state === 'submitted' && jam.phase === 'active') {
        const eligibility = eligibilityByKey.get(`${submission.jamId}_${project.id}`);
        publicJamReference = eligibility?.eligible === true
          && eligibility?.threadId === project.profileThreadId
          && eligibility?.ownerId === project.ownerId;
      } else if (submission.state === 'locked' && jam.phase === 'voting') {
        publicJamReference = true;
      } else if (submission.state === 'finished' && jam.phase === 'finished') {
        publicJamReference = true;
      }
      if (publicJamReference) desired.add(build.buildId);
    }
  }

  const actual = new Set(
    builds
      .filter((build) => build?.projectId === project?.id && build?.ownerId === project?.ownerId && build?.runtimeState === 'public' && isBuildId(build?.buildId))
      .map((build) => build.buildId),
  );
  const enable = [...desired].filter((id) => !actual.has(id)).sort();
  const disable = [...actual].filter((id) => !desired.has(id)).sort();
  const primary = desired.has(buildState?.requestedBuildId) ? buildState.requestedBuildId : null;
  return {
    desired: [...desired].sort(),
    actual: [...actual].sort(),
    enable,
    disable,
    primaryPublishedBuildId: primary,
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
    const reason = build.status === 'disabled' ? 'build-disabled' : 'requested-build-not-ready';
    return publishedBuildId
      ? { action: 'revoke', buildId: publishedBuildId, reason }
      : { action: 'none', reason };
  }
  if (publishedBuildId === requestedBuildId && build.runtimeState === 'public') {
    return { action: 'none', reason: 'already-public' };
  }
  return { action: 'publish', buildId: requestedBuildId, previousBuildId: publishedBuildId || null, reason: 'approved' };
}

export function canLockJamSubmission(jam, submission) {
  return jam?.phase === 'voting' && submission?.state === 'submitted' && isBuildId(submission?.buildId);
}
