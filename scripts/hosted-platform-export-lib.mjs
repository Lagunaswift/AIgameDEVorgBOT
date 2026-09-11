const BUILD_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const JAM_ID_RE = /^\d{17,20}$/;
const SUBMISSION_STATES = new Set(['submitted', 'locked', 'finished']);
const PHASE_FOR_STATE = Object.freeze({ submitted: 'active', locked: 'voting', finished: 'finished' });
const ORIENTATIONS = new Set(['landscape', 'portrait', 'responsive']);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function safeText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function iso(value) {
  try {
    if (!value) return null;
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

function compatibility(value) {
  const data = record(value) ?? {};
  return {
    mobileSupported: data.mobileSupported === true,
    orientation: ORIENTATIONS.has(data.orientation) ? data.orientation : 'responsive',
    aspectRatio: typeof data.aspectRatio === 'string' && /^[1-9]\d{0,3}:[1-9]\d{0,3}$/.test(data.aspectRatio)
      ? data.aspectRatio
      : null,
  };
}

function publicProjectMap(projectPayload) {
  if (!record(projectPayload) || projectPayload.version !== 1 || !Array.isArray(projectPayload.projects)) {
    throw new Error('Hosted Builds export requires a valid Projects v1 public baseline.');
  }
  const map = new Map();
  for (const project of projectPayload.projects) {
    if (!record(project) || typeof project.id !== 'string' || typeof project.slug !== 'string') continue;
    map.set(project.id, { id: project.id, slug: project.slug, title: typeof project.title === 'string' ? project.title : null });
  }
  return map;
}

function publicJamMap(jamPayload) {
  if (!record(jamPayload) || jamPayload.version !== 2 || !Array.isArray(jamPayload.jams)) {
    throw new Error('Hosted Builds export requires a valid Jams v2 public baseline.');
  }
  const map = new Map();
  for (const jam of jamPayload.jams) {
    if (!record(jam) || !JAM_ID_RE.test(String(jam.id || ''))) continue;
    map.set(jam.id, { id: jam.id, phase: jam.phase });
  }
  return map;
}

export function buildHostedPlatformExport({
  generatedAt,
  projectPayload,
  jamPayload,
  builds,
  buildStates,
  submissions,
  eligibilities,
}) {
  const projects = publicProjectMap(projectPayload);
  const jams = publicJamMap(jamPayload);
  const stateByProject = new Map((buildStates ?? []).map((state) => [state.projectId, state]));
  const eligibilityByKey = new Map((eligibilities ?? []).map((value) => [`${value.jamId}_${value.projectId}`, value]));
  const publicBuilds = [];
  const buildById = new Map();

  for (const build of builds ?? []) {
    if (!record(build) || !BUILD_ID_RE.test(String(build.buildId || ''))) continue;
    if (build.status !== 'ready' || build.runtimeState !== 'public') continue;
    const project = projects.get(build.projectId);
    if (!project) continue;
    if (build.projectId !== project.id) continue;
    const versionLabel = safeText(build.versionLabel, 80) ?? 'Build';
    const state = stateByProject.get(project.id);
    const item = {
      buildId: build.buildId,
      projectId: project.id,
      projectSlug: project.slug,
      versionLabel,
      compatibility: compatibility(build.compatibility),
      primary: state?.publishedBuildId === build.buildId,
      createdAt: iso(build.createdAt),
      validatedAt: iso(build.validatedAt),
    };
    publicBuilds.push(item);
    buildById.set(item.buildId, item);
  }
  publicBuilds.sort((a, b) => a.projectSlug.localeCompare(b.projectSlug) || a.buildId.localeCompare(b.buildId));

  const publicSubmissions = [];
  for (const submission of submissions ?? []) {
    if (!record(submission) || !SUBMISSION_STATES.has(submission.state)) continue;
    if (!JAM_ID_RE.test(String(submission.jamId || '')) || !BUILD_ID_RE.test(String(submission.buildId || ''))) continue;
    const project = projects.get(submission.projectId);
    const build = buildById.get(submission.buildId);
    const jam = jams.get(submission.jamId);
    if (!project || !build || !jam || build.projectId !== project.id) continue;
    if (PHASE_FOR_STATE[submission.state] !== jam.phase) continue;
    if (submission.state === 'submitted') {
      const eligibility = eligibilityByKey.get(`${submission.jamId}_${submission.projectId}`);
      if (eligibility?.eligible !== true
        || eligibility?.threadId !== submission.threadId
        || eligibility?.ownerId !== submission.ownerId) continue;
    }
    publicSubmissions.push({
      jamId: submission.jamId,
      projectId: project.id,
      projectSlug: project.slug,
      buildId: build.buildId,
      state: submission.state,
      submittedAt: iso(submission.submittedAt),
      lockedAt: iso(submission.lockedAt),
    });
  }
  publicSubmissions.sort((a, b) => a.jamId.localeCompare(b.jamId) || a.projectSlug.localeCompare(b.projectSlug));

  return {
    version: 1,
    generatedAt,
    builds: publicBuilds,
    jamSubmissions: publicSubmissions,
  };
}
