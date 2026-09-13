import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readProjectWikis } from '../scripts/project-wiki-export.mjs';
import { parseWikiPayload, publicWikiRecord, wikiState } from '../src/lib/project-wiki/contracts.mjs';
const project = { id: 'project-a', slug: 'test-game' };
const text = { title: 'Controls', summary: 'How to move', body: 'Use arrows' };
const state = { version: 1, projectId: project.id, revision: 3, articles: [
  { id: 'page_12345678', draft: { ...text, body: 'PRIVATE_FUTURE_EDIT' }, published: text },
  { id: 'page_87654321', draft: { ...text, body: 'PRIVATE_NEW_PAGE' }, published: null },
] };
function database(values) { const reads = []; return { reads, db: { collection: (name) => ({ doc: (id) => ({ get: async () => { reads.push([name, id]); return { id, exists: Object.hasOwn(values, id), data: () => values[id] }; } }) }) } }; }
test('Wiki export reads only freshly approved Projects and never exports draft text or IDs', async () => {
  const d = database({ [project.id]: state, hidden: { secret: 'never read' } });
  const payload = await readProjectWikis({ db: d.db, projects: [project], generatedAt: new Date().toISOString() });
  assert.deepEqual(d.reads, [['projectWiki', project.id]]);
  assert.equal(payload.projects[0].articles.length, 1);
  assert.equal(payload.projects[0].articles[0].body, 'Use arrows');
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE|page_87654321|draft|revision|ownerId/);
  assert.ok(parseWikiPayload(payload, [project]));
});
test('removing approval or owner publication removes Wiki from the next snapshot without reading private data', async () => {
  const d = database({ [project.id]: state });
  const payload = await readProjectWikis({ db: d.db, projects: [], generatedAt: new Date().toISOString() });
  assert.deepEqual(payload.projects, []); assert.deepEqual(d.reads, []);
});
test('unpublished/deleted article is absent and an all-private Wiki has no public route', async () => {
  const removed = structuredClone(state); removed.articles[0].published = null;
  const d = database({ [project.id]: removed });
  assert.deepEqual((await readProjectWikis({ db: d.db, projects: [project], generatedAt: new Date().toISOString() })).projects, []);
});
test('malformed Wiki state, unknown public fields and wrong identity fail closed', async () => {
  for (const broken of [{ ...state, projectId: 'wrong' }, { ...state, articles: [state.articles[0], state.articles[0]] }, { ...state, secret: 'private' }]) {
    const d = database({ [project.id]: broken });
    await assert.rejects(readProjectWikis({ db: d.db, projects: [project], generatedAt: new Date().toISOString() }));
  }
  const entry = publicWikiRecord(state, project);
  assert.equal(parseWikiPayload({ version: 1, generatedAt: new Date().toISOString(), projects: [{ ...entry, ownerId: 'secret' }] }, [project]), null);
  assert.equal(wikiState(null, project.id), null);
});
test('Wiki external reads finish before writes; exact sidecar promoted only after staged build', () => {
  const source = readFileSync(new URL('../scripts/export-site-data.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('const wikis = await readProjectWikis') > source.indexOf('const publishing = await readProjectPublishing'));
  assert.ok(source.indexOf('const wikis = await readProjectWikis') < source.indexOf('const filesWritten = []'));
  assert.match(source, /writeJson\(args.out, 'project-wiki.json', wikis\)/);
  const flow = readFileSync(new URL('../.github/workflows/export-site.yml', import.meta.url), 'utf8');
  assert.ok(flow.indexOf('Build staged site') < flow.indexOf('cp site-staging/src/data/project-wiki.json'));
  assert.match(flow, /git add [^\n]*src\/data\/project-wiki\.json/);
});
test('Wiki storage failures propagate before any output is available', async () => {
  await assert.rejects(readProjectWikis({ db: { collection: () => { throw new Error('offline'); } }, projects: [project], generatedAt: new Date().toISOString() }));
});
