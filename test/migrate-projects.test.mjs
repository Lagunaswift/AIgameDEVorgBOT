import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyMigrationRecordTransaction,
  buildMigrationProjectRecord,
  deriveProjectStatus,
  existingProjectIssues,
  planMigration,
  platformsFromTagNames,
  resolveSlug,
  slugifyBase,
} from '../src/services/migration.js';
import {
  PLAN_VERSION,
  applyPlan,
  assemblePlan,
  buildCandidates,
  consentStillActive,
  diffPlans,
  reconcileBaseline,
} from '../scripts/migrate-projects.mjs';

const OWNER = '123456789012345678';
const OTHER = '234567890123456789';
const THREAD_A = '345678901234567890';
const THREAD_B = '456789012345678901';
const THREAD_C = '567890123456789012';
const FORUM = '1051088980176805920';
const GUILD = '1051088980176805919';
const OTHER_GUILD = '9991088980176805999';
const PUBLISH_TAG = '1537600958245249154';
const WEB_TAG = '1111111111111111111';
const TARGET = { firebaseProject: 'aigame-dev', database: '(default)' };

// Simulates a real structured status source (the registry production uses is empty
// until a genuine source exists — these tests must not rely on that gate being open).
const TEST_STATUS_SOURCES = [{ name: 'test-structured-status', read: (thread) => thread.__testStatus ?? null }];

const DEFAULT_THREAD = {
  threadId: THREAD_A, forumId: FORUM, ownerId: OWNER, mode: 'showcase',
  projectId: null, purpose: null, __testStatus: 'development',
};

function candidate(overrides = {}) {
  return {
    threadId: THREAD_A,
    thread: { ...DEFAULT_THREAD },
    eligibility: { status: 'ok', forumId: FORUM, consentTag: true, ownerSource: 'thread.ownerId', jamThreadId: null },
    expectedThread: { mode: 'showcase', forumId: FORUM, projectUrl: null },
    title: 'Rhythm Of The Streets',
    summary: 'A rhythm game with tactical AI commands.',
    ownerId: OWNER,
    projectUrl: null,
    projectUrlInvalid: false,
    platforms: ['web'],
    unknownTags: ['meets guidelines'],
    extraBlockers: [],
    ...overrides,
    thread: {
      ...DEFAULT_THREAD,
      ...(overrides.threadId != null ? { threadId: overrides.threadId } : {}),
      ...(overrides.thread || {}),
    },
    expectedThread: {
      mode: 'showcase', forumId: FORUM, projectUrl: null,
      ...(overrides.expectedThread || {}),
    },
  };
}

function existingProject(overrides = {}) {
  const projectId = overrides.projectId ?? 'existing-project-1';
  return {
    projectId,
    _docId: projectId,
    ownerId: OWNER,
    title: 'Existing Game',
    slug: 'existing-game',
    summary: 'Existing summary.',
    status: 'development',
    projectUrl: null,
    platforms: [],
    publishToSite: true,
    profileThreadId: THREAD_A,
    createdAt: 'then',
    updatedAt: 'then',
    ...overrides,
    _docId: overrides._docId ?? projectId,
  };
}

function plan({ candidates, existingProjects = [], allocateProjectId } = {}) {
  let seq = 0;
  return planMigration({
    candidates,
    existingProjects,
    allocateProjectId: allocateProjectId || (() => `allocated-${++seq}`),
    statusSources: TEST_STATUS_SOURCES,
  });
}

// ---------- slug derivation ----------

test('slug derivation normalises unicode titles deterministically', () => {
  assert.equal(slugifyBase('Chronicles of Terros'), 'chronicles-of-terros');
  assert.equal(slugifyBase('  Café—Rhythm!!  '), 'cafe-rhythm');
  assert.equal(slugifyBase('Префектура'), ''); // fully non-latin → empty base
  assert.equal(slugifyBase('a'.repeat(150)).length, 100);
  assert.equal(slugifyBase(null), '');
});

test('slug resolution uses base, projectId suffix on collision, and blocks unresolvable ones', () => {
  assert.equal(resolveSlug({ base: 'new-game', projectId: 'ABC123', taken: new Set(['other']) }), 'new-game');
  assert.equal(resolveSlug({ base: 'new-game', projectId: 'ABC123', taken: new Set(['new-game']) }), 'new-game-abc123');
  // Base longer than the suffix budget is truncated so the total stays within 100.
  const long = resolveSlug({ base: 'a'.repeat(150), projectId: 'abc123', taken: new Set(['a'.repeat(100)]) });
  assert.equal(long.length, 100);
  assert.match(long, /-abc123$/);
  // A free over-long base is clamped rather than rejected.
  const clamped = resolveSlug({ base: 'a'.repeat(150), projectId: 'abc123', taken: new Set() });
  assert.equal(clamped, 'a'.repeat(100));
  assert.equal(resolveSlug({ base: '', projectId: 'ABC123', taken: new Set() }), 'project-abc123');
  // Even the suffixed candidate is occupied → unresolvable, caller blocks.
  assert.equal(resolveSlug({ base: 'game', projectId: 'abc', taken: new Set(['game', 'game-abc']) }), null);
});

// ---------- platforms ----------

