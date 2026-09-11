import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canLockJamSubmission,
  canTransitionJamPhase,
  deriveJamEligibility,
  makeJamRecord,
  runtimeReconciliationDecision,
  runtimeReconciliationPlan,
} from '../src/lib/hostedPlatform.js';

const ids = {
  jam: '111111111111111111',
  tag: '222222222222222222',
  eventsForum: '333333333333333333',
  submissionsForum: '444444444444444444',
  thread: '555555555555555555',
  owner: '666666666666666666',
};
const project = { id: 'project_123', ownerId: ids.owner, profileThreadId: ids.thread, publishToSite: true };
const jam = makeJamRecord({
  jamId: ids.jam,
  discordThreadId: ids.jam,
  submissionTagId: ids.tag,
  eventsForumId: ids.eventsForum,
  submissionsForumId: ids.submissionsForum,
  title: 'One Verb Jam',
  phase: 'active',
});
const thread = { threadId: ids.thread, forumId: ids.submissionsForum, projectId: project.id, ownerId: ids.owner, appliedTags: [ids.tag] };

test('Jam setup requires exact Discord identity and forward lifecycle', () => {
  assert.equal(jam.jamId, ids.jam);
  assert.equal(canTransitionJamPhase('upcoming', 'active'), true);
  assert.equal(canTransitionJamPhase('active', 'voting'), true);
  assert.equal(canTransitionJamPhase('voting', 'active'), false);
  assert.throws(() => makeJamRecord({ ...jam, jamId: 'bad', discordThreadId: 'bad' }), /snowflakes/);
});

test('Jam eligibility is derived only from exact Project thread and live tag evidence', () => {
  assert.deepEqual(deriveJamEligibility({ jam, thread, project }), {
    eligible: true,
    reason: 'eligible',
    jamId: ids.jam,
    projectId: project.id,
    threadId: ids.thread,
    ownerId: ids.owner,
  });
  assert.equal(deriveJamEligibility({ jam, thread: { ...thread, appliedTags: [] }, project }).reason, 'jam-tag-missing');
  assert.equal(deriveJamEligibility({ jam, thread: { ...thread, forumId: ids.eventsForum }, project }).reason, 'wrong-forum');
  assert.equal(deriveJamEligibility({ jam, thread, project: { ...project, profileThreadId: '777777777777777777' } }).reason, 'project-thread-mismatch');
});

test('runtime reconciliation distinguishes owner intent, moderator approval and Build readiness', () => {
  const build = { buildId: 'build_AbCdEf1234', projectId: project.id, ownerId: project.ownerId, status: 'ready', runtimeState: 'requested' };
  const state = { requestedBuildId: build.buildId };
  assert.deepEqual(runtimeReconciliationDecision({ project, buildState: state, build, approved: true }), {
    action: 'publish', buildId: build.buildId, previousBuildId: null, reason: 'approved',
  });
  assert.equal(runtimeReconciliationDecision({ project, buildState: state, build, approved: false }).action, 'none');
  assert.equal(runtimeReconciliationDecision({ project, buildState: { ...state, publishedBuildId: build.buildId }, build: { ...build, runtimeState: 'public' }, approved: false }).action, 'revoke');
  assert.equal(runtimeReconciliationDecision({ project: { ...project, publishToSite: false }, buildState: { ...state, publishedBuildId: build.buildId }, build, approved: true }).reason, 'owner-publication-disabled');
  assert.equal(runtimeReconciliationDecision({ project, buildState: state, build: { ...build, status: 'failed' }, approved: true }).reason, 'requested-build-not-ready');
});

test('runtime plan keeps a locked Jam Build public after the Project moves to a newer Build', () => {
  const jamBuild = { buildId: 'build_JamBuild123', projectId: project.id, ownerId: ids.owner, status: 'ready', runtimeState: 'public' };
  const currentBuild = { buildId: 'build_Current123', projectId: project.id, ownerId: ids.owner, status: 'ready', runtimeState: 'requested' };
  const plan = runtimeReconciliationPlan({
    project,
    buildState: { requestedBuildId: currentBuild.buildId, publishedBuildId: jamBuild.buildId },
    builds: [jamBuild, currentBuild],
    submissions: [{ jamId: ids.jam, projectId: project.id, ownerId: ids.owner, buildId: jamBuild.buildId, state: 'locked' }],
    jams: [{ ...jam, phase: 'voting' }],
    eligibilities: [],
    approved: true,
  });
  assert.deepEqual(plan.desired, [currentBuild.buildId, jamBuild.buildId].sort());
  assert.deepEqual(plan.enable, [currentBuild.buildId]);
  assert.deepEqual(plan.disable, []);
  assert.equal(plan.primaryPublishedBuildId, currentBuild.buildId);
});

test('active Jam Build requires current mirrored eligibility but locked/finished Build does not', () => {
  const build = { buildId: 'build_AbCdEf1234', projectId: project.id, ownerId: ids.owner, status: 'ready', runtimeState: 'private' };
  const submission = { jamId: ids.jam, projectId: project.id, ownerId: ids.owner, buildId: build.buildId, state: 'submitted' };
  let plan = runtimeReconciliationPlan({ project, buildState: {}, builds: [build], submissions: [submission], jams: [jam], eligibilities: [], approved: true });
  assert.deepEqual(plan.desired, []);
  plan = runtimeReconciliationPlan({
    project,
    buildState: {},
    builds: [build],
    submissions: [submission],
    jams: [jam],
    eligibilities: [{ jamId: ids.jam, projectId: project.id, threadId: ids.thread, ownerId: ids.owner, eligible: true }],
    approved: true,
  });
  assert.deepEqual(plan.desired, [build.buildId]);
});

test('removing moderator approval revokes every public Build for the Project', () => {
  const builds = [
    { buildId: 'build_AbCdEf1234', projectId: project.id, ownerId: ids.owner, status: 'ready', runtimeState: 'public' },
    { buildId: 'build_OtherJam123', projectId: project.id, ownerId: ids.owner, status: 'ready', runtimeState: 'public' },
  ];
  const plan = runtimeReconciliationPlan({ project, buildState: { requestedBuildId: builds[0].buildId }, builds, approved: false });
  assert.deepEqual(plan.desired, []);
  assert.deepEqual(plan.disable, builds.map((build) => build.buildId).sort());
  assert.equal(plan.primaryPublishedBuildId, null);
});

test('Jam submission can lock only one exact submitted Build during voting', () => {
  assert.equal(canLockJamSubmission({ phase: 'voting' }, { state: 'submitted', buildId: 'build_AbCdEf1234' }), true);
  assert.equal(canLockJamSubmission({ phase: 'active' }, { state: 'submitted', buildId: 'build_AbCdEf1234' }), false);
  assert.equal(canLockJamSubmission({ phase: 'voting' }, { state: 'withdrawn', buildId: 'build_AbCdEf1234' }), false);
});
