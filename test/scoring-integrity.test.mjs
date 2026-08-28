import assert from 'node:assert/strict';
import test from 'node:test';
import { assertScoringPolicy } from '../src/lib/scoringPolicy.js';
import { buildEffectiveConfig } from '../src/services/config.js';
import {
  AwardResult,
  awardPointTransaction,
  buildPointEvent,
  revokePointTransaction,
} from '../src/services/scoring.js';

function ref(kind, id) {
  return { kind, id };
}

function snapshot(data) {
  return data === undefined
    ? { exists: false, data: () => undefined }
    : { exists: true, data: () => data };
}

function createStore(points = [], counter) {
  const pointDocs = new Map(points.map((point) => [point.id, point.data]));
  let counterData = counter;
  const transaction = {
    async get(target) {
      if (target.kind === 'query') {
        return {
          docs: [...pointDocs.entries()]
            .filter(([, data]) => data.threadId === target.threadId && data.commenterId === target.commenterId)
            .map(([id, data]) => ({ id, data: () => data })),
        };
      }
      return target.kind === 'point'
        ? snapshot(pointDocs.get(target.id))
        : snapshot(counterData);
    },
    create(target, data) {
      assert.equal(target.kind, 'point');
      assert.equal(pointDocs.has(target.id), false);
      pointDocs.set(target.id, data);
    },
    set(target, data) {
      assert.equal(target.kind, 'counter');
      counterData = data;
    },
    delete(target) {
      assert.equal(target.kind, 'point');
      pointDocs.delete(target.id);
    },
  };
  return {
    transaction,
    point: (id) => ref('point', id),
    counter: ref('counter', 'thread_user'),
    query: { kind: 'query', threadId: 'thread', commenterId: 'user' },
    get counterData() { return counterData; },
    get pointDocs() { return pointDocs; },
  };
}

function point(id, source = 'live') {
  return {
    threadId: 'thread',
    commentMessageId: id,
    commenterId: 'user',
    commenterTag: 'User',
    threadOwnerId: 'owner',
    source,
    isoWeek: '2026-W35',
    eventAt: 'event',
    awardedAt: 'awarded',
  };
}

test('scoring policy accepts bounded integers and rejects permissive values', () => {
  assert.doesNotThrow(() => assertScoringPolicy({ minCommentLength: 80, maxPointsPerThreadPerUser: 2 }));
  assert.throws(() => assertScoringPolicy({ minCommentLength: 0, maxPointsPerThreadPerUser: 2 }), /minCommentLength/);
  assert.throws(() => assertScoringPolicy({ minCommentLength: 80.5, maxPointsPerThreadPerUser: 2 }), /minCommentLength/);
  assert.throws(() => assertScoringPolicy({ minCommentLength: 80, maxPointsPerThreadPerUser: Number.NaN }), /maxPoints/);
  assert.throws(
    () => buildEffectiveConfig({ minCommentLength: 0, maxPointsPerThreadPerUser: 2 }),
    /Firestore effective scoring policy/,
  );
});

test('missing counter is initialized from legacy canonical points without adjustment events', async () => {
  const store = createStore([
    { id: 'legacy', data: point('legacy') },
    { id: 'adjustment', data: point('adjustment', 'adjustment') },
  ]);
  const result = await awardPointTransaction({
    transaction: store.transaction,
    pointRef: store.point('new'),
    counterRef: store.counter,
    existingPointsQuery: store.query,
    point: point('new'),
    cap: 3,
    timestamp: 'now',
  });
  assert.equal(result.result, AwardResult.AWARDED);
  assert.equal(store.counterData.count, 2);
  assert.equal(store.pointDocs.has('new'), true);
});

test('cap is atomic and duplicate events do not consume another slot', async () => {
  const store = createStore();
  for (const id of ['one', 'two']) {
    const result = await awardPointTransaction({
      transaction: store.transaction, pointRef: store.point(id), counterRef: store.counter,
      existingPointsQuery: store.query, point: point(id), cap: 2, timestamp: 'now',
    });
    assert.equal(result.result, AwardResult.AWARDED);
  }
  const duplicate = await awardPointTransaction({
    transaction: store.transaction, pointRef: store.point('two'), counterRef: store.counter,
    existingPointsQuery: store.query, point: point('two'), cap: 2, timestamp: 'now',
  });
  assert.equal(duplicate.result, AwardResult.ALREADY_SCORED);
  const capped = await awardPointTransaction({
    transaction: store.transaction, pointRef: store.point('three'), counterRef: store.counter,
    existingPointsQuery: store.query, point: point('three'), cap: 2, timestamp: 'now',
  });
  assert.equal(capped.result, AwardResult.AT_CAP);
  assert.equal(store.counterData.count, 2);
});

test('revoke decrements the matching counter and duplicate removals are idempotent', async () => {
  const store = createStore([
    { id: 'one', data: point('one') },
    { id: 'two', data: point('two') },
  ], { threadId: 'thread', commenterId: 'user', count: 2, updatedAt: 'before' });
  const revoke = () => revokePointTransaction({
    transaction: store.transaction, pointRef: store.point('one'), counterRef: store.counter,
    existingPointsQuery: store.query, threadId: 'thread', commenterId: 'user', timestamp: 'now',
  });
  assert.equal(await revoke(), true);
  assert.equal(store.counterData.count, 1);
  assert.equal(await revoke(), false);
  assert.equal(store.counterData.count, 1);
});

test('inconsistent counters fail closed during revoke', async () => {
  const store = createStore([{ id: 'one', data: point('one') }], {
    threadId: 'thread', commenterId: 'user', count: 0, updatedAt: 'before',
  });
  await assert.rejects(
    revokePointTransaction({
      transaction: store.transaction, pointRef: store.point('one'), counterRef: store.counter,
      existingPointsQuery: store.query, threadId: 'thread', commenterId: 'user', timestamp: 'now',
    }),
    /inconsistent point counter/i,
  );
});

test('live and rescan events preserve distinct provenance and time semantics', () => {
  const thread = { threadId: 'thread', ownerId: 'owner' };
  const comment = { id: 'comment', author: { id: 'user', tag: 'User' } };
  const live = buildPointEvent({ thread, comment, source: 'live', timestamp: 'now', week: '2026-W35' });
  const rescan = buildPointEvent({ thread, comment, source: 'rescan', timestamp: 'recovery', week: '2026-W35' });
  assert.deepEqual(
    { source: live.source, isoWeek: live.isoWeek, eventAt: live.eventAt, awardedAt: live.awardedAt },
    { source: 'live', isoWeek: '2026-W35', eventAt: 'now', awardedAt: 'now' },
  );
  assert.deepEqual(
    { source: rescan.source, isoWeek: rescan.isoWeek, eventAt: rescan.eventAt, awardedAt: rescan.awardedAt },
    { source: 'rescan', isoWeek: null, eventAt: null, awardedAt: 'recovery' },
  );
});
