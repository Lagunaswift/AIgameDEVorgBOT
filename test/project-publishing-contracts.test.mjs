import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublishingUpdate, parsePublishingItems, publishingState, publicPublishingRecord, parsePublishingPayload } from '../src/lib/project-publishing/contracts.mjs';
const project = { id: 'project-a', slug: 'a-game' };
const release = (extra = {}) => ({ id: 'release_123', version: '1.0', title: 'First release', date: '2026-09-12', platforms: ['web'], url: 'https://example.org/1', destination: 'play', notes: '', visibility: 'draft', ...extra });
const item = (extra = {}) => ({ id: 'roadmap_123', title: 'Better controls', description: '', lane: 'now', visibility: 'draft', ...extra });
const state = (extra = {}) => ({ version: 1, projectId: project.id, revision: 0, releases: [release()], roadmap: [item()], ...extra });
const envelope = (records) => ({ version: 1, generatedAt: '2026-09-12T12:00:00.000Z', projects: records });
test('publishing accepts bounded structured releases and roadmap items', () => {
  assert.equal(parsePublishingUpdate('releases', { revision: 0, items: [release()] }).items.length, 1);
  assert.equal(parsePublishingUpdate('roadmap', { revision: 0, items: [item()] }).items.length, 1);
  assert.deepEqual(publishingState(undefined, project.id).releases, []);
});
test('publishing rejects mass assignment and unknown sections/fields', () => {
  for (const field of ['ownerId', 'publishToSite', 'projectId', 'buildId']) assert.equal(parsePublishingUpdate('releases', { revision: 0, items: [release()], [field]: 'injected' }), null);
  assert.equal(parsePublishingItems('releases', [release({ buildId: 'build_123' })]), null);
  assert.equal(parsePublishingUpdate('__proto__', { revision: 0, items: [] }), null);
  assert.equal(parsePublishingUpdate('roadmap', { revision: 0, items: [item({ ownerId: 'secret' })] }), null);
});
test('publishing validates real dates and safe external links', () => {
  for (const date of ['2026-02-29', '2026-02-31', 'yesterday', '2026-01-32']) assert.equal(parsePublishingItems('releases', [release({ date })]), null);
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'https://user:password@example.org', 'not a URL', 'file:///x']) assert.equal(parsePublishingItems('releases', [release({ url })]), null);
  assert.ok(parsePublishingItems('releases', [release({ date: '2028-02-29' })]));
});
test('publishing requires explicit visibility and rejects unknown enums', () => {
  assert.equal(parsePublishingItems('roadmap', [item({ visibility: undefined })]), null);
  assert.equal(parsePublishingItems('roadmap', [item({ lane: 'done' })]), null);
  assert.equal(parsePublishingItems('releases', [release({ destination: 'iframe' })]), null);
  assert.equal(parsePublishingItems('releases', [release({ platforms: [] })]), null);
  assert.equal(parsePublishingItems('releases', [release({ platforms: ['web', 'web'] })]), null);
});
test('publishing rejects duplicate ids, item limits, oversized text and invalid revisions', () => {
  assert.equal(parsePublishingItems('releases', [release(), release()]), null);
  assert.equal(parsePublishingItems('roadmap', Array.from({ length: 31 }, (_, i) => item({ id: `roadmap_${i}__` }))), null);
  assert.equal(parsePublishingItems('releases', [release({ notes: 'x'.repeat(2001) })]), null);
  for (const revision of [-1, '0', 0.5, Number.MAX_SAFE_INTEGER]) assert.equal(parsePublishingUpdate('roadmap', { revision, items: [] }), null);
});
test('publishing fails malformed stored records rather than silently clearing them', () => {
  assert.equal(publishingState(state({ projectId: 'another' }), project.id), null);
  assert.equal(publishingState(state({ roadmap: null }), project.id), null);
  assert.equal(publishingState(state({ version: 2 }), project.id), null);
});
test('public projection strips private drafts and all internal metadata', () => {
  const raw = state({ ownerId: 'private-owner', privateNotes: 'never export', releases: [release({ notes: 'private-note' }), release({ id: 'release_456', visibility: 'public' })] });
  const projected = publicPublishingRecord(raw, project);
  assert.equal(projected.releases.length, 1); assert.equal(projected.roadmap.length, 0);
  assert.doesNotMatch(JSON.stringify(projected), /private-note|private-owner|visibility|revision|privateNotes/);
  assert.ok(parsePublishingPayload(envelope([projected]), [project]));
});
test('public sidecar rejects missing, duplicated and mismatched Project relationships', () => {
  const r = publicPublishingRecord(state(), project);
  assert.equal(parsePublishingPayload(envelope([r]), []), null);
  assert.equal(parsePublishingPayload(envelope([r, r]), [project]), null);
  assert.equal(parsePublishingPayload(envelope([{ ...r, projectSlug: 'wrong' }]), [project]), null);
  assert.equal(parsePublishingPayload({ version: 1, generatedAt: null, projects: [r] }, [project]), null);
});
test('public parser rejects accidental private fields and draft visibility markers', () => {
  const r = publicPublishingRecord(state({ releases: [release({ visibility: 'public' })] }), project);
  assert.equal(parsePublishingPayload(envelope([{ ...r, ownerId: 'private' }]), [project]), null);
  r.releases[0].visibility = 'public'; assert.equal(parsePublishingPayload(envelope([r]), [project]), null);
});
