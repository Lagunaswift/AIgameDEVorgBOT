import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODEX_RESET_SOURCE_URL,
  buildCodexResetAlert,
  buildCodexResetMockAlert,
  extractResetAnnouncement,
  fingerprintResetAnnouncement,
  htmlToPlainText,
} from '../src/services/codexResetWatcher.js';

const article = (updated) => `
<html>
  <head><style>.hidden { display: none; }</style></head>
  <body>
    <h1>How banked Codex resets work</h1>
    <p>Updated: ${updated}</p>
    <p>As a part of the GPT-6 Astra rollout, we provided banked resets to eligible accounts.</p>
    <p>September 4, 2026: eligible Plus, Pro and Business accounts received a banked reset.</p>
    <p>Note: On September 7, 2026, we provided a global reset.</p>
    <h1>Overview</h1>
    <p>A banked reset is a one-time usage-limit reset.</p>
    <script>window.__noise = "reset changed";</script>
  </body>
</html>`;

test('HTML conversion removes scripts and preserves readable article text', () => {
  const text = htmlToPlainText(article('2 days ago'));
  assert.match(text, /How banked Codex resets work/);
  assert.doesNotMatch(text, /window\.__noise/);
});

test('announcement extraction watches the offer block, not relative Updated text', () => {
  const first = extractResetAnnouncement(article('2 days ago'));
  const second = extractResetAnnouncement(article('3 days ago'));

  assert.equal(first, second);
  assert.match(first, /^As a part of the GPT-6 Astra rollout/);
  assert.match(first, /September 7, 2026/);
  assert.doesNotMatch(first, /Overview/);
});

test('announcement fingerprint changes only when watched reset content changes', () => {
  const original = extractResetAnnouncement(article('2 days ago'));
  const changed = original.replace('September 7, 2026', 'September 8, 2026');

  assert.equal(
    fingerprintResetAnnouncement(original),
    fingerprintResetAnnouncement(extractResetAnnouncement(article('5 days ago'))),
  );
  assert.notEqual(
    fingerprintResetAnnouncement(original),
    fingerprintResetAnnouncement(changed),
  );
});

test('alert is channel-only and links the official OpenAI source', () => {
  const alert = buildCodexResetAlert();
  assert.match(alert, /Codex reset update/);
  assert.ok(alert.includes(CODEX_RESET_SOURCE_URL));
  assert.doesNotMatch(alert, /<@&\d+>/);
});


test('live mock is unmistakably labelled and contains no role mention', () => {
  const alert = buildCodexResetMockAlert();
  assert.match(alert, /TEST — Codex reset alert/);
  assert.match(alert, /No Codex reset has been detected/);
  assert.match(alert, /Railway/);
  assert.doesNotMatch(alert, /<@&\d+>/);
});