test('platform extraction accepts exact enum names only and reports unknown tags', () => {
  assert.deepEqual(
    platformsFromTagNames(['iOS', ' macOS ', 'web', 'web', 'Publish to site', 'meets guidelines', '< 5 mins']),
    { platforms: ['web', 'macos', 'ios'], ignored: ['Publish to site', 'meets guidelines', '< 5 mins'] },
  );
  assert.deepEqual(platformsFromTagNames([]), { platforms: [], ignored: [] });
  assert.deepEqual(platformsFromTagNames(null), { platforms: [], ignored: [] });
  // Unknown tags are never coerced to "other".
  assert.deepEqual(platformsFromTagNames(['console']), { platforms: [], ignored: ['console'] });
});

// ---------- status gate ----------

test('status gate fails closed without an explicit structured source', () => {
  assert.deepEqual(deriveProjectStatus({}), { status: null, source: 'none' });
  const ambiguous = deriveProjectStatus({}, [
    { name: 'a', read: () => 'released' },
    { name: 'b', read: () => 'playable' },
  ]);
  assert.equal(ambiguous.status, null);
  assert.equal(ambiguous.source, 'ambiguous');
  assert.equal(deriveProjectStatus({}, [{ name: 'a', read: (t) => t.s ?? null }]).status, null);

  const planned = planMigration({ candidates: [candidate()], existingProjects: [] });
  const record = planned.records[0];
  assert.equal(record.disposition, 'blocked');
  assert.deepEqual(record.blockers, [{
    field: 'status',
    reason: 'no explicit structured status source exists',
    provenance: 'thread schema/Discord tags/export contract',
  }]);
});

// F10: a structured source that yields an unrecognised value is caught by the full
// Phase 2 validator in preflight, before any transaction could commit.
test('preflight applies the full Project validator to structured values', () => {
  const planned = plan({ candidates: [candidate({ thread: { __testStatus: 'beta' } })] });
  const record = planned.records[0];
  assert.equal(record.disposition, 'blocked');
  assert.equal(record.blockers[0].field, 'record');
  assert.match(record.blockers[0].reason, /status must be one of/);
  assert.equal(record.blockers[0].provenance, 'Phase 2 project contract');

  // Malformed owner ids are likewise blocked in preflight, not mid-apply.
  const badOwner = plan({ candidates: [candidate({ ownerId: 'not-an-id' })] });
  assert.equal(badOwner.records[0].disposition, 'blocked');
  assert.equal(badOwner.records[0].blockers[0].field, 'record');
});

// ---------- record construction ----------

test('migration record carries explicit consent and profile thread, validated like Phase 2', () => {
  const record = buildMigrationProjectRecord({
    projectId: 'opaque-id', ownerId: OWNER, title: 'Test Game', slug: 'test-game',
    summary: 'A game.', status: 'playable', projectUrl: 'https://example.com',
    platforms: ['web', 'ios'], profileThreadId: THREAD_A, timestamp: 'now',
  });
  assert.equal(record.publishToSite, true);
  assert.equal(record.profileThreadId, THREAD_A);
  assert.equal(record.projectId, 'opaque-id');
  assert.equal(record.createdAt, 'now');

  assert.throws(() => buildMigrationProjectRecord({
    projectId: 'x', ownerId: OWNER, title: 'T', slug: 't', summary: 's',
    status: 'beta', projectUrl: null, platforms: [], profileThreadId: THREAD_A, timestamp: 'now',
  }), /status must be one of/);
  assert.throws(() => buildMigrationProjectRecord({
    projectId: 'x', ownerId: OWNER, title: 'T', slug: 'Bad Slug', summary: 's',
    status: 'paused', projectUrl: null, platforms: [], profileThreadId: null, timestamp: 'now',
  }), /lowercase URL-safe/);
  assert.throws(() => buildMigrationProjectRecord({
    projectId: 'x', ownerId: OWNER, title: 'T', slug: 't', summary: 's',
    status: 'paused', projectUrl: 'ftp://x', platforms: [], profileThreadId: null, timestamp: 'now',
  }), /http\(s\)/);
});

// ---------- existing Project validation (F9) ----------

test('existing Project validation catches identity mismatches and malformed records', () => {
  assert.deepEqual(existingProjectIssues(existingProject()), []);
  assert.ok(existingProjectIssues(existingProject({ _docId: 'physical-id' })).length > 0);
  assert.ok(existingProjectIssues(existingProject({ createdAt: undefined })).length > 0);
  assert.ok(existingProjectIssues(existingProject({ publishToSite: 'yes' })).length > 0);
  assert.ok(existingProjectIssues(existingProject({ slug: 'Not Canonical' })).length > 0);
  assert.ok(existingProjectIssues({}).length > 0);
});

// ---------- planning ----------

test('clean candidates plan one Project each with deterministic identity and slugs', () => {
  const planned = plan({
    candidates: [candidate(), candidate({
      threadId: THREAD_B, title: 'Blow for Blow',
    })],
  });
  assert.deepEqual(planned.counts, { create: 2, alreadyLinked: 0, blocked: 0, conflict: 0 });
  const [a, b] = planned.records;
  assert.equal(a.disposition, 'create');
  assert.equal(a.slug, 'rhythm-of-the-streets');
  assert.equal(a.metadata.profileThreadId, THREAD_A);
  assert.equal(a.metadata.status, 'development');
  assert.notEqual(a.plannedProjectId, b.plannedProjectId);
  assert.equal(b.slug, 'blow-for-blow');
});

