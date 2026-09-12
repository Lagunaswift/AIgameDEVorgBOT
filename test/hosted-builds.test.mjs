import assert from 'node:assert/strict';
import test from 'node:test';
import {
  jamSubmissionDocId,
  phaseTransitionAllowed,
  qualificationDecision,
  runtimeDecision,
  submissionTransitionAllowed,
} from '../src/lib/hostedBuilds.js';

test('runtime decision publishes only approved ready requested builds', () => {
  const project = { publishToSite: true };
  const build = { status: 'ready', runtimeState: 'requested' };
  assert.deepEqual(runtimeDecision({ project, build, moderatorApproved: true }), { action: 'publish', reason: 'approved' });
  assert.deepEqual(runtimeDecision({ project, build: { ...build, status: 'validating' }, moderatorApproved: true }), { action: 'none', reason: 'build-not-ready' });
});

test('runtime decision revokes when moderator approval is removed', () => {
  const project = { publishToSite: true };
  const build = { status: 'ready', runtimeState: 'public' };
  assert.deepEqual(runtimeDecision({ project, build, moderatorApproved: false }), { action: 'revoke', reason: 'moderator-withheld' });
});

test('owner publication intent is still required after moderator approval', () => {
  const project = { publishToSite: false };
  const build = { status: 'ready', runtimeState: 'public' };
  assert.deepEqual(runtimeDecision({ project, build, moderatorApproved: true }), { action: 'revoke', reason: 'owner-private' });
});

test('jam qualification requires exact project/build, approval and ready state', () => {
  const project = { id: 'project_1', publishToSite: true };
  const build = { id: 'build_12345678', status: 'ready', runtimeState: 'public' };
  const submission = { projectId: 'project_1', buildId: 'build_12345678', state: 'submitted' };
  assert.deepEqual(qualificationDecision({ project, build, submission, moderatorApproved: true, jamPhase: 'voting' }), { qualified: true, reason: 'qualified' });
  assert.equal(qualificationDecision({ project, build, submission, moderatorApproved: false, jamPhase: 'voting' }).qualified, false);
  assert.equal(qualificationDecision({ project, build: { ...build, id: 'other' }, submission, moderatorApproved: true, jamPhase: 'voting' }).qualified, false);
});

test('jam phase and submission state transitions are forward-only', () => {
  assert.equal(phaseTransitionAllowed('upcoming', 'active'), true);
  assert.equal(phaseTransitionAllowed('active', 'upcoming'), false);
  assert.equal(phaseTransitionAllowed('active', 'voting'), true);
  assert.equal(phaseTransitionAllowed('finished', 'active'), false);

  assert.equal(submissionTransitionAllowed('submitted', 'locked'), true);
  assert.equal(submissionTransitionAllowed('locked', 'submitted'), false);
  assert.equal(submissionTransitionAllowed('locked', 'finished'), true);
});

test('jam submission IDs are deterministic and reject fuzzy identifiers', () => {
  assert.equal(jamSubmissionDocId('1539971669467332728', 'project_1'), '1539971669467332728_project_1');
  assert.throws(() => jamSubmissionDocId('One Verb Jam', 'project_1'), /Invalid jamId/);
  assert.throws(() => jamSubmissionDocId('1539971669467332728', '../project'), /Invalid projectId/);
});
