import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHostedBuildsExport } from '../scripts/hosted-builds-export.mjs';

function doc(id, data) { return { id, data: () => data }; }

const project = doc('project_1', { projectId: 'project_1', publishToSite: true, slug: 'game-one' });
const build = doc('build_12345678', {
  buildId: 'build_12345678',
  projectId: 'project_1',
  status: 'ready',
  runtimeState: 'public',
  versionLabel: 'v1',
  compatibility: { mobileSupported: true, orientation: 'responsive', aspectRatio: '16:9' },
  createdAt: '2026-09-11T18:00:00.000Z',
  validatedAt: '2026-09-11T18:05:00.000Z',
});
const state = doc('project_1', { projectId: 'project_1', publishedBuildId: 'build_12345678' });
const jam = doc('1539971669467332728', { jamId: '1539971669467332728', phase: 'active' });
const submission = doc('1539971669467332728_project_1', {
  jamId: '1539971669467332728',
  projectId: 'project_1',
  buildId: 'build_12345678',
  threadId: '1539971669467332999',
  state: 'submitted',
  submittedAt: '2026-09-11T17:00:00.000Z',
});
const eligibility = doc('1539971669467332728_project_1', {
  eligible: true,
  projectId: 'project_1',
  buildId: 'build_12345678',
  threadId: '1539971669467332999',
});

test('exports approved public Builds and exact active Jam submissions', () => {
  const out = buildHostedBuildsExport({
    projectDocs: [project], buildDocs: [build], buildStateDocs: [state], submissionDocs: [submission], eligibilityDocs: [eligibility], jamDocs: [jam], generatedAt: '2026-09-12T09:00:00.000Z',
  });
  assert.equal(out.builds.length, 1);
  assert.equal(out.builds[0].primary, true);
  assert.equal(out.jamSubmissions.length, 1);
  assert.equal(out.jamSubmissions[0].buildId, 'build_12345678');
});

test('withholds Builds when Project publication or runtime state is not public', () => {
  const privateProject = doc('project_1', { projectId: 'project_1', publishToSite: false, slug: 'game-one' });
  assert.equal(buildHostedBuildsExport({ projectDocs: [privateProject], buildDocs: [build], buildStateDocs: [state] }).builds.length, 0);
  const revoked = doc('build_12345678', { ...build.data(), runtimeState: 'revoked' });
  assert.equal(buildHostedBuildsExport({ projectDocs: [project], buildDocs: [revoked], buildStateDocs: [state] }).builds.length, 0);
});

test('active Jam submission requires exact current eligibility', () => {
  const badEligibility = doc('1539971669467332728_project_1', { ...eligibility.data(), buildId: 'other-build' });
  const out = buildHostedBuildsExport({ projectDocs: [project], buildDocs: [build], buildStateDocs: [state], submissionDocs: [submission], eligibilityDocs: [badEligibility], jamDocs: [jam] });
  assert.equal(out.jamSubmissions.length, 0);
});

test('locked Jam submission remains bound to exact public Build during voting', () => {
  const votingJam = doc('1539971669467332728', { jamId: '1539971669467332728', phase: 'voting' });
  const locked = doc('1539971669467332728_project_1', { ...submission.data(), state: 'locked', lockedAt: '2026-09-11T20:00:00.000Z' });
  const out = buildHostedBuildsExport({ projectDocs: [project], buildDocs: [build], buildStateDocs: [state], submissionDocs: [locked], jamDocs: [votingJam] });
  assert.equal(out.jamSubmissions.length, 1);
  assert.equal(out.jamSubmissions[0].state, 'locked');
});

test('duplicate public Jam Project entries fail closed', () => {
  const duplicate = doc('another', { ...submission.data() });
  assert.throws(() => buildHostedBuildsExport({ projectDocs: [project], buildDocs: [build], buildStateDocs: [state], submissionDocs: [submission, duplicate], eligibilityDocs: [eligibility], jamDocs: [jam] }), /duplicate public Jam submission/);
});