test('same-title threads resolve slug collisions with the opaque id suffix in stable thread order', () => {
  const planned = plan({
    candidates: [
      candidate({ title: 'Same Title', threadId: THREAD_B }),
      candidate({ title: 'Same Title' }),
    ],
  });
  const [first, second] = planned.records;
  assert.equal(first.threadId, THREAD_A, 'planned in ascending snowflake order');
  assert.equal(first.slug, 'same-title');
  assert.equal(second.slug, 'same-title-allocated-2');
});

test('existing slug occupancy forces the suffixed candidate or blocks', () => {
  const planned = plan({
    candidates: [candidate({ title: 'Existing Game' })],
    existingProjects: [existingProject({ profileThreadId: null, slug: 'existing-game' })],
  });
  assert.equal(planned.records[0].slug, 'existing-game-allocated-1');

  // A malformed physical record still owns its stored slug. Its validation issues do
  // not make the slug available for reuse by the migration (F9_A regression).
  const malformedOccupant = plan({
    candidates: [candidate({ title: 'Existing Game' })],
    existingProjects: [existingProject({
      profileThreadId: null,
      slug: 'existing-game',
      createdAt: undefined,
    })],
  });
  assert.equal(malformedOccupant.records[0].disposition, 'create');
  assert.equal(malformedOccupant.records[0].slug, 'existing-game-allocated-1');

  // A duplicate profile claimant is still an occupied physical Project and retains
  // its usable slug even though its relationship is diagnostically invalid.
  const duplicateClaimOccupant = plan({
    candidates: [candidate({ title: 'Existing Game' })],
    existingProjects: [
      existingProject({ projectId: 'claim-one', slug: 'existing-game' }),
      existingProject({ projectId: 'claim-two', slug: 'other-game' }),
    ],
  });
  assert.equal(duplicateClaimOccupant.records[0].disposition, 'conflict');
  assert.match(duplicateClaimOccupant.records[0].reason, /no backlink/);

  const unrelatedCandidate = candidate({ title: 'Existing Game', threadId: THREAD_B });
  const duplicateClaimSlug = plan({
    candidates: [unrelatedCandidate],
    existingProjects: [
      existingProject({ projectId: 'claim-one', slug: 'existing-game' }),
      existingProject({ projectId: 'claim-two', slug: 'other-game' }),
    ],
  });
  assert.equal(duplicateClaimSlug.records[0].slug, 'existing-game-allocated-1');
});

test('a consistent existing relationship is a rerun no-op', () => {
  const linked = candidate({ thread: { projectId: 'existing-project-1' } });
  const planned = plan({ candidates: [linked], existingProjects: [existingProject()] });
  assert.equal(planned.counts.alreadyLinked, 1);
  assert.equal(planned.counts.create, 0);
});

test('inconsistent existing relationships are reported conflicts, never repaired', () => {
  const base = { projectId: 'existing-project-1' };

  const dangling = plan({ candidates: [candidate({ thread: base })], existingProjects: [] });
  assert.equal(dangling.records[0].disposition, 'conflict');
  assert.match(dangling.records[0].reason, /dangling/);

  const noBacklink = plan({
    candidates: [candidate({ thread: base })],
    existingProjects: [existingProject({ profileThreadId: THREAD_B })],
  });
  assert.equal(noBacklink.records[0].disposition, 'conflict');
  assert.match(noBacklink.records[0].reason, /does not point back/);

  const ownerChanged = plan({
    candidates: [candidate({ thread: base })],
    existingProjects: [existingProject({ ownerId: OTHER })],
  });
  assert.equal(ownerChanged.records[0].disposition, 'conflict');
  assert.match(ownerChanged.records[0].reason, /owner differs/);

  const unpublished = plan({
    candidates: [candidate({ thread: base })],
    existingProjects: [existingProject({ publishToSite: false })],
  });
  assert.equal(unpublished.records[0].disposition, 'conflict');
  assert.match(unpublished.records[0].reason, /never republishes/);

  const claimedWithoutBacklink = plan({
    candidates: [candidate()],
    existingProjects: [existingProject({ profileThreadId: THREAD_A, projectId: 'other-project' })],
  });
  assert.equal(claimedWithoutBacklink.records[0].disposition, 'conflict');
  assert.match(claimedWithoutBacklink.records[0].reason, /no backlink/);
});

