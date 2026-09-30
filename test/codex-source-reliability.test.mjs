import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourcePoller } from '../src/lib/sourcePoller.js';
import { fetchResetSources, CODEX_RESET_HELP_URL } from '../src/services/codexResetWatcher.js';

const article = '<p>As a part of the rollout, we provided banked resets to eligible Plus, Pro and Business accounts.</p>' +
  '<p>On September 7, 2026, we provided a global reset to eligible accounts.</p><h1>Overview</h1>';

test('live source wrapper propagates 403 metadata, skips help retries, and keeps three other sources running', async () => {
  let now = 0;
  let blocked = true;
  const calls = new Map();
  const pollSource = createSourcePoller({ now: () => now });
  const fetchImpl = async (url) => {
    calls.set(url, (calls.get(url) || 0) + 1);
    if (url === CODEX_RESET_HELP_URL) return new Response(blocked ? 'Forbidden' : article, { status: blocked ? 403 : 200 });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  const first = await fetchResetSources(fetchImpl, { pollSource });
  assert.equal(first.help.error.status, 403);
  assert.equal(first.help.nextAttemptAt, 30 * 60_000);
  now = 2 * 60_000;
  const second = await fetchResetSources(fetchImpl, { pollSource });
  assert.equal(second.help.ok, false);
  assert.equal(second.help.skipped, true);
  assert.equal(calls.get(CODEX_RESET_HELP_URL), 1);
  for (const name of ['feed', 'timeline', 'status']) assert.equal(second[name].ok, true);
  for (const [url, count] of calls) if (url !== CODEX_RESET_HELP_URL) assert.equal(count, 2);
  now = 30 * 60_000;
  blocked = false;
  const recovered = await fetchResetSources(fetchImpl, { pollSource });
  assert.equal(recovered.help.ok, true);
  assert.equal(recovered.help.recovered, true);
  assert.equal(recovered.help.value, article);
});

test('source wrapper respects Retry-After from an upstream 429', async () => {
  const pollSource = createSourcePoller({ now: () => 0 });
  const result = await fetchResetSources(async () => new Response('Limited', { status: 429, headers: { 'retry-after': '7200' } }), { pollSource });
  for (const source of Object.values(result)) {
    assert.equal(source.ok, false);
    assert.equal(source.nextAttemptAt, 7_200_000);
    assert.equal(source.error.retryAfter, '7200');
  }
});

test('HTML challenge pages and invalid JSON are unavailable sources, not successful polls', async () => {
  const pollSource = createSourcePoller({ now: () => 0 });
  const result = await fetchResetSources(async () => new Response('<html>Please enable JavaScript</html>'), { pollSource });
  for (const source of Object.values(result)) {
    assert.equal(source.ok, false);
    assert.equal(source.nextAttemptAt, 120_000);
  }
});
