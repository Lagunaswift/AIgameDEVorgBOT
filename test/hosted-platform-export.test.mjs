import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHostedPlatformExport } from '../scripts/hosted-platform-export-lib.mjs';

const projectPayload = {
  version: 1,
  projects: [
    { id: 'project-1', slug: 'game-one', title: 'Game One' },
    { id: 'project-2', slug: 'game-two', title: 'Game Two' },
  ],
};
const jamId = '111111111111111111';
const jamPayload = { version: 2, jams: [{ id: jamId, phase: 'active', title: 'Jam' }] };
const build = {
  buildId: 'build_Public123', projectId: 'project-1', ownerId: '222222222222222222',
  status: 'ready', runtimeState: 'public', versionLabel: 'v1',
  compatibility: { mobileSupported: true, orientation: 'responsive', aspectRatio: '16:9' },
  createdAt: new Date('2026-09-10T10:00:00Z'), validatedAt: new Date('2026-09-10T10:05:00Z'),
};

test('exports only runtime-public ready Builds belonging to approved public Projects', () => {
  const result = buildHostedPlatformExport({
    generatedAt: '2026-09-11T22:00:00.000Z', projectPayload, jamPayload,
    builds: [
      build,
      { ...build, buildId: 'build_Private123', runtimeState: 'private' },
      { ...build, buildId: 'build_Failed123', status: 'failed' },
      { ...build, buildId: 'build_Orphan123', projectId: 'private-project' },
    ],
    buildStates: [{ projectId: 'project-1', publishedBuildId: build.buildId }],
    submissions: [], eligibilities: [],
  });
  assert.equal(result.version, 1);
  assert.equal(result.builds.length, 1);
  assert.deepEqual(result.builds[0], {
    buildId: build.buildId,
    projectId: 'project-1',
    projectSlug: 'game-one',
    versionLabel: 'v1',
    compatibility: { mobileSupported: true, orientation: 'responsive', aspectRatio: '16:9' },
    primary: true,
    createdAt: '2026-09-10T10:00:00.000Z',
    validatedAt: '2026-09-10T10:05:00.000Z',
  });
});

test('active Jam submissions require exact current eligibility', () => {
  const submission = {
    jamId, projectId: 'project-1', buildId: build.buildId,
    ownerId: '222222222222222222', threadId: '333333333333333333', state: 'submitted',
    submittedAt: new Date('2026-09-11T12:00:00Z'),
  };
  let result = buildHostedPlatformExport({
    generatedAt: '2026-09-11T22:00:00.000Z', projectPayload, jamPayload,
    builds: [build], buildStates: [], submissions: [submission], eligibilities: [],
  });
  assert.equal(result.jamSubmissions.length, 0);

  result = buildHostedPlatformExport({
    generatedAt: '2026-09-11T22:00:00.000Z', projectPayload, jamPayload,
    builds: [build], buildStates: [], submissions: [submission],
    eligibilities: [{
      jamId, projectId: 'project-1', threadId: submission.threadId,
      ownerId: submission.ownerId, eligible: true,
    }],
  });
  assert.equal(result.jamSubmissions.length, 1);
  assert.equal(result.jamSubmissions[0].buildId, build.buildId);
});

test('locked and finished entries follow exact Jam phase and exact public Build', () => {
  const locked = {
    jamId, projectId: 'project-1', buildId: build.buildId,
    ownerId: '222222222222222222', threadId: '333333333333333333', state: 'locked',
    submittedAt: new Date('2026-09-11T12:00:00Z'), lockedAt: new Date('2026-09-11T18:00:00Z'),
  };
  const votingPayload = { version: 2, jams: [{ id: jamId, phase: 'voting', title: 'Jam' }] };
  const result = buildHostedPlatformExport({
    generatedAt: '2026-09-11T22:00:00.000Z', projectPayload, jamPayload: votingPayload,
    builds: [build], buildStates: [], submissions: [locked], eligibilities: [],
  });
  assert.equal(result.jamSubmissions.length, 1);
  assert.equal(result.jamSubmissions[0].state, 'locked');

  const wrongPhase = buildHostedPlatformExport({
    generatedAt: '2026-09-11T22:00:00.000Z', projectPayload, jamPayload,
    builds: [build], buildStates: [], submissions: [locked], eligibilities: [],
  });
  assert.equal(wrongPhase.jamSubmissions.length, 0);
});

test('unsupported public baselines fail closed', () => {
  assert.throws(() => buildHostedPlatformExport({ generatedAt: '', projectPayload: {}, jamPayload, builds: [] }), /Projects v1/);
  assert.throws(() => buildHostedPlatformExport({ generatedAt: '', projectPayload, jamPayload: {}, builds: [] }), /Jams v2/);
});