// F9: malformed existing Projects surface as conflicts, not silent acceptance.
test('malformed or duplicated existing Projects turn references into conflicts', () => {
  const embeddedIdMismatch = plan({
    candidates: [candidate({ thread: { projectId: 'existing-project-1' } })],
    existingProjects: [existingProject({ _docId: 'physical-id' })],
  });
  assert.equal(embeddedIdMismatch.records[0].disposition, 'conflict');
  assert.match(embeddedIdMismatch.records[0].reason, /malformed/);

  const malformedLinked = plan({
    candidates: [candidate({ thread: { projectId: 'existing-project-1' } })],
    existingProjects: [existingProject({ createdAt: undefined, updatedAt: undefined })],
  });
  assert.equal(malformedLinked.records[0].disposition, 'conflict');
  assert.match(malformedLinked.records[0].reason, /malformed/);

  const duplicateClaims = plan({
    candidates: [candidate()],
    existingProjects: [
      existingProject({ projectId: 'project-one', profileThreadId: THREAD_A }),
      existingProject({ projectId: 'project-two', profileThreadId: THREAD_A }),
    ],
  });
  assert.equal(duplicateClaims.records[0].disposition, 'conflict');
  assert.match(duplicateClaims.records[0].reason, /no backlink/);

  // A malformed Project claiming an otherwise-unlinked candidate thread remains a
  // claimant. Invalid records must not disappear from profile-claim indexing (F9_B).
  const malformedClaim = plan({
    candidates: [candidate()],
    existingProjects: [existingProject({
      projectId: 'malformed-claim',
      createdAt: undefined,
    })],
  });
  assert.equal(malformedClaim.records[0].disposition, 'conflict');
  assert.match(malformedClaim.records[0].reason, /malformed-claim.*no backlink/);

  // The same malformed claim cannot be masked by an unrelated valid Project.
  const mixedClaims = plan({
    candidates: [candidate()],
    existingProjects: [
      existingProject({ projectId: 'valid-other', profileThreadId: THREAD_B }),
      existingProject({ projectId: 'malformed-claim', createdAt: undefined }),
    ],
  });
  assert.equal(mixedClaims.records[0].disposition, 'conflict');
  assert.match(mixedClaims.records[0].reason, /malformed-claim.*no backlink/);

  // A valid linked Project is not accepted as a no-op when a malformed Project also
  // claims the same profile thread.
  const linkedWithMalformedDuplicate = plan({
    candidates: [candidate({ thread: { projectId: 'valid-link' } })],
    existingProjects: [
      existingProject({ projectId: 'valid-link' }),
      existingProject({ projectId: 'malformed-claim', createdAt: undefined }),
    ],
  });
  assert.equal(linkedWithMalformedDuplicate.records[0].disposition, 'conflict');
  assert.match(linkedWithMalformedDuplicate.records[0].reason, /claimed by multiple Projects/);

  // Both the embedded and physical identities of a malformed Project occupy ids;
  // neither can be reused to hide, overwrite, or repair that physical document.
  const mismatchedIdentity = existingProject({
    projectId: 'wrong-embedded-id',
    _docId: 'physical-id',
    profileThreadId: null,
  });
  const physicalIdOccupied = plan({
    candidates: [candidate()],
    existingProjects: [mismatchedIdentity],
    allocateProjectId: () => 'physical-id',
  });
  assert.equal(physicalIdOccupied.records[0].disposition, 'conflict');
  assert.match(physicalIdOccupied.records[0].reason, /already occupied/);
  const embeddedIdOccupied = plan({
    candidates: [candidate()],
    existingProjects: [mismatchedIdentity],
    allocateProjectId: () => 'wrong-embedded-id',
  });
  assert.equal(embeddedIdOccupied.records[0].disposition, 'conflict');
  assert.match(embeddedIdOccupied.records[0].reason, /already occupied/);
});

test('existing Project conflict output is invariant to fixture order', () => {
  const existing = [
    existingProject({ projectId: 'z-malformed', createdAt: undefined }),
    existingProject({ projectId: 'a-valid' }),
  ];
  const linked = candidate({ thread: { projectId: 'a-valid' } });
  const forward = plan({ candidates: [linked], existingProjects: existing });
  const reversed = plan({ candidates: [linked], existingProjects: [...existing].reverse() });
  assert.deepEqual(forward, reversed);
  assert.equal(forward.records[0].disposition, 'conflict');
  assert.match(forward.records[0].reason, /claimed by multiple Projects \(a-valid, z-malformed\)/);
});

test('missing or ambiguous metadata blocks records instead of inventing values', () => {
  const cases = [
    [{ title: null }, 'title', /missing/],
    [{ title: '   ' }, 'title', /missing/],
    [{ summary: null }, 'summary', /missing/],
    [{ ownerId: null }, 'ownerId', /missing/],
    [{ projectUrl: 'notaurl', projectUrlInvalid: true }, 'projectUrl', /invalid http/],
    [{ extraBlockers: [{ field: 'ownerId', reason: 'registered owner differs from live Discord owner', provenance: 'x' }] }, 'ownerId', /differs from live Discord owner/],
    [{ extraBlockers: [{ field: 'summary', reason: 'starter message inaccessible; cannot derive the public description', provenance: 'starter message' }] }, 'summary', /starter message inaccessible/],
  ];
  for (const [overrides, field, re] of cases) {
    const planned = plan({ candidates: [candidate(overrides)] });
    const record = planned.records[0];
    assert.equal(record.disposition, 'blocked', `${field} should block`);
    const blocker = record.blockers.find((b) => b.field === field);
    assert.ok(blocker, `${field} blocker present`);
    assert.match(blocker.reason, re);
  }
  // No auto-defaults anywhere: every missing gate surfaces as its own blocker
  // (status stays satisfied via the structured test source).
  const multi = plan({ candidates: [candidate({ summary: null, ownerId: null })] });
  assert.deepEqual(
    multi.records[0].blockers.map((b) => b.field).sort(),
    ['ownerId', 'summary'],
  );
});

// ---------- transactional apply ----------

