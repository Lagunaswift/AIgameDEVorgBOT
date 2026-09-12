export const HOSTED_RUNTIME_STATES = Object.freeze(['private', 'requested', 'public', 'revoked']);
export const HOSTED_BUILD_STATUSES = Object.freeze(['uploading', 'uploaded', 'validating', 'ready', 'failed', 'disabled', 'deleted']);
export const JAM_PHASES = Object.freeze(['upcoming', 'active', 'voting', 'finished']);
export const JAM_SUBMISSION_STATES = Object.freeze(['draft', 'submitted', 'withdrawn', 'locked', 'disqualified', 'finished']);

export function runtimeDecision({ project, build, moderatorApproved }) {
  if (!project || !build) return { action: 'none', reason: 'missing' };
  if (build.status !== 'ready') return { action: 'none', reason: 'build-not-ready' };

  if (!moderatorApproved || project.publishToSite !== true) {
    if (build.runtimeState === 'public' || build.runtimeState === 'requested') {
      return { action: 'revoke', reason: moderatorApproved ? 'owner-private' : 'moderator-withheld' };
    }
    return { action: 'none', reason: moderatorApproved ? 'owner-private' : 'moderator-withheld' };
  }

  if (build.runtimeState === 'requested' || build.runtimeState === 'revoked') {
    return { action: 'publish', reason: 'approved' };
  }
  return { action: 'none', reason: build.runtimeState === 'public' ? 'already-public' : 'not-requested' };
}

export function qualificationDecision({ project, build, submission, moderatorApproved, jamPhase }) {
  if (!project || !build || !submission) return { qualified: false, reason: 'missing' };
  if (submission.state !== 'submitted') return { qualified: false, reason: 'submission-state' };
  if (jamPhase !== 'active' && jamPhase !== 'voting') return { qualified: false, reason: 'jam-phase' };
  if (!moderatorApproved || project.publishToSite !== true) return { qualified: false, reason: 'publication-approval' };
  if (build.status !== 'ready' || build.runtimeState === 'revoked') return { qualified: false, reason: 'build-state' };
  if (submission.projectId !== project.projectId && submission.projectId !== project.id) return { qualified: false, reason: 'project-link' };
  if (submission.buildId !== build.buildId && submission.buildId !== build.id) return { qualified: false, reason: 'build-link' };
  return { qualified: true, reason: 'qualified' };
}

export function phaseTransitionAllowed(from, to) {
  const transitions = {
    upcoming: new Set(['active']),
    active: new Set(['voting']),
    voting: new Set(['finished']),
    finished: new Set(),
  };
  return transitions[from]?.has(to) ?? false;
}

export function submissionTransitionAllowed(from, to) {
  const transitions = {
    draft: new Set(['submitted', 'withdrawn']),
    submitted: new Set(['withdrawn', 'locked', 'disqualified']),
    withdrawn: new Set(),
    locked: new Set(['finished', 'disqualified']),
    disqualified: new Set(),
    finished: new Set(),
  };
  return transitions[from]?.has(to) ?? false;
}

export function jamSubmissionDocId(jamId, projectId) {
  if (!/^\d{17,20}$/.test(String(jamId ?? ''))) throw new Error('Invalid jamId');
  if (typeof projectId !== 'string' || !projectId || projectId.includes('/')) throw new Error('Invalid projectId');
  return `${jamId}_${projectId}`;
}
