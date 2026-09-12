const PUBLIC_SUBMISSION_STATES = new Set(['submitted', 'locked', 'finished']);

function toIso(value) {
  if (value == null) return null;
  try {
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    if (typeof value.toMillis === 'function') return new Date(value.toMillis()).toISOString();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

function projectMap(projectDocs) {
  const map = new Map();
  for (const doc of projectDocs) {
    const data = doc.data ? doc.data() : doc;
    const id = doc.id ?? data.projectId;
    if (!id || data.projectId !== id || data.publishToSite !== true || typeof data.slug !== 'string' || !data.slug) continue;
    map.set(id, { id, ...data });
  }
  return map;
}

function stateMap(stateDocs) {
  const map = new Map();
  for (const doc of stateDocs) {
    const data = doc.data ? doc.data() : doc;
    const id = doc.id ?? data.projectId;
    if (id) map.set(id, data);
  }
  return map;
}

function buildMap(buildDocs) {
  const map = new Map();
  for (const doc of buildDocs) {
    const data = doc.data ? doc.data() : doc;
    const id = doc.id ?? data.buildId;
    if (id) map.set(id, { id, ...data });
  }
  return map;
}

function eligibilityMap(eligibilityDocs) {
  const map = new Map();
  for (const doc of eligibilityDocs) {
    const data = doc.data ? doc.data() : doc;
    map.set(doc.id ?? data.id, data);
  }
  return map;
}

function jamMap(jamDocs) {
  const map = new Map();
  for (const doc of jamDocs) {
    const data = doc.data ? doc.data() : doc;
    const id = doc.id ?? data.jamId;
    if (id) map.set(id, { id, ...data });
  }
  return map;
}

export function buildHostedBuildsExport({
  projectDocs = [],
  buildDocs = [],
  buildStateDocs = [],
  submissionDocs = [],
  eligibilityDocs = [],
  jamDocs = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const projects = projectMap(projectDocs);
  const states = stateMap(buildStateDocs);
  const allBuilds = buildMap(buildDocs);
  const eligibilities = eligibilityMap(eligibilityDocs);
  const jams = jamMap(jamDocs);
  const publicBuilds = new Map();

  const referencedBuildIds = new Set();
  for (const [projectId, state] of states) {
    if (state.publishedBuildId) referencedBuildIds.add(state.publishedBuildId);
  }
  for (const doc of submissionDocs) {
    const data = doc.data ? doc.data() : doc;
    if (PUBLIC_SUBMISSION_STATES.has(data.state) && data.buildId) referencedBuildIds.add(data.buildId);
  }

  for (const buildId of referencedBuildIds) {
    const build = allBuilds.get(buildId);
    if (!build || build.buildId !== buildId || build.status !== 'ready' || build.runtimeState !== 'public') continue;
    const project = projects.get(build.projectId);
    if (!project) continue;
    const state = states.get(build.projectId) ?? {};
    publicBuilds.set(buildId, {
      buildId,
      projectId: build.projectId,
      projectSlug: project.slug,
      versionLabel: String(build.versionLabel ?? '').trim(),
      compatibility: build.compatibility,
      primary: state.publishedBuildId === buildId,
      createdAt: toIso(build.createdAt),
      validatedAt: toIso(build.validatedAt),
    });
  }

  const jamSubmissions = [];
  const seen = new Set();
  for (const doc of submissionDocs) {
    const submission = doc.data ? doc.data() : doc;
    if (!PUBLIC_SUBMISSION_STATES.has(submission.state)) continue;
    const key = `${submission.jamId}_${submission.projectId}`;
    if (seen.has(key)) throw new Error(`duplicate public Jam submission ${key}`);
    const project = projects.get(submission.projectId);
    const build = publicBuilds.get(submission.buildId);
    const jam = jams.get(submission.jamId);
    if (!project || !build || !jam) continue;

    if (submission.state === 'submitted') {
      if (jam.phase !== 'active') continue;
      const eligibility = eligibilities.get(key);
      if (!eligibility || eligibility.eligible !== true
        || eligibility.projectId !== submission.projectId
        || eligibility.buildId !== submission.buildId
        || eligibility.threadId !== submission.threadId) continue;
    } else if (submission.state === 'locked') {
      if (jam.phase !== 'voting') continue;
    } else if (submission.state === 'finished') {
      if (jam.phase !== 'finished') continue;
    }

    seen.add(key);
    jamSubmissions.push({
      jamId: submission.jamId,
      projectId: submission.projectId,
      projectSlug: project.slug,
      buildId: submission.buildId,
      state: submission.state,
      submittedAt: toIso(submission.submittedAt),
      lockedAt: toIso(submission.lockedAt),
    });
  }

  const builds = [...publicBuilds.values()].sort((a, b) => a.projectId.localeCompare(b.projectId) || a.buildId.localeCompare(b.buildId));
  jamSubmissions.sort((a, b) => a.jamId.localeCompare(b.jamId) || a.projectId.localeCompare(b.projectId));
  return { version: 1, generatedAt, builds, jamSubmissions };
}