function store({ thread = null, project = null } = {}) {
  const data = new Map();
  if (thread) data.set(`threads/${thread.threadId}`, { ...thread });
  if (project) data.set(`projects/${project.projectId}`, { ...project });
  const writes = [];
  const ref = (kind, id) => ({ kind, id, key: `${kind}s/${id}` });
  const transaction = {
    async get(r) {
      const value = data.get(r.key);
      return value === undefined
        ? { exists: false, data: () => undefined }
        : { exists: true, data: () => value };
    },
    set(r, value) { writes.push({ op: 'set', key: r.key, value }); data.set(r.key, value); },
    update(r, update) { writes.push({ op: 'update', key: r.key, update }); Object.assign(data.get(r.key), update); },
  };
  return { data, writes, transaction, ref };
}

function planRecord(overrides = {}) {
  return {
    threadId: THREAD_A,
    disposition: 'create',
    plannedProjectId: 'allocated-1',
    slug: 'rhythm-of-the-streets',
    eligibility: { forumId: FORUM, consentTag: true },
    expectedThread: { mode: 'showcase', forumId: FORUM, projectUrl: null },
    metadata: {
      ownerId: OWNER, title: 'Rhythm Of The Streets', slug: 'rhythm-of-the-streets',
      summary: 'A rhythm game with tactical AI commands.', status: 'development',
      projectUrl: null, platforms: ['web'], profileThreadId: THREAD_A,
    },
    ...overrides,
  };
}

function threadDoc(overrides = {}) {
  return {
    threadId: THREAD_A, forumId: FORUM, ownerId: OWNER, mode: 'showcase',
    projectId: null, purpose: null, projectUrl: null,
    createdAt: 'then', registeredAt: 'then',
    ...overrides,
  };
}

function applyTo(state, record) {
  return applyMigrationRecordTransaction({
    transaction: state.transaction,
    threadRef: state.ref('thread', record.threadId),
    projectRef: state.ref('project', record.plannedProjectId),
    planRecord: record,
    timestamp: 'now',
  });
}

test('apply commits Project creation and thread backlink atomically, preserving all other fields', async () => {
  const state = store({ thread: threadDoc() });
  const project = await applyTo(state, planRecord());
  assert.equal(project.publishToSite, true);
  assert.equal(project.profileThreadId, THREAD_A);

  const thread = state.data.get(`threads/${THREAD_A}`);
  assert.equal(thread.projectId, 'allocated-1');
  assert.equal(thread.purpose, null, 'purpose preserved');
  assert.equal(thread.createdAt, 'then', 'scoring/registration identity preserved');

  assert.deepEqual(state.writes.map((w) => w.op), ['set', 'update']);
  assert.deepEqual(state.writes[1].update, { projectId: 'allocated-1' }, 'only the backlink is written');
});

test('apply fails closed on occupied ids, vanished threads, and changed state', async () => {
  // Occupied planned id.
  const occupied = store({ thread: threadDoc(), project: existingProject({ projectId: 'allocated-1' }) });
  await assert.rejects(applyTo(occupied, planRecord()), /already occupied/);
  assert.equal(occupied.writes.length, 0);

  // Thread vanished.
  const vanished = store({});
  await assert.rejects(applyTo(vanished, planRecord()), /disappeared/);

  // Thread already linked (duplicate/concurrent guard).
  const linked = store({ thread: threadDoc({ projectId: 'someone-elses' }) });
  await assert.rejects(applyTo(linked, planRecord()), /gained a Project link/);
  assert.equal(linked.writes.length, 0);

  // Owner changed since planning — including disappearing to null.
  const reowned = store({ thread: threadDoc({ ownerId: OTHER }) });
  await assert.rejects(applyTo(reowned, planRecord()), /owner changed/);
  const deowned = store({ thread: threadDoc({ ownerId: null }) });
  await assert.rejects(applyTo(deowned, planRecord()), /owner changed/);
});

// F8: even a backlink equal to the planned id must not be silently accepted or
// repaired — the create was planned against a null backlink.
test('apply refuses a backlink that appeared after planning, even matching the planned id', async () => {
  const state = store({ thread: threadDoc({ projectId: 'allocated-1' }) });
  await assert.rejects(applyTo(state, planRecord()), /gained a Project link/);
  assert.equal(state.writes.length, 0);
});

// F7: stale Firestore source fields fail closed inside the transaction.
test('apply revalidates thread mode, forum, projectUrl, and owner against the plan snapshot', async () => {
  await assert.rejects(
    applyTo(store({ thread: threadDoc({ mode: 'competition' }) }), planRecord()),
    /mode changed/,
  );
  await assert.rejects(
    applyTo(store({ thread: threadDoc({ forumId: '9991088980176805999' }) }), planRecord()),
    /source forum changed/,
  );
  await assert.rejects(
    applyTo(store({ thread: threadDoc({ projectUrl: 'https://later.example' }) }), planRecord()),
    /projectUrl changed/,
  );
  const noSnapshot = planRecord({ expectedThread: undefined });
  await assert.rejects(
    applyTo(store({ thread: threadDoc() }), noSnapshot),
    /lacks the expectedThread snapshot/,
  );
});

