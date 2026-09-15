// Dependency-free contract. Keep Site and Bot copies byte-identical.
export const CONNECTIONS_COLLECTION = 'projectConnections';
export const CONNECTION_LIMITS = Object.freeze({ links: 24, genres: 3, requestBytes: 16384 });
export const GENRES = Object.freeze({ action: 'Action', adventure: 'Adventure', puzzle: 'Puzzle', platformer: 'Platformer', rpg: 'Role-playing', strategy: 'Strategy', simulation: 'Simulation', horror: 'Horror', racing: 'Racing', sports: 'Sports', narrative: 'Interactive fiction', other: 'Other' });
export const AI_USES = Object.freeze({ code: 'Code', art: '2D art', models: '3D assets', audio: 'Music / audio', writing: 'Writing', design: 'Design', testing: 'Testing' });
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
export const validConnectionId = (v) => typeof v === 'string' && v.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
export const validConnectionProjectId = (v) => typeof v === 'string' && v.trim() === v && !!v && new TextEncoder().encode(v).length <= 1500 && !/[\/\\\x00-\x1f\x7f]/.test(v) && !['.', '..'].includes(v) && !/^__.*__$/.test(v);
export const connectionRevision = (v) => Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
const choices = (v, allowed, max) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && Object.hasOwn(allowed, x)) && new Set(v).size === v.length;
export function parseConnectionsInput(input, action = 'save') {
  if (action === 'clear') return exact(input, ['revision']) && connectionRevision(input.revision) ? { revision: input.revision } : null;
  if (action !== 'save' || !exact(input, ['revision', 'genres', 'aiUse', 'labelsVisibility', 'links'])
    || !connectionRevision(input.revision) || !choices(input.genres, GENRES, CONNECTION_LIMITS.genres)
    || !choices(input.aiUse, AI_USES, Object.keys(AI_USES).length) || !['draft','public'].includes(input.labelsVisibility)
    || !Array.isArray(input.links) || input.links.length > CONNECTION_LIMITS.links) return null;
  const seen = new Set(); const links = [];
  for (const link of input.links) {
    if (!exact(link, ['kind', 'targetId', 'visibility']) || !['tool','guide'].includes(link.kind)
      || !validConnectionId(link.targetId) || !['draft','public'].includes(link.visibility)) return null;
    const key = `${link.kind}:${link.targetId}`;
    if (seen.has(key)) return null;
    seen.add(key); links.push({ kind: link.kind, targetId: link.targetId, visibility: link.visibility });
  }
  return { revision: input.revision, genres: [...input.genres], aiUse: [...input.aiUse], labelsVisibility: input.labelsVisibility, links };
}
export function connectionsState(value, projectId) {
  if (!validConnectionProjectId(projectId)) return null;
  if (value === undefined) return { version: 1, projectId, revision: 0, genres: [], aiUse: [], labelsVisibility: 'draft', links: [] };
  if (!exact(value, ['version','projectId','revision','genres','aiUse','labelsVisibility','links','updatedAt']) || value.version !== 1 || value.projectId !== projectId || value.revision === 0) return null;
  const parsed = parseConnectionsInput({ revision: value.revision, genres: value.genres, aiUse: value.aiUse, labelsVisibility: value.labelsVisibility, links: value.links });
  return parsed ? { version: 1, projectId, ...parsed } : null;
}
export function publicConnections(value, project) {
  const state = connectionsState(value, project.id);
  if (!state) throw new Error('Invalid saved Project connections. Export stopped.');
  return { projectId: project.id, projectSlug: project.slug,
    genres: state.labelsVisibility === 'public' ? state.genres : [], aiUse: state.labelsVisibility === 'public' ? state.aiUse : [],
    tools: state.links.filter((l) => l.kind === 'tool' && l.visibility === 'public').map((l) => l.targetId),
    guides: state.links.filter((l) => l.kind === 'guide' && l.visibility === 'public').map((l) => l.targetId) };
}
export function parseConnectionsPayload(payload, projects) {
  if (!exact(payload, ['version','generatedAt','projects']) || payload.version !== 1 || !Array.isArray(payload.projects) || !Array.isArray(projects)) return null;
  if (payload.generatedAt === null) { if (payload.projects.length) return null; }
  else if (typeof payload.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.generatedAt)
    || !Number.isFinite(Date.parse(payload.generatedAt)) || new Date(payload.generatedAt).toISOString() !== payload.generatedAt) return null;
  const allowed = new Map();
  for (const p of projects) {
    if (!validConnectionProjectId(p.id) || !validConnectionId(p.slug) || allowed.has(p.id)) return null;
    allowed.set(p.id, p.slug);
  }
  const seen = new Set(), out = [];
  for (const entry of payload.projects) {
    if (!exact(entry, ['projectId','projectSlug','genres','aiUse','tools','guides']) || seen.has(entry.projectId)
      || !allowed.has(entry.projectId) || allowed.get(entry.projectId) !== entry.projectSlug
      || !choices(entry.genres, GENRES, CONNECTION_LIMITS.genres) || !choices(entry.aiUse, AI_USES, Object.keys(AI_USES).length)) return null;
    for (const kind of ['tools','guides']) {
      if (!Array.isArray(entry[kind]) || entry[kind].some((id) => !validConnectionId(id)) || new Set(entry[kind]).size !== entry[kind].length) return null;
    }
    if (entry.tools.length + entry.guides.length > CONNECTION_LIMITS.links) return null;
    seen.add(entry.projectId); out.push({ ...entry, genres: [...entry.genres], aiUse: [...entry.aiUse], tools: [...entry.tools], guides: [...entry.guides] });
  }
  return out;
}
// Resolve against the current *public* catalogue. Missing/removed targets never
// become guessed URLs, stale titles, or endorsements. Stored choices are untouched.
export function resolveConnections(entry, catalog) {
  return { ...entry, tools: entry.tools.filter((id) => catalog.some((r) => r.kind === 'tool' && r.id === id)),
    guides: entry.guides.filter((id) => catalog.some((r) => r.kind === 'guide' && r.id === id)) };
}
