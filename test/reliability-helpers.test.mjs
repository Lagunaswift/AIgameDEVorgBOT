import assert from 'node:assert/strict';
import test from 'node:test';
import { truncateWellFormed } from '../src/lib/unicodeText.js';
import { createSourcePoller, retryAfterMilliseconds } from '../src/lib/sourcePoller.js';

const MINUTE = 60_000;

test('reproduces the 280-unit transcript cut and removes the split emoji', () => {
  const input = 'a'.repeat(279) + '😀 shipped';
  assert.equal(input.slice(0, 280).isWellFormed(), false);
  assert.equal(truncateWellFormed(input, 280), 'a'.repeat(279));
});

test('preserves a full emoji that fits exactly and repairs existing malformed text', () => {
  assert.equal(truncateWellFormed('a'.repeat(278) + '😀 next', 280), 'a'.repeat(278) + '😀');
  assert.equal(truncateWellFormed('ok\ud800 bad\udc00 😀', 100), 'ok� bad� 😀');
});

test('every boundary of mixed Unicode stays within the old budget and well formed', () => {
  const input = 'Hi 😀 café 日本語 👩🏽‍💻 family 👨‍👩‍👧‍👦 🎮';
  for (let limit = 0; limit <= input.length + 2; limit++) {
    const result = truncateWellFormed(input, limit);
    assert.ok(result.length <= limit);
    assert.equal(result.isWellFormed(), true);
    assert.ok(input.startsWith(result));
  }
});

test('zero/empty text and invalid budgets are handled explicitly', () => {
  assert.equal(truncateWellFormed('😀', 0), '');
  assert.equal(truncateWellFormed('😀', 1), '');
  assert.equal(truncateWellFormed(null, 10), '');
  for (const limit of [-1, 1.5, NaN, Infinity]) assert.throws(() => truncateWellFormed('x', limit), RangeError);
});

test('Retry-After accepts seconds and HTTP dates, ignores invalid/past headers', () => {
  const now = Date.parse('2026-09-30T22:00:00Z');
  assert.equal(retryAfterMilliseconds('120', now), 120_000);
  assert.equal(retryAfterMilliseconds('Wed, 30 Sep 2026 22:05:00 GMT', now), 300_000);
  assert.equal(retryAfterMilliseconds('Wed, 30 Sep 2026 21:00:00 GMT', now), 0);
  for (const value of ['', null, undefined, 'nope']) assert.equal(retryAfterMilliseconds(value, now), 0);
});

test('403 backs off only the failing source and remains unhealthy while skipped', async () => {
  let clock = 0;
  let helpCalls = 0;
  let feedCalls = 0;
  const poll = createSourcePoller({ now: () => clock });
  const forbidden = Object.assign(new Error('HTTP 403'), { status: 403 });
  const help = () => { helpCalls++; throw forbidden; };
  const feed = () => { feedCalls++; return { tweets: [] }; };
  const first = await poll('help', help);
  assert.equal(first.ok, false);
  assert.equal(first.skipped, false);
  assert.equal(first.nextAttemptAt, 30 * MINUTE);
  for (clock = 2 * MINUTE; clock < 30 * MINUTE; clock += 2 * MINUTE) {
    const skipped = await poll('help', help);
    assert.equal(skipped.ok, false);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.error, forbidden);
    assert.equal((await poll('feed', feed)).ok, true);
  }
  assert.equal(helpCalls, 1);
  assert.equal(feedCalls, 14);
  const retry = await poll('help', help);
  assert.equal(helpCalls, 2);
  assert.equal(retry.nextAttemptAt, clock + 60 * MINUTE);
});

test('network/5xx retries back off exponentially with a six-hour cap', async () => {
  let clock = 0;
  const poll = createSourcePoller({ now: () => clock });
  const load = () => { throw Object.assign(new Error('unavailable'), { status: 503 }); };
  for (let attempt = 0; attempt < 16; attempt++) {
    const result = await poll('status', load);
    assert.equal(result.nextAttemptAt - clock, Math.min(2 * MINUTE * 2 ** attempt, 360 * MINUTE));
    clock = result.nextAttemptAt;
  }
});

test('401 and 429 use blocked-source cooldown; Retry-After may extend it', async () => {
  for (const status of [401, 429]) {
    const poll = createSourcePoller({ now: () => 0 });
    const result = await poll('source', () => { throw Object.assign(new Error('blocked'), { status }); });
    assert.equal(result.nextAttemptAt, 30 * MINUTE);
  }
  const poll = createSourcePoller({ now: () => 0 });
  const result = await poll('source', () => {
    throw Object.assign(new Error('limited'), { status: 429, retryAfter: '7200' });
  });
  assert.equal(result.nextAttemptAt, 120 * MINUTE);
});

test('successful retry reports recovery once and resets the next failure delay', async () => {
  let clock = 0;
  const poll = createSourcePoller({ now: () => clock });
  const fail = () => { throw Object.assign(new Error('blocked'), { status: 403 }); };
  await poll('help', fail);
  clock = 30 * MINUTE;
  assert.equal((await poll('help', () => 'article')).recovered, true);
  assert.equal((await poll('help', () => 'article')).recovered, false);
  assert.equal((await poll('help', fail)).nextAttemptAt, clock + 30 * MINUTE);
});

test('overlapping checks share a single request without blocking another source', async () => {
  const poll = createSourcePoller();
  let resolve;
  let calls = 0;
  const load = () => { calls++; return new Promise((done) => { resolve = done; }); };
  const first = poll('help', load);
  const second = poll('help', load);
  await Promise.resolve();
  assert.equal((await poll('status', () => 'healthy')).value, 'healthy');
  resolve('article');
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});

test('cooldown starts at failure completion rather than request start', async () => {
  let clock = 0;
  const poll = createSourcePoller({ now: () => clock });
  const result = await poll('help', () => {
    clock = 15_000;
    throw Object.assign(new Error('forbidden'), { status: 403 });
  });
  assert.equal(result.nextAttemptAt, 15_000 + 30 * MINUTE);
});