test('re-applying after a successful commit creates nothing; a replan sees already-linked', async () => {
  const state = store({ thread: threadDoc() });
  await applyTo(state, planRecord());

  // A second attempt with the same plan: the project id is now occupied.
  await assert.rejects(applyTo(state, planRecord()), /already occupied|gained a Project link/);
  assert.equal(state.data.get(`threads/${THREAD_A}`).projectId, 'allocated-1');

  // A rerun that replans sees an already-linked relationship and writes nothing.
  const replanned = plan({
    candidates: [candidate({ thread: { projectId: 'allocated-1' } })],
    existingProjects: [{ ...state.data.get('projects/allocated-1'), _docId: 'allocated-1' }],
  });
  assert.equal(replanned.counts.alreadyLinked, 1);
  assert.equal(replanned.counts.create, 0);
});

// ---------- plan stability across apply re-preflight (F3) ----------

function fakeIdDb(prefix) {
  let seq = 0;
  return { collection: () => ({ doc: () => ({ id: `${prefix}-${++seq}` }) }) };
}

test('apply preflight replays reviewed plan ids so unchanged state shows zero drift', () => {
  const candidates = [candidate(), candidate({ threadId: THREAD_B, title: 'Second Game' })];
  const common = { target: TARGET, publishTagId: PUBLISH_TAG, excluded: [], existingProjects: [], baseline: null, statusSources: TEST_STATUS_SOURCES };

  const dryRun = assemblePlan({ db: fakeIdDb('dry'), candidates, ...common });
  assert.equal(dryRun.counts.create, 2);
  assert.equal(dryRun.mode, 'dry-run');

  // Fresh random ids (the old behaviour) would false-drift; replayed ids must not.
  const replayIds = new Map(dryRun.records.map((r) => [r.threadId, r.plannedProjectId]));
  const replayed = assemblePlan({ db: fakeIdDb('fresh'), candidates, replayIds, ...common });
  assert.equal(replayed.mode, 'apply-preflight');
  assert.deepEqual(
    replayed.records.map((r) => [r.threadId, r.plannedProjectId]),
    dryRun.records.map((r) => [r.threadId, r.plannedProjectId]),
  );
  assert.deepEqual(diffPlans(dryRun, replayed), []);

  // A genuinely changed plan still drifts.
  const drifted = assemblePlan({ db: fakeIdDb('fresh'), candidates, replayIds, ...common });
  drifted.records[0].slug = 'edited';
  assert.ok(diffPlans(dryRun, drifted).length > 0);
});

// ---------- plan comparison + baseline ----------

function fullPlan(records, excluded = [], overrides = {}) {
  return {
    version: PLAN_VERSION,
    target: TARGET,
    publishTagId: PUBLISH_TAG,
    counts: {
      create: records.filter((r) => r.disposition === 'create').length,
      alreadyLinked: records.filter((r) => r.disposition === 'already-linked').length,
      blocked: records.filter((r) => r.disposition === 'blocked').length,
      conflict: records.filter((r) => r.disposition === 'conflict').length,
    },
    records,
    excluded,
    ...overrides,
  };
}

test('plan drift detection fails closed', () => {
  const reviewed = fullPlan([planRecord()]);
  assert.deepEqual(diffPlans(reviewed, fullPlan([planRecord()])), []);
  assert.ok(diffPlans(reviewed, fullPlan([planRecord({ disposition: 'already-linked' })])).length > 0);
  assert.ok(diffPlans(reviewed, fullPlan([planRecord({ slug: 'changed' })])).length > 0);
  const driftedMeta = fullPlan([planRecord({ metadata: { ...planRecord().metadata, title: 'Edited' } })]);
  assert.deepEqual(diffPlans(reviewed, driftedMeta), [`${THREAD_A}|metadata-drift`]);
  const driftedSource = fullPlan([planRecord({ expectedThread: { ...planRecord().expectedThread, projectUrl: 'https://x' } })]);
  assert.deepEqual(diffPlans(reviewed, driftedSource), [`${THREAD_A}|source-state-drift`]);
  assert.ok(diffPlans(reviewed, fullPlan([planRecord()], [{ threadId: THREAD_B, reason: 'not-published' }])).length > 0);
});

// F13: reconciliation reports evidence, never invented publication history.
test('baseline reconciliation reports differences without inventing explanations', () => {
  const create = planRecord();
  const baseline = { version: 2, games: [{ id: THREAD_A }, { id: THREAD_B }] };
  const reconciled = reconcileBaseline(baseline, {
    records: [create],
    excluded: [{ threadId: THREAD_C, disposition: 'excluded', reason: 'not-published' }],
  });
  assert.equal(reconciled.supplied, true);
  assert.match(reconciled.scope, /id-set cross-check only/);

  const byId = new Map(reconciled.differences.map((d) => [d.threadId, d]));
  assert.match(byId.get(THREAD_B).explanation, /cause not established/);
  assert.equal(byId.get(THREAD_C).difference, 'excluded-but-not-in-baseline');
  assert.match(byId.get(THREAD_C).explanation, /no publication history inferred/);

  const clean = reconcileBaseline({ version: 2, games: [{ id: THREAD_A }] }, { records: [create], excluded: [] });
  assert.deepEqual(clean.differences, []);
});

// ---------- consent recheck + apply orchestration ----------

function restWithConsent(consent) {
  const consentFor = typeof consent === 'boolean' ? () => consent : (id) => consent[id];
  return {
    async get(url) {
      const m = /^\/channels\/(\d+)$/.exec(url);
      if (m) {
        if (!consentFor(m[1])) throw Object.assign(new Error('404'), { status: 404 });
        return { id: m[1], parent_id: FORUM, applied_tags: [PUBLISH_TAG] };
      }
      throw new Error(`unexpected url ${url}`);
    },
  };
}

