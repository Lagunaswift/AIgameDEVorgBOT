import { normalizeJamId, normalizeProjectUrl } from '../src/lib/publicMetadata.js';

export function buildPublicGame({
  id,
  title,
  author,
  description,
  image,
  threadUrl,
  createdAt,
  feedbackPoints,
  tags,
  award,
  projectUrl,
  jamId,
}) {
  const normalizedJamId = normalizeJamId(jamId);
  if (jamId != null && !normalizedJamId) {
    throw new Error(`game ${id} has an invalid jamId`);
  }
  const normalizedProjectUrl = projectUrl == null ? null : normalizeProjectUrl(projectUrl);
  if (projectUrl != null && !normalizedProjectUrl) {
    throw new Error(`game ${id} has an invalid projectUrl`);
  }

  return {
    id,
    title,
    author,
    description,
    image,
    threadUrl,
    createdAt,
    feedbackPoints,
    tags,
    award,
    kind: normalizedJamId ? 'jam-entry' : 'project',
    jamId: normalizedJamId,
    projectUrl: normalizedProjectUrl,
    // Legacy compatibility marker: derived solely from recognised feedbackPoints, not current
    // feedback intent. It is not used for Test/Play decisions.
    needsFeedback: feedbackPoints === 0,
    publish: true,
  };
}
