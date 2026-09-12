// Project Publishing v1. Keep this dependency-free contract identical in Site and Bot.
export const PUBLISHING_VERSION = 1;
export const PUBLISHING_COLLECTION = 'projectPublishing';
export const LIMITS = Object.freeze({ releases: 20, roadmap: 30, requestBytes: 262144 });
export const PLATFORMS = Object.freeze(['web', 'windows', 'macos', 'linux', 'ios', 'android', 'other']);
export const LANES = Object.freeze(['now', 'next', 'later']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,79}$/;
const record = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => record(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const text = (v, max, optional = false) => typeof v === 'string' && v.length <= max && (optional || v.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
export const validProjectId = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 1500 && !v.includes('/') && v !== '.' && v !== '..';
const revision = (v) => Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
function validDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function validUrl(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 2048) return false;
  try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}
export function parsePublishingItems(section, items, { publicOnly = false } = {}) {
  if (!Object.hasOwn(LIMITS, section) || !['releases', 'roadmap'].includes(section) || !Array.isArray(items) || items.length > LIMITS[section]) return null;
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const keys = section === 'releases'
      ? ['id', 'version', 'title', 'date', 'platforms', 'url', 'destination', 'notes']
      : ['id', 'title', 'description', 'lane'];
    if (!publicOnly) keys.push('visibility');
    if (!exact(item, keys) || typeof item.id !== 'string' || !ID.test(item.id) || seen.has(item.id) || !text(item.title, 120)) return null;
    if (!publicOnly && !['draft', 'public'].includes(item.visibility)) return null;
    seen.add(item.id);
    if (section === 'releases') {
      if (!text(item.version, 60) || !validDate(item.date) || !validUrl(item.url) || !text(item.notes, 2000, true)
        || !['play', 'download', 'website'].includes(item.destination) || !Array.isArray(item.platforms)
        || item.platforms.length === 0 || item.platforms.some((p) => !PLATFORMS.includes(p))
        || new Set(item.platforms).size !== item.platforms.length) return null;
      result.push({ id: item.id, version: item.version.trim(), title: item.title.trim(), date: item.date,
        platforms: [...item.platforms], url: new URL(item.url).href, destination: item.destination, notes: item.notes.trim(),
        ...(!publicOnly ? { visibility: item.visibility } : {}) });
    } else {
      if (!text(item.description, 500, true) || !LANES.includes(item.lane)) return null;
      result.push({ id: item.id, title: item.title.trim(), description: item.description.trim(), lane: item.lane,
        ...(!publicOnly ? { visibility: item.visibility } : {}) });
    }
  }
  return result;
}
export function parsePublishingUpdate(section, input) {
  if (!exact(input, ['revision', 'items']) || !revision(input.revision)) return null;
  const items = parsePublishingItems(section, input.items);
  return items ? { revision: input.revision, items } : null;
}
export function publishingState(value, projectId) {
  if (!validProjectId(projectId)) return null;
  if (value === undefined || value === null) return { version: 1, projectId, revision: 0, releases: [], roadmap: [] };
  if (!record(value) || value.version !== 1 || value.projectId !== projectId || !revision(value.revision)) return null;
  const releases = parsePublishingItems('releases', value.releases);
  const roadmap = parsePublishingItems('roadmap', value.roadmap);
  return releases && roadmap ? { version: 1, projectId, revision: value.revision, releases, roadmap } : null;
}
export function publicPublishingRecord(value, project) {
  const state = publishingState(value, project.id);
  if (!state) throw new Error('Invalid Project publishing record. Export stopped.');
  const visible = (items) => items.filter((i) => i.visibility === 'public').map(({ visibility: _visibility, ...item }) => item);
  return { projectId: project.id, projectSlug: project.slug,
    releases: visible(state.releases).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)),
    roadmap: visible(state.roadmap) };
}
export function parsePublishingPayload(payload, projects) {
  if (!exact(payload, ['version', 'generatedAt', 'projects']) || payload.version !== 1 || !Array.isArray(payload.projects) || !Array.isArray(projects)) return null;
  if (payload.generatedAt !== null && (typeof payload.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.generatedAt) || !Number.isFinite(Date.parse(payload.generatedAt)) || new Date(payload.generatedAt).toISOString() !== payload.generatedAt)) return null;
  if (payload.generatedAt === null && payload.projects.length > 0) return null;
  const allowed = new Map(projects.map((p) => [p.id, p.slug]));
  const seen = new Set(); const results = [];
  for (const item of payload.projects) {
    if (!exact(item, ['projectId', 'projectSlug', 'releases', 'roadmap']) || !validProjectId(item.projectId)
      || typeof item.projectSlug !== 'string' || seen.has(item.projectId) || allowed.get(item.projectId) !== item.projectSlug) return null;
    const releases = parsePublishingItems('releases', item.releases, { publicOnly: true });
    const roadmap = parsePublishingItems('roadmap', item.roadmap, { publicOnly: true });
    if (!releases || !roadmap) return null;
    seen.add(item.projectId); results.push({ projectId: item.projectId, projectSlug: item.projectSlug, releases, roadmap });
  }
  return results;
}
