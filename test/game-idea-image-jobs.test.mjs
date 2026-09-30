import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageJobStore, createImageJobService, validateImageJob } from '../src/services/gameIdeaImageJobs.js';
import { readImageConfig } from '../src/lib/gameIdeaScreenshot.js';
import { sampleBrief } from './fixtures/game-idea-image.mjs';
const cfg = readImageConfig({ GAME_IDEA_IMAGES_ENABLED: 'true', GEMINI_API_KEY: 'unit-test' });
const job = n => ({ messageId: String(1553439895924510800n + BigInt(n)), channelId: '1553439895924510802', guildId: '1051088980176805919', idea: '**Title** A game about a fleet microwave.', style: 'auto' });
const pass = { safe: true, noText: true, singleGameplayScreen: true, styleMatches: true, mechanicVisible: true };
const image = { buffer: Buffer.from('image'), mimeType: 'image/jpeg' };

// This serial fake exercises logic; a separate real-emulator suite verifies contention.
function fakeDb() {
  const data = new Map(); let serial = Promise.resolve();
  const ref = path => ({ path, update: async fields => {
    if (!data.has(path)) throw new Error('not found');
    data.set(path, { ...data.get(path), ...fields });
  } });
  return {
    data,
    collection: name => ({ doc: id => ref(`${name}/${id}`) }),
    runTransaction(fn) {
      const next = serial.then(async () => {
        const writes = [];
        const out = await fn({
          get: async r => ({ exists: data.has(r.path), data: () => data.get(r.path) }),
          set: (r, fields, options) => writes.push(() => data.set(r.path, options?.merge ? { ...data.get(r.path), ...fields } : fields)),
          update: (r, fields) => writes.push(() => data.set(r.path, { ...data.get(r.path), ...fields })),
        });
        writes.forEach(w => w()); return out;
      });
      serial = next.catch(() => {}); return next;
    },
  };
}
function harness(overrides = {}) {
  const counts = { direct: 0, render: 0, review: 0, send: 0, normalise: 0, check: 0 };
  const db = fakeDb();
  const store = createImageJobStore(db, () => new Date('2026-09-30T20:00:00Z'));
  const model = {
    direct: async () => { counts.direct++; return sampleBrief(); },
    render: async () => { counts.render++; return image; },
    review: async () => { counts.review++; return pass; },
    ...overrides.model,
  };
  const delivery = {
    check: async () => { counts.check++; return true; },
    send: async () => { counts.send++; return { id: '1553439895924510999' }; },
    ...overrides.delivery,
  };
  const logs = [];
  const service = createImageJobService({ cfg: { ...cfg, ...overrides.cfg }, store: overrides.store ?? store,
    model, delivery, normalise: overrides.normalise ?? (async x => { counts.normalise++; return x; }),
    delay: async () => {}, log: (event, fields) => logs.push({ event, ...fields }) });
  return { counts, db, store, model, delivery, logs, service, run: async n => service.enqueue(job(n)).done };
}

