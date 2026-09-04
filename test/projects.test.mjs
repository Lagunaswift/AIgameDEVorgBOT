import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProjectId,
  normalizeNullableProfileThreadId,
  normalizeProjectInput,
  normalizeProjectSlug,
  normalizeProjectStatus,
  normalizeThreadPurpose,
} from '../src/lib/projectValidation.js';
import {
  buildProjectRecord,
  linkThreadToProjectTransaction,
  setProjectPublicationTransaction,
  updateOwnedProjectTransaction,
} from '../src/services/projects.js';

const OWNER = '123456789012345678';
const OTHER = '234567890123456789';
const THREAD_ONE = '345678901234567890';
const THREAD_TWO = '456789012345678901';

function snapshot(data) {
  return data == null
    ? { exists: false, data: () => undefined }
    : { exists: true, data: () => data };
}

function project(overrides = {}) {
  return {
    projectId: 'project-1',
    ownerId: OWNER,
    title: 'Test Game',
    slug: 'test-game',
    summary: 'A game used for service tests.',
    status: 'development',
    projectUrl: null,
    platforms: ['web'],
    publishToSite: false,
    profileThreadId: null,
    ...overrides,
  };
}

function store({ thread = null, project: projectData = project() } = {}) {
  const writes = [];
  const reads = [];
  const data = { thread, project: projectData };
  const transaction = {
    async get(ref) {
      reads.push(ref.kind);
      return snapshot(data[ref.kind]);
    },
    update(ref, update) {
      writes.push({ kind: ref.kind, update });
      Object.assign(data[ref.kind], update);
    },
  };
  return {
    transaction,
    projectRef: { kind: 'project' },
    threadRef: { kind: 'thread' },
    reads,
    writes,
    data,
  };
}

test('Project validation normalizes valid values and rejects invalid boundaries', () => {
  const input = normalizeProjectInput({
    ownerId: OWNER,
    title: '  Test Game  ',
    slug: 'test-game-2',
    summary: '  A concise test summary. ',
    status: 'playable',
    projectUrl: 'https://example.com/game',
    platforms: ['web', 'windows'],
  });
  assert.deepEqual(input, {
    ownerId: OWNER,
    title: 'Test Game',
    slug: 'test-game-2',
    summary: 'A concise test summary.',
    status: 'playable',
    projectUrl: 'https://example.com/game',
    platforms: ['web', 'windows'],
  });
  assert.equal(normalizeProjectStatus('released'), 'released');
  assert.equal(normalizeThreadPurpose('jam-entry'), 'jam-entry');
  assert.equal(normalizeNullableProfileThreadId(null), null);
  assert.equal(normalizeNullableProfileThreadId(THREAD_ONE), THREAD_ONE);
  assert.throws(() => normalizeProjectStatus('public'), /status must be one of/);
  assert.throws(() => normalizeThreadPurpose('announcement'), /purpose must be one of/);
  assert.throws(() => normalizeProjectSlug('Test Game'), /lowercase URL-safe/);
  assert.throws(() => normalizeProjectSlug('x'.repeat(101)), /at most 100/);
  assert.throws(() => normalizeProjectInput({ ...input, summary: ' ' }), /summary is required/);
  assert.throws(() => normalizeProjectInput({ ...input, summary: 'x'.repeat(281) }), /at most 280/);
  assert.throws(() => normalizeProjectInput({ ...input, projectUrl: 'ftp://example.com' }), /http\(s\)/);
  assert.throws(() => normalizeProjectInput({ ...input, projectUrl: ' ' }), /http\(s\)/);
  assert.throws(() => normalizeProjectInput({ ...input, platforms: ['web', 'web'] }), /duplicates/);
  assert.throws(() => normalizeProjectInput({ ...input, platforms: ['console'] }), /platform must be one of/);
  assert.throws(() => assertProjectId('project/1'), /must not contain/);
  assert.throws(() => normalizeNullableProfileThreadId('not-a-discord-id'), /valid Discord ID/);
});

test('Project records are independently identified and start unpublished with no profile thread', () => {
  const input = {
    ownerId: OWNER, title: 'Test Game', slug: 'test-game', summary: 'A game.',
    status: 'development', projectUrl: null, platforms: [], publishToSite: false,
  };
  const record = buildProjectRecord({ projectId: 'generated-project-id', input, timestamp: 'now' });
  assert.equal(record.projectId, 'generated-project-id');
  assert.notEqual(record.projectId, record.ownerId);
  assert.equal(record.publishToSite, false);
  assert.equal(record.profileThreadId, null);
  assert.equal(record.createdAt, 'now');
  assert.equal(record.updatedAt, 'now');
  assert.throws(
    () => buildProjectRecord({ projectId: 'generated-project-id', input: { ...input, publishToSite: true }, timestamp: 'now' }),
    /cannot be set when creating/,
  );
});

