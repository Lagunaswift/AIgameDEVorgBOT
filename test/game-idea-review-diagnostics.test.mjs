import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageJobService } from '../src/services/gameIdeaImageJobs.js';
import { readImageConfig } from '../src/lib/gameIdeaScreenshot.js';

const pass = { safe: true, noText: true, singleGameplayScreen: true, styleMatches: true, mechanicVisible: true };
const marker = 'PRIVATE-INPUT-MUST-NOT-BE-LOGGED';
const job = { messageId: '1554939939525754970', channelId: '1553439895924510802',
  guildId: '1051088980176805919', idea: `**Example** ${marker}`, theme: marker, style: 'auto' };
const brief = { safe: true, style: 'handdrawn', genre: marker, playerAction: marker,
  moment: marker, camera: marker, scene: marker, visibleHook: marker,
  interface: marker, palette: marker, mustShow: [marker], mustNotShow: [marker] };

function harness(reviews, { failPersistence = false, brokenLogger = false, maxAttempts = 2 } = {}) {
  const logs = [];
  const record = {};
  const counts = { render: 0, review: 0, send: 0 };
  const corrections = [];
  let claimed = false;
  const service = createImageJobService({
    cfg: { ...readImageConfig({ GEMINI_API_KEY: marker, GAME_IDEA_IMAGES_ENABLED: 'true' }), maxAttempts },
    store: {
      async claim() { if (claimed) return 'duplicate'; claimed = true; return 'claimed'; },
      async reserveRender() { return true; },
      async update(_id, fields) {
        if (failPersistence && fields.reviewResults) throw new Error(marker);
        Object.assign(record, structuredClone(fields));
      },
    },
    model: {
      async direct() { return brief; },
      async render(_brief, previous) {
        counts.render++; corrections.push(previous);
        return { buffer: Buffer.from(marker), mimeType: 'image/jpeg' };
      },
      async review() { return reviews[Math.min(counts.review++, reviews.length - 1)]; },
    },
    delivery: {
      async check() { return true; },
      async send() { counts.send++; return { id: '1554939939525754971' }; },
    },
    normalise: async image => image,
    log(event, fields) {
      if (brokenLogger) throw new Error(marker);
      logs.push(structuredClone({ event, ...fields }));
    },
  });
  return { logs, record, counts, corrections, service, run: () => service.enqueue(job).done };
}

test('different failed checks on each attempt are retained, logged and summarized accurately', async () => {
  const h = harness([{ ...pass, noText: false }, { ...pass, styleMatches: false, mechanicVisible: false }]);
  const result = await h.run();
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'visual_checks_failed');
  assert.deepEqual(result.failedChecks, ['styleMatches', 'mechanicVisible']);
  assert.deepEqual(h.counts, { render: 2, review: 2, send: 0 });
  assert.deepEqual(h.record.reviewResults.map(r => r.failedChecks), [['noText'], ['styleMatches', 'mechanicVisible']]);
  assert.deepEqual(h.record.reviewResults.map(r => r.attempt), [1, 2]);
  assert.deepEqual(h.logs.filter(l => l.event === 'reviewed').map(({ attempt, review, failedChecks, elapsedMs }) =>
    ({ attempt, review, failedChecks, elapsedMs })), h.record.reviewResults);
  assert.deepEqual(h.logs.at(-1).failedChecks, result.failedChecks);
  assert.equal(h.corrections[0], null);
  assert.deepEqual(h.corrections[1], { ...pass, noText: false });
  for (const event of h.logs) {
    assert.ok(Number.isInteger(event.elapsedMs) && event.elapsedMs >= 0);
    assert.equal(event.messageId, job.messageId);
  }
  assert.equal(JSON.stringify({ logs: h.logs, record: h.record }).includes(marker), false);
});

test('every visual gate stays enforced and single-attempt configuration is respected', async () => {
  for (const key of ['noText', 'singleGameplayScreen', 'styleMatches', 'mechanicVisible']) {
    const h = harness([{ ...pass, [key]: false }], { maxAttempts: 1 });
    assert.deepEqual(await h.run(), { status: 'rejected', reason: 'visual_checks_failed', failedChecks: [key] });
    assert.deepEqual(h.counts, { render: 1, review: 1, send: 0 });
    assert.deepEqual(h.record.failedChecks, [key]);
  }
});

test('a passing correction retains the initial failure and sends only the approved image', async () => {
  const h = harness([{ ...pass, singleGameplayScreen: false }, pass]);
  assert.equal((await h.run()).status, 'sent');
  assert.deepEqual(h.counts, { render: 2, review: 2, send: 1 });
  assert.deepEqual(h.record.reviewResults.map(r => r.failedChecks), [['singleGameplayScreen'], []]);
  assert.equal(h.record.status, 'sent');
  assert.deepEqual(h.logs.map(l => l.event), [
    'directing', 'generating', 'reviewing', 'reviewed', 'generating', 'reviewing', 'reviewed', 'sent',
  ]);
  assert.equal((await h.run()).status, 'duplicate');
  assert.equal(h.counts.render, 2);
});

test('unsafe output is diagnosed but never rerolled or delivered', async () => {
  const h = harness([{ ...pass, safe: false }]);
  assert.deepEqual(await h.run(), { status: 'rejected', reason: 'unsafe_image', failedChecks: ['safe'] });
  assert.deepEqual(h.counts, { render: 1, review: 1, send: 0 });
  assert.equal(h.record.reviewResults[0].review.safe, false);
});

test('invalid provider reviews are neither persisted nor echoed into logs', async () => {
  for (const invalid of [{ ...pass, noText: marker }, { ...pass, explanation: marker }, { safe: true }]) {
    const h = harness([invalid]);
    assert.deepEqual(await h.run(), { status: 'failed', reason: 'invalid_screenshot_review' });
    assert.equal(h.record.reviewResults, undefined);
    assert.equal(h.logs.some(l => l.event === 'reviewed'), false);
    assert.equal(JSON.stringify({ logs: h.logs, record: h.record }).includes(marker), false);
    assert.deepEqual(h.counts, { render: 1, review: 1, send: 0 });
  }
});

test('persistence failure leaves a safe review log and stops before another paid call', async () => {
  const h = harness([{ ...pass, noText: false }], { failPersistence: true });
  assert.deepEqual(await h.run(), { status: 'failed', reason: 'image_job_failed' });
  assert.deepEqual(h.logs.find(l => l.event === 'reviewed').failedChecks, ['noText']);
  assert.equal(JSON.stringify(h.logs).includes(marker), false);
  assert.deepEqual(h.counts, { render: 1, review: 1, send: 0 });
  assert.equal((await h.run()).status, 'duplicate');
});

test('logging errors cannot turn a successful review into a rejected job', async () => {
  const h = harness([pass], { brokenLogger: true });
  assert.equal((await h.run()).status, 'sent');
  assert.equal(h.counts.send, 1);
  assert.deepEqual(h.record.reviewResults[0].failedChecks, []);
});