function dbBackedBy(state) {
  return {
    async runTransaction(fn) { return fn(state.transaction); },
    // applyPlan builds its own refs from collection/doc paths before each transaction.
    collection: (name) => ({
      doc: (id) => state.ref(name === 'threads' ? 'thread' : 'project', id),
    }),
  };
}

test('consent recheck reads the full live boundary immediately before apply', async () => {
  assert.equal(await consentStillActive(restWithConsent(true), planRecord(), PUBLISH_TAG), true);
  assert.equal(await consentStillActive(restWithConsent(false), planRecord(), PUBLISH_TAG), false);
  // Parent forum drift also fails the recheck, not just the tag bit.
  const movedForum = {
    async get(url) {
      const m = /^\/channels\/(\d+)$/.exec(url);
      if (m) return { id: m[1], parent_id: OTHER_GUILD, applied_tags: [PUBLISH_TAG] };
      throw new Error(`unexpected url ${url}`);
    },
  };
  assert.equal(await consentStillActive(movedForum, planRecord(), PUBLISH_TAG), false);
});

test('applyPlan refuses blocked, stale, and mis-bound plans', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-test-'));

  const blockedPlan = fullPlan([planRecord({ disposition: 'blocked', blockers: [{ field: 'status' }] })]);
  await assert.rejects(
    applyPlan({ db: dbBackedBy(store()), rest: restWithConsent(true), reviewed: blockedPlan, fresh: blockedPlan, publishTagId: PUBLISH_TAG, outDir: tmp }),
    /blocked record/,
  );

  const oldVersion = fullPlan([planRecord()], [], { version: 1 });
  await assert.rejects(
    applyPlan({ db: dbBackedBy(store()), rest: restWithConsent(true), reviewed: oldVersion, fresh: fullPlan([planRecord()]), publishTagId: PUBLISH_TAG, outDir: tmp }),
    /version/,
  );

  const reviewed = fullPlan([planRecord()]);
  const stale = fullPlan([planRecord({ slug: 'drifted' })]);
  await assert.rejects(
    applyPlan({ db: dbBackedBy(store()), rest: restWithConsent(true), reviewed, fresh: stale, publishTagId: PUBLISH_TAG, outDir: tmp }),
    /stale/,
  );

  // F4: the approval is bound to the reviewed target and consent tag.
  const otherTarget = fullPlan([planRecord()], [], { target: { firebaseProject: 'other-project', database: '(default)' } });
  await assert.rejects(
    applyPlan({ db: dbBackedBy(store()), rest: restWithConsent(true), reviewed: otherTarget, fresh: reviewed, publishTagId: PUBLISH_TAG, outDir: tmp }),
    /does not match live target/,
  );
  const otherTag = fullPlan([planRecord()], [], { publishTagId: '9999999999999999999' });
  await assert.rejects(
    applyPlan({ db: dbBackedBy(store()), rest: restWithConsent(true), reviewed: otherTag, fresh: reviewed, publishTagId: PUBLISH_TAG, outDir: tmp }),
    /consent tag/,
  );

  // Consent revoked before any write: nothing is committed.
  const consentRevoked = fullPlan([planRecord()]);
  const state = store({ thread: threadDoc() });
  await assert.rejects(
    applyPlan({ db: dbBackedBy(state), rest: restWithConsent(false), reviewed: consentRevoked, fresh: consentRevoked, publishTagId: PUBLISH_TAG, outDir: tmp }),
    /lost Publish-to-site consent/,
  );
  assert.equal(state.writes.length, 0, 'consent revocation writes nothing');

  await fs.rm(tmp, { recursive: true, force: true });
});

test('applyPlan commits clean plans and every stop path reports committed records', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-test-'));

  const state = store({ thread: threadDoc() });
  const good = fullPlan([planRecord()]);
  const outcomes = await applyPlan({
    db: dbBackedBy(state), rest: restWithConsent(true),
    reviewed: good, fresh: good, publishTagId: PUBLISH_TAG, outDir: tmp,
  });
  assert.deepEqual(outcomes, [{ threadId: THREAD_A, projectId: 'allocated-1', result: 'committed' }]);
  assert.equal(state.data.get(`threads/${THREAD_A}`).projectId, 'allocated-1');

  // F5: a consent loss on the SECOND record (outside the transaction try/catch in the
  // old design) still stops with a structured report listing the committed first record.
  const stateTwo = store({ thread: threadDoc() });
  stateTwo.data.set(`threads/${THREAD_B}`, threadDoc({ threadId: THREAD_B }));
  const twoRecords = fullPlan([
    planRecord(),
    planRecord({ threadId: THREAD_B, plannedProjectId: 'allocated-2', slug: 'second', metadata: { ...planRecord().metadata, profileThreadId: THREAD_B } }),
  ]);
  await assert.rejects(
    applyPlan({
      db: dbBackedBy(stateTwo),
      rest: restWithConsent({ [THREAD_A]: true, [THREAD_B]: false }),
      reviewed: twoRecords, fresh: twoRecords, publishTagId: PUBLISH_TAG, outDir: tmp,
    }),
    /lost Publish-to-site consent/,
  );
  assert.equal(stateTwo.data.get(`threads/${THREAD_A}`).projectId, 'allocated-1', 'first record committed');

  let reportFiles = await fs.readdir(tmp);
  assert.ok(reportFiles.some((f) => f.startsWith('apply-failed-')), 'failure report written');
  const consentReport = JSON.parse(await fs.readFile(path.join(tmp, reportFiles.find((f) => f.startsWith('apply-failed-'))), 'utf8'));
  assert.equal(consentReport.outcomes[0].result, 'committed');
  assert.equal(consentReport.outcomes[1].result, 'failed');
  assert.match(consentReport.error, /consent/);

  // Transaction failure path: same reporting guarantee.
  const stateThree = store({ thread: threadDoc() });
  stateThree.data.set(`threads/${THREAD_B}`, threadDoc({ threadId: THREAD_B }));
  stateThree.data.set('projects/allocated-2', existingProject({ projectId: 'allocated-2' }));
  await assert.rejects(
    applyPlan({ db: dbBackedBy(stateThree), rest: restWithConsent(true), reviewed: twoRecords, fresh: twoRecords, publishTagId: PUBLISH_TAG, outDir: tmp }),
    /apply failed at/,
  );
  reportFiles = await fs.readdir(tmp);
  const failureReports = reportFiles.filter((f) => f.startsWith('apply-failed-'));
  assert.ok(failureReports.length >= 2);
  const txReport = JSON.parse(await fs.readFile(path.join(tmp, failureReports[failureReports.length - 1]), 'utf8'));
  assert.equal(txReport.outcomes[0].result, 'committed');
  assert.equal(txReport.outcomes[1].result, 'failed');

  await fs.rm(tmp, { recursive: true, force: true });
});