test('project owner can update only editable fields and no-op or protected changes fail', async () => {
  const state = store();
  const result = await updateOwnedProjectTransaction({
    transaction: state.transaction,
    projectRef: state.projectRef,
    actorId: OWNER,
    changes: { title: ' Renamed ', status: 'playable', platforms: ['web', 'linux'] },
    timestamp: 'now',
  });
  assert.equal(result.title, 'Renamed');
  assert.deepEqual(state.writes, [{
    kind: 'project', update: { title: 'Renamed', status: 'playable', platforms: ['web', 'linux'], updatedAt: 'now' },
  }]);
  await assert.rejects(
    updateOwnedProjectTransaction({ transaction: state.transaction, projectRef: state.projectRef, actorId: OTHER, changes: { title: 'Nope' }, timestamp: 'now' }),
    /Only the project owner/,
  );
  await assert.rejects(
    updateOwnedProjectTransaction({ transaction: state.transaction, projectRef: state.projectRef, actorId: OWNER, changes: { ownerId: OTHER }, timestamp: 'now' }),
    /not editable/,
  );
  await assert.rejects(
    updateOwnedProjectTransaction({ transaction: state.transaction, projectRef: state.projectRef, actorId: OWNER, changes: { title: 'Renamed' }, timestamp: 'now' }),
    /do not modify/,
  );
});

test('publication changes only dormant Project publication state and require the owner', async () => {
  const state = store();
  await setProjectPublicationTransaction({
    transaction: state.transaction, projectRef: state.projectRef, actorId: OWNER, publishToSite: true, timestamp: 'now',
  });
  assert.deepEqual(state.writes, [{ kind: 'project', update: { publishToSite: true, updatedAt: 'now' } }]);
  assert.equal(state.data.project.slug, 'test-game');
  await assert.rejects(
    setProjectPublicationTransaction({ transaction: state.transaction, projectRef: state.projectRef, actorId: OTHER, publishToSite: false, timestamp: 'later' }),
    /Only the project owner/,
  );
  await assert.rejects(
    setProjectPublicationTransaction({ transaction: state.transaction, projectRef: state.projectRef, actorId: OWNER, publishToSite: 'true', timestamp: 'later' }),
    /must be a boolean/,
  );
});

test('thread linking requires shared ownership, rejects relinks, permits many threads, and does not touch points', async () => {
  const state = store({ thread: { threadId: THREAD_ONE, ownerId: OWNER, projectId: null, purpose: null } });
  await linkThreadToProjectTransaction({
    transaction: state.transaction, threadRef: state.threadRef, projectRef: state.projectRef,
    actorId: OWNER, projectId: 'project-1', purpose: 'feedback',
  });
  assert.deepEqual(state.writes, [{ kind: 'thread', update: { projectId: 'project-1', purpose: 'feedback' } }]);
  assert.deepEqual(new Set(state.reads), new Set(['thread', 'project']));
  assert.equal(state.reads.includes('points'), false);

  const writesBeforeIdempotentLink = state.writes.length;
  await linkThreadToProjectTransaction({
    transaction: state.transaction, threadRef: state.threadRef, projectRef: state.projectRef,
    actorId: OWNER, projectId: 'project-1', purpose: 'feedback',
  });
  assert.equal(state.writes.length, writesBeforeIdempotentLink);
  await assert.rejects(
    linkThreadToProjectTransaction({
      transaction: state.transaction, threadRef: state.threadRef, projectRef: state.projectRef,
      actorId: OWNER, projectId: 'project-2', purpose: 'feedback',
    }),
    /already linked to a different project/,
  );

  const secondThread = store({ thread: { threadId: THREAD_TWO, ownerId: OWNER, projectId: null, purpose: null } });
  await linkThreadToProjectTransaction({
    transaction: secondThread.transaction, threadRef: secondThread.threadRef, projectRef: secondThread.projectRef,
    actorId: OWNER, projectId: 'project-1', purpose: 'project-update',
  });
  assert.equal(secondThread.data.thread.projectId, 'project-1');
  assert.equal(secondThread.data.thread.purpose, 'project-update');

  const nonOwner = store({ thread: { threadId: THREAD_ONE, ownerId: OTHER, projectId: null, purpose: null } });
  await assert.rejects(
    linkThreadToProjectTransaction({
      transaction: nonOwner.transaction, threadRef: nonOwner.threadRef, projectRef: nonOwner.projectRef,
      actorId: OWNER, projectId: 'project-1', purpose: 'feedback',
    }),
    /Only the thread owner/,
  );

  const otherProjectOwner = store({
    thread: { threadId: THREAD_ONE, ownerId: OWNER, projectId: null, purpose: null },
    project: project({ ownerId: OTHER }),
  });
  await assert.rejects(
    linkThreadToProjectTransaction({
      transaction: otherProjectOwner.transaction, threadRef: otherProjectOwner.threadRef,
      projectRef: otherProjectOwner.projectRef, actorId: OWNER, projectId: 'project-1', purpose: 'feedback',
    }),
    /Only the project owner/,
  );
});