test('success: one director, one render, one review, one original-message delivery', async () => {
  const h = harness(); assert.equal((await h.run(1)).status, 'sent');
  assert.equal(h.counts.render, 1); assert.equal(h.counts.review, 1); assert.equal(h.counts.send, 1);
  const record = h.db.data.get(`gameIdeaImageJobs/${job(1).messageId}`);
  assert.equal(record.status, 'sent'); assert.equal(record.attempts, 1);
  assert.ok(!JSON.stringify(record).includes('microwave'));
});
test('each quality failure permits exactly one bounded correction', async () => {
  for (const key of ['noText', 'singleGameplayScreen', 'styleMatches', 'mechanicVisible']) {
    const h = harness(); let reviews = 0; const corrections = [];
    h.model.review = async () => ++reviews === 1 ? { ...pass, [key]: false } : pass;
    h.model.render = async (_brief, previous) => { corrections.push(previous); h.counts.render++; return image; };
    assert.equal((await h.run(2)).status, 'sent');
    assert.equal(h.counts.render, 2); assert.equal(h.counts.send, 1);
    assert.equal(corrections[0], null); assert.equal(corrections[1][key], false);
  }
});
test('two failed reviews never post, and a safety failure never gets a corrective reroll', async () => {
  const h = harness({ model: { review: async () => ({ ...pass, noText: false }) } });
  assert.equal((await h.run(3)).status, 'rejected'); assert.equal(h.counts.render, 2); assert.equal(h.counts.send, 0);
  const unsafe = harness({ model: { review: async () => ({ ...pass, safe: false }) } });
  assert.equal((await unsafe.run(4)).status, 'rejected'); assert.equal(unsafe.counts.render, 1); assert.equal(unsafe.counts.send, 0);
  const brief = harness({ model: { direct: async () => ({ ...sampleBrief(), safe: false }) } });
  assert.equal((await brief.run(5)).status, 'rejected'); assert.equal(brief.counts.render, 0);
});
test('malformed review, decoder failure and ambiguous generation failures stop without retry', async () => {
  for (const overrides of [
    { model: { review: async () => ({ safe: true }) } },
    { normalise: async () => { throw new Error('image_invalid_bytes'); } },
    { model: { render: async () => { throw new Error('gemini_network_or_timeout'); } } },
    { model: { direct: async () => { throw new Error('SECRET-DO-NOT-LOG'); } } },
  ]) {
    const h = harness(overrides); assert.equal((await h.run(6)).status, 'failed');
    assert.equal(h.counts.send, 0); assert.ok(h.counts.render <= 1);
    assert.ok(!JSON.stringify(h.logs).includes('SECRET-DO-NOT-LOG'));
  }
});
test('upload retry reuses identical bytes, no regeneration', async () => {
  const h = harness(); const seen = [];
  h.delivery.send = async (_job, actual) => {
    seen.push(actual); if (seen.length === 1) throw Object.assign(new Error('temporary'), { status: 503 });
    return { id: '1553439895924510999' };
  };
  assert.equal((await h.run(7)).status, 'sent'); assert.equal(h.counts.render, 1);
  assert.equal(seen.length, 2); assert.equal(seen[0].buffer, seen[1].buffer);
});
test('permanent Discord failure is not retried and a missing original consumes no budget', async () => {
  let sends = 0;
  const h = harness({ delivery: { send: async () => { sends++; throw Object.assign(new Error('gone'), { status: 404 }); } } });
  assert.equal((await h.run(8)).status, 'failed'); assert.equal(sends, 1);
  const unavailable = harness({ delivery: { check: async () => false } });
  assert.equal((await unavailable.run(9)).status, 'unavailable');
  assert.equal(unavailable.counts.direct, 0); assert.equal(unavailable.db.data.size, 0);
});
test('original deleted after rendering is not posted', async () => {
  const h = harness(); let checks = 0;
  h.delivery.check = async () => ++checks < 3;
  assert.equal((await h.run(10)).status, 'unavailable'); assert.equal(h.counts.send, 0);
});
test('persistent and in-process dedup prevent repeated paid work', async () => {
  const h = harness(); const first = h.service.enqueue(job(11));
  assert.equal(h.service.enqueue(job(11)).status, 'duplicate');
  await first.done;
  assert.equal((await h.run(11)).status, 'duplicate'); assert.equal(h.counts.direct, 1);
  const restarted = createImageJobService({ cfg, store: h.store, model: h.model, delivery: h.delivery, normalise: async x => x, log: () => {} });
  assert.equal((await restarted.enqueue(job(11)).done).status, 'duplicate');
  assert.equal(h.counts.render, 1);
});
test('budget zero, no credential and flag off do not enqueue', () => {
  for (const setting of [{ dailyCap: 0 }, { apiKey: '' }, { enabled: false }]) {
    const h = harness({ cfg: setting }); assert.equal(h.service.enqueue(job(12)).status, 'disabled');
    assert.equal(h.db.data.size, 0);
  }
});
test('queue is bounded, preserves order and runs only one job at a time', async () => {
  const h = harness({ cfg: { queueSize: 2 } }); const order = [];
  let release; const gate = new Promise(r => { release = r; });
  h.model.direct = async () => { order.push('direct'); await gate; return sampleBrief(); };
  const first = h.service.enqueue(job(13)); const second = h.service.enqueue(job(14));
  assert.equal(h.service.enqueue(job(15)).status, 'full');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(order.length, 1);
  release(); await Promise.all([first.done, second.done]); assert.equal(order.length, 2);
});
test('daily admission is transactional, failures are not refunded, and next UTC day resets', async () => {
  const db = fakeDb(); let at = new Date('2026-09-30T23:59:59Z');
  const store = createImageJobStore(db, () => at); const low = { ...cfg, dailyCap: 1 };
  const claims = await Promise.all([store.claim(job(16), low), store.claim(job(17), low)]);
  assert.deepEqual(claims.sort(), ['capped', 'claimed']);
  assert.equal(await store.reserveRender(job(16).messageId, low), true);
  await store.update(job(16).messageId, { status: 'failed' });
  assert.equal(await store.claim(job(18), low), 'capped');
  at = new Date('2026-10-01T00:00:00Z'); assert.equal(await store.claim(job(18), low), 'claimed');
});
test('per-job and independent UTC render budgets bound corrective attempts', async () => {
  const db = fakeDb(); const at = new Date('2026-09-30T20:00:00Z'); const store = createImageJobStore(db, () => at);
  await store.claim(job(19), cfg);
  assert.equal(await store.reserveRender(job(19).messageId, cfg), true);
  assert.equal(await store.reserveRender(job(19).messageId, cfg), false); // still generating
  await store.update(job(19).messageId, { status: 'reviewing' });
  assert.equal(await store.reserveRender(job(19).messageId, cfg), true);
  await store.update(job(19).messageId, { status: 'reviewing' });
  assert.equal(await store.reserveRender(job(19).messageId, cfg), false);
  await store.claim(job(20), cfg);
  db.data.set('gameIdeaImageStats/2026-09-30', { jobs: 2, renders: 20 });
  assert.equal(await store.reserveRender(job(20).messageId, cfg), false);
});
test('Firestore failures stop all provider calls and cannot reject the parent command', async () => {
  const h = harness({ store: { claim: async () => { throw new Error('offline'); } } });
  assert.equal((await h.run(21)).status, 'failed'); assert.equal(h.counts.direct, 0);
});
test('malformed jobs are never accepted', () => {
  for (const patch of [{ messageId: '../x' }, { guildId: '123' }, { idea: '' }, { style: 'constructor' }]) {
    assert.throws(() => validateImageJob({ ...job(22), ...patch }));
    assert.equal(harness().service.enqueue({ ...job(22), ...patch }).status, 'invalid');
  }
});