// ---------- candidate building (live-boundary semantics, F11/F12) ----------

function dbWithDocs(docs) {
  return {
    collection: () => ({
      where: () => ({
        get: async () => ({ docs }),
      }),
    }),
  };
}

function threadDocSnap(data) {
  return { id: data.threadId, data: () => data };
}

function restFor({ consent = true, guildId = GUILD, starter = { content: 'A public description.' } } = {}) {
  return {
    async get(url) {
      if (url === `/channels/${FORUM}`) {
        return {
          available_tags: [
            { id: PUBLISH_TAG, name: 'Publish to site', emoji_id: null, emoji_name: null },
            { id: WEB_TAG, name: 'web', emoji_id: null, emoji_name: null },
          ],
        };
      }
      const channel = /^\/channels\/(\d+)$/.exec(url);
      if (channel) {
        if (!consent) throw Object.assign(new Error('404'), { status: 404 });
        return {
          id: channel[1], parent_id: FORUM, guild_id: guildId, name: 'Guild Game', owner_id: OWNER,
          applied_tags: consent ? [PUBLISH_TAG, WEB_TAG] : [WEB_TAG],
        };
      }
      const starterMatch = /^\/channels\/(\d+)\/messages\/\1$/.exec(url);
      if (starterMatch) {
        if (!starter) throw Object.assign(new Error('404'), { status: 404 });
        return starter;
      }
      throw new Error(`unexpected url ${url}`);
    },
  };
}

test('buildCandidates enforces the live guild boundary and treats unreadable starters as blockers', async (t) => {
  const { config } = await import('../src/config.js');
  const originalGuildId = config.guildId;
  config.guildId = GUILD;
  t.after(() => { config.guildId = originalGuildId; });

  const doc = {
    threadId: THREAD_A, forumId: FORUM, ownerId: OWNER, mode: 'showcase',
    projectId: null, purpose: null,
  };

  // Happy path: guild matches, consent present, starter readable.
  const ok = await buildCandidates(dbWithDocs([threadDocSnap(doc)]), restFor(), PUBLISH_TAG);
  assert.equal(ok.excluded.length, 0);
  assert.equal(ok.candidates.length, 1);
  const [okCandidate] = ok.candidates;
  assert.equal(okCandidate.summary, 'A public description.');
  assert.deepEqual(okCandidate.platforms, ['web']);
  assert.deepEqual(okCandidate.unknownTags, ['Publish to site']);
  assert.deepEqual(okCandidate.expectedThread, { mode: 'showcase', forumId: FORUM, projectUrl: null });

  // F11: a channel in another guild is excluded even though the Firestore doc says showcase.
  const wrongGuild = await buildCandidates(dbWithDocs([threadDocSnap(doc)]), restFor({ guildId: OTHER_GUILD }), PUBLISH_TAG);
  assert.equal(wrongGuild.candidates.length, 0);
  assert.equal(wrongGuild.excluded[0].reason, 'wrong-guild');

  // F12: consent-tagged public thread with an inaccessible starter message is a
  // blocker candidate, not an exclusion.
  const noStarter = await buildCandidates(dbWithDocs([threadDocSnap(doc)]), restFor({ starter: null }), PUBLISH_TAG);
  assert.equal(noStarter.excluded.length, 0);
  assert.equal(noStarter.candidates.length, 1);
  const summaryBlocker = noStarter.candidates[0].extraBlockers.find((b) => b.field === 'summary');
  assert.ok(summaryBlocker);
  assert.match(summaryBlocker.reason, /starter message inaccessible/);
  // And the planned record is blocked (completeness), never silently skipped.
  const planned = plan({ candidates: noStarter.candidates });
  assert.equal(planned.records[0].disposition, 'blocked');
});
