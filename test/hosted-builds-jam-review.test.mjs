import assert from 'node:assert/strict';
import test from 'node:test';
import { createJamCommand } from '../src/commands/jam.js';
import { jamReviewDecision } from '../src/services/jams.js';

const JAM = '1539971669467332728';
const OWNER = '123456789012345678';

function baseEvidence(overrides = {}) {
  const submission = {
    state: 'submitted', projectId: 'project_1', buildId: 'build_12345678',
    threadId: '1539971669467332999', ownerId: OWNER,
  };
  return {
    jam: { id: JAM },
    submission,
    project: { id: 'project_1', publishToSite: true },
    build: { id: 'build_12345678', status: 'ready', runtimeState: 'private' },
    buildState: { moderationApproved: true },
    eligibility: {
      eligible: true, jamId: JAM, projectId: 'project_1', buildId: 'build_12345678',
      threadId: submission.threadId, ownerId: OWNER, reason: 'eligible',
    },
    ...overrides,
  };
}

test('Jam review distinguishes ready, tag-blocked and approval-blocked entries', () => {
  assert.deepEqual(jamReviewDecision(baseEvidence()), { status: 'ready', reasons: [] });

  const missingTag = baseEvidence({ eligibility: { ...baseEvidence().eligibility, eligible: false, reason: 'jam-tag-missing' } });
  assert.deepEqual(jamReviewDecision(missingTag), { status: 'blocked', reasons: ['jam-tag-missing'] });

  const withheld = baseEvidence({ buildState: { moderationApproved: false } });
  assert.deepEqual(jamReviewDecision(withheld), { status: 'blocked', reasons: ['moderator-approval-missing'] });
});

test('Jam review fails exact eligibility when the frozen Build does not match', () => {
  const evidence = baseEvidence();
  evidence.eligibility = { ...evidence.eligibility, buildId: 'build_other' };
  assert.deepEqual(jamReviewDecision(evidence), { status: 'blocked', reasons: ['eligible'] });
});

test('/jam registry includes setup, phase, status and review', () => {
  const json = createJamCommand().data.toJSON();
  assert.deepEqual(json.options.map((option) => option.name), ['setup', 'phase', 'status', 'review']);
});

test('moving to voting refreshes live Jam eligibility before changing phase and locking', async () => {
  const calls = [];
  const replies = [];
  const thread = {
    id: JAM,
    parentId: '1539971669467332001',
    name: 'Test Jam',
    appliedTags: [],
    isThread: () => true,
  };
  const services = {
    registerJam: async () => assert.fail('not used'),
    jamStatus: async () => assert.fail('not used'),
    jamReviewQueue: async () => assert.fail('not used'),
    reconcileAllActiveJamEligibility: async () => { calls.push('reconcile'); return { checked: 1, eligible: 1, blocked: 0, errors: [] }; },
    setJamPhaseFromDiscord: async () => { calls.push('phase'); return { phase: 'voting' }; },
    lockQualifiedJamSubmissions: async () => { calls.push('lock'); return [{ status: 'locked' }]; },
  };
  await createJamCommand(services).execute({
    channel: thread,
    client: {},
    user: { id: OWNER },
    options: {
      getSubcommand: () => 'phase',
      getString: (name) => name === 'phase' ? 'voting' : null,
    },
    deferReply: async () => {},
    editReply: async (value) => replies.push(value),
  });
  assert.deepEqual(calls, ['reconcile', 'phase', 'lock']);
  assert.match(replies.at(-1), /Locked 1 qualified submission/);
});

test('/jam review presents ready and blocked reasons without mutating state', async () => {
  const replies = [];
  const thread = { id: JAM, parentId: '1539971669467332001', isThread: () => true };
  const services = {
    registerJam: async () => assert.fail('not used'),
    setJamPhaseFromDiscord: async () => assert.fail('not used'),
    lockQualifiedJamSubmissions: async () => assert.fail('not used'),
    reconcileAllActiveJamEligibility: async () => assert.fail('not used'),
    jamStatus: async () => assert.fail('not used'),
    jamReviewQueue: async () => ({
      jam: { title: 'Test Jam' },
      counts: { ready: 1, blocked: 1, locked: 0, excluded: 0 },
      entries: [
        { status: 'ready', projectId: 'project_1', buildId: 'build_12345678', reasons: [] },
        { status: 'blocked', projectId: 'project_2', buildId: 'build_87654321', reasons: ['jam-tag-missing'] },
      ],
    }),
  };
  await createJamCommand(services).execute({
    channel: thread,
    client: {},
    user: { id: OWNER },
    options: { getSubcommand: () => 'review', getString: () => null },
    deferReply: async () => {},
    editReply: async (value) => replies.push(value),
  });
  assert.match(replies.at(-1), /READY/);
  assert.match(replies.at(-1), /jam-tag-missing/);
});
