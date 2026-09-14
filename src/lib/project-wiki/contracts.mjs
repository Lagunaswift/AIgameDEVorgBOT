// Dependency-free contract. Site and Bot copies must remain byte-identical.
export const WIKI_COLLECTION = 'projectWiki';
export const WIKI_LIMITS = Object.freeze({ articles: 20, title: 120, summary: 280, body: 12000, requestBytes: 65536, documentBytes: 524288 });
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => record(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).byteLength;
export const validWikiProjectId = (v) => typeof v === 'string' && v.length > 0 && v === v.trim() && new TextEncoder().encode(v).byteLength <= 1500 && !/[\/\u0000-\u001f\u007f]/.test(v) && !['.', '..'].includes(v) && !/^__.*__$/.test(v);
export const validArticleId = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{7,79}$/.test(v);
export const validWikiRevision = (v) => Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
const string = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);

export function parseWikiContent(value, { published = false } = {}) {
  if (!exact(value, ['title', 'summary', 'body']) || !string(value.title, WIKI_LIMITS.title)
    || /[\r\n\t]/.test(value.title) || !string(value.summary, WIKI_LIMITS.summary)
    || /[\r\n\t]/.test(value.summary) || !string(value.body, WIKI_LIMITS.body)) return null;
  const result = { title: value.title.trim(), summary: value.summary.trim(), body: value.body.replace(/\r\n?/g, '\n') };
  return published && (!result.title || !result.body.trim()) ? null : result;
}
export function parseWikiInput(value) {
  if (!record(value) || !validWikiRevision(value.revision) || !validArticleId(value.articleId)) return null;
  if (value.action === 'save') {
    if (!exact(value, ['action', 'revision', 'articleId', 'content'])) return null;
    const content = parseWikiContent(value.content);
    return content ? { action: 'save', revision: value.revision, articleId: value.articleId, content } : null;
  }
  return ['publish', 'unpublish', 'delete'].includes(value.action) && exact(value, ['action', 'revision', 'articleId'])
    ? { action: value.action, revision: value.revision, articleId: value.articleId } : null;
}
export function wikiState(value, projectId) {
  if (!validWikiProjectId(projectId)) return null;
  if (value === undefined) return { version: 1, projectId, revision: 0, articles: [] };
  if (!record(value) || Object.keys(value).some((k) => !['version', 'projectId', 'revision', 'articles', 'updatedAt'].includes(k))
    || value.version !== 1 || value.projectId !== projectId || !validWikiRevision(value.revision)
    || !Array.isArray(value.articles) || value.articles.length > WIKI_LIMITS.articles) return null;
  const seen = new Set(), articles = [];
  for (const article of value.articles) {
    if (!exact(article, ['id', 'draft', 'published']) || !validArticleId(article.id) || seen.has(article.id)) return null;
    const draft = parseWikiContent(article.draft);
    const published = article.published === null ? null : parseWikiContent(article.published, { published: true });
    if (!draft || (article.published !== null && !published)) return null;
    seen.add(article.id); articles.push({ id: article.id, draft, published });
  }
  const state = { version: 1, projectId, revision: value.revision, articles };
  return bytes(state) <= WIKI_LIMITS.documentBytes ? state : null;
}
export function publicWikiRecord(value, project) {
  const state = wikiState(value, project.id);
  if (!state) throw new Error('Invalid Project Wiki record. Export stopped.');
  return { projectId: project.id, projectSlug: project.slug,
    articles: state.articles.filter((a) => a.published !== null).map((a) => ({ id: a.id, ...a.published })) };
}
export function parseWikiPayload(payload, projects) {
  if (!exact(payload, ['version', 'generatedAt', 'projects']) || payload.version !== 1 || !Array.isArray(payload.projects) || !Array.isArray(projects)) return null;
  if (payload.generatedAt === null) { if (payload.projects.length) return null; }
  else if (typeof payload.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.generatedAt)
    || !Number.isFinite(Date.parse(payload.generatedAt)) || new Date(payload.generatedAt).toISOString() !== payload.generatedAt) return null;
  const allowed = new Map(), seen = new Set(), result = [];
  for (const p of projects) {
    if (!validWikiProjectId(p.id) || typeof p.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug) || allowed.has(p.id)) return null;
    allowed.set(p.id, p.slug);
  }
  for (const entry of payload.projects) {
    if (!exact(entry, ['projectId', 'projectSlug', 'articles']) || !allowed.has(entry.projectId)
      || allowed.get(entry.projectId) !== entry.projectSlug || seen.has(entry.projectId)
      || !Array.isArray(entry.articles) || !entry.articles.length || entry.articles.length > WIKI_LIMITS.articles) return null;
    const articleIds = new Set(), articles = [];
    for (const a of entry.articles) {
      if (!exact(a, ['id', 'title', 'summary', 'body']) || !validArticleId(a.id) || articleIds.has(a.id)) return null;
      const content = parseWikiContent({ title: a.title, summary: a.summary, body: a.body }, { published: true });
      if (!content) return null;
      articleIds.add(a.id); articles.push({ id: a.id, ...content });
    }
    seen.add(entry.projectId); result.push({ projectId: entry.projectId, projectSlug: entry.projectSlug, articles });
  }
  return result;
}
