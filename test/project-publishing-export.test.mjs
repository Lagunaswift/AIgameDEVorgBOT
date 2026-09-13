import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readProjectPublishing } from '../scripts/project-publishing-export.mjs';
const p = { id: 'project-a', slug: 'a-game' };
const record = { version: 1, projectId: p.id, revision: 1, releases: [], roadmap: [{ id: 'roadmap_123', title: 'Next update', description: '', lane: 'next', visibility: 'public' }] };
function database(data) { const reads = []; return { reads, db: { collection: (name) => ({ doc: (id) => ({ get: async () => { reads.push([name, id]); return { id, exists: !!data[id], data: () => data[id] }; } }) }) } }; }
test('publishing export reads only the fresh approved Project set and omits hidden Projects', async () => {
  const d = database({ 'project-a': record, hidden: { projectId: 'hidden', secret: 'never read' } });
  const out = await readProjectPublishing({ db: d.db, projects: [p], generatedAt: new Date().toISOString() });
  assert.deepEqual(d.reads, [['projectPublishing', 'project-a']]); assert.equal(out.projects.length, 1); assert.doesNotMatch(JSON.stringify(out), /secret|hidden|visibility|revision/);
});
test('withdrawal removes public publishing data from the next export without deleting saved records', async () => {
  const d = database({ 'project-a': record });
  const out = await readProjectPublishing({ db: d.db, projects: [], generatedAt: new Date().toISOString() });
  assert.deepEqual(out.projects, []); assert.equal(d.reads.length, 0);
});
test('malformed public publishing records and read failures stop candidate generation', async () => {
  const d = database({ 'project-a': { ...record, projectId: 'other' } });
  await assert.rejects(() => readProjectPublishing({ db: d.db, projects: [p], generatedAt: new Date().toISOString() }));
  await assert.rejects(() => readProjectPublishing({ db: { collection: () => { throw new Error('offline'); } }, projects: [p], generatedAt: new Date().toISOString() }));
});
test('core exporter prepares publishing before writing and staging promotes the sidecar', () => {
  const code = readFileSync(new URL('../scripts/export-site-data.mjs', import.meta.url), 'utf8');
  assert.ok(code.indexOf('const publishing = await readProjectPublishing') < code.indexOf('const filesWritten = []'));
  const workflow = readFileSync(new URL('../.github/workflows/export-site.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cp site-staging\/src\/data\/project-publishing\.json site\/src\/data\/project-publishing\.json/);
  assert.ok(workflow.indexOf('Build staged site') < workflow.indexOf('cp site-staging/src/data/project-publishing.json'));
});
