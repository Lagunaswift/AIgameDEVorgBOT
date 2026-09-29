import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODEX_RESET_CHECK_CRON,
  CODEX_RESET_HELP_URL,
  CODEX_RESET_TRACKER_URL,
  buildCodexResetAlert,
  candidatesFromOpenAIStatus,
  candidatesFromTiboFeed,
  candidatesFromVerifiedTimeline,
  extractResetAnnouncement,
  fingerprintResetAnnouncement,
  htmlToPlainText,
  mergeCandidates,
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

test('watcher polls every two minutes', () => {
  assert.equal(CODEX_RESET_CHECK_CRON, '*/2 * * * *');
});

test('HTML conversion removes scripts and preserves readable article text', () => {
  const text = htmlToPlainText(article('2 days ago'));
  assert.match(text, /How banked Codex resets work/);
  assert.doesNotMatch(text, /window\.__noise/);
});

test('help announcement fingerprint ignores relative Updated text', () => {
  const first = extractResetAnnouncement(article('2 days ago'));
  const second = extractResetAnnouncement(article('3 days ago'));
  assert.equal(first, second);
  assert.equal(
    fingerprintResetAnnouncement(first),
    fingerprintResetAnnouncement(second),
  );
});

test('Tibo direct hard-reset announcement becomes an alert candidate', () => {
  const candidates = candidatesFromTiboFeed({
    stale: false,
    tweets: [{
      id: 'hard1',
      at: '2026-09-29T18:00:00Z',
      url: 'https://x.com/thsottiaux/status/hard1',
      text: 'We will reset usage limits for all paid users across Codex and ChatGPT Work.',
      kind: 'candidate',
      tibo_lane: 'reset_announcement',
      explicit_reset_claim: true,
    }],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'hard');
  assert.equal(candidates[0].key, 'tibo:hard1');
});

test('Tibo direct banked reset becomes an alert candidate', () => {
  const candidates = candidatesFromTiboFeed({
    stale: false,
    tweets: [{
      id: 'banked1',
      at: '2026-09-29T18:00:00Z',
      url: 'https://x.com/thsottiaux/status/banked1',
      text: 'We are loading a banked reset into all accounts of our Plus, Pro and Business users.',
      kind: 'banked',
      tibo_lane: 'reset_related',
      explicit_reset_claim: false,
    }],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'banked');
});

test('vague reset hints and unrelated limit posts do not alert', () => {
  const candidates = candidatesFromTiboFeed({
    stale: false,
    tweets: [
      {
        id: 'hint',
        at: '2026-09-29T18:00:00Z',
        url: 'https://x.com/thsottiaux/status/hint',
        text: 'More resets coming next week',
        kind: 'signal',
        tibo_lane: 'reset_related',
        explicit_reset_claim: false,
      },
      {
        id: 'limits',
        at: '2026-09-29T18:01:00Z',
        url: 'https://x.com/thsottiaux/status/limits',
        text: 'You can now use your ChatGPT subscription in partner products.',
        kind: 'limits',
        tibo_lane: 'reset_related',
        explicit_reset_claim: false,
      },
    ],
  });

  assert.deepEqual(candidates, []);
});

test('stale Tibo feed is ignored rather than replayed', () => {
  assert.deepEqual(
    candidatesFromTiboFeed({
      stale: true,
      tweets: [{
        id: 'old',
        at: '2026-09-29T18:00:00Z',
        url: 'https://x.com/thsottiaux/status/old',
        text: 'We reset usage limits for all paid Codex users.',
        kind: 'candidate',
        tibo_lane: 'reset_announcement',
        explicit_reset_claim: true,
      }],
    }),
    [],
  );
});

test('verified timeline accepts announced hard and banked resets only', () => {
  const candidates = candidatesFromVerifiedTimeline({
    events: [
      {
        id: 'verified-hard',
        announced_at: '2026-09-29T18:00:00Z',
        url: 'https://x.com/thsottiaux/status/verified-hard',
        confidence: 'high',
        group: 'reset',
        announcement_state: 'announced',
        summary: 'Reset for every paid Codex user.',
      },
      {
        id: 'verified-banked',
        announced_at: '2026-09-29T18:01:00Z',
        url: 'https://x.com/thsottiaux/status/verified-banked',
        confidence: 'high',
        group: 'credits',
        reset_kind: 'banked',
        banked_state: 'available',
        summary: 'A banked reset is available.',
      },
      {
        id: 'hint',
        announced_at: '2026-09-29T18:02:00Z',
        url: 'https://x.com/thsottiaux/status/hint',
        confidence: 'medium',
        group: 'reset',
        announcement_state: 'none',
        summary: 'More resets coming next week.',
      },
    ],
  });

  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.kind), ['hard', 'banked']);
});

test('OpenAI Status only alerts explicit reset actions, not incidents about unexpected resets', () => {
  const candidates = candidatesFromOpenAIStatus({
    incidents: [
      {
        id: 'incident1',
        name: 'Issues with Codex',
        incident_updates: [{
          id: 'update1',
          created_at: '2026-09-29T18:00:00Z',
          body: 'We have reset Codex usage limits for all paid users while recovery continues.',
        }],
      },
      {
        id: 'incident2',
        name: 'Investigating unexpected usage limit resets',
        incident_updates: [{
          id: 'update2',
          created_at: '2026-09-29T18:01:00Z',
          body: 'Some Codex users may be experiencing unexpected usage limit resets.',
        }],
      },
    ],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].key, 'openai-status:update1');
});

test('verified timeline wins over the live feed for the same Tibo event id', () => {
  const live = {
    key: 'tibo:123',
    kind: 'hard',
    announcedAt: '2026-09-29T18:00:00Z',
    sourceUrl: 'https://x.com/thsottiaux/status/123',
    sourceFamily: 'tibo',
    verification: 'direct-public-post',
  };
  const verified = {
    ...live,
    sourceFamily: 'tracker',
    verification: 'verified-timeline',
  };

  const merged = mergeCandidates([live], [verified]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].verification, 'verified-timeline');
});

test('Discord alert is channel-only, source-linked, and credits tracker data', () => {
  const alert = buildCodexResetAlert({
    kind: 'hard',
    sourceUrl: 'https://x.com/thsottiaux/status/123',
    sourceFamily: 'tibo',
    summary: 'Usage limits reset for all paid Codex users.',
  });

  assert.match(alert, /Codex usage reset announced/);
  assert.match(alert, /https:\/\/x\.com\/thsottiaux\/status\/123/);
  assert.ok(alert.includes(CODEX_RESET_TRACKER_URL));
  assert.doesNotMatch(alert, /<@&\d+>/);
  assert.doesNotMatch(alert, /<@\d+>/);
});

test('official Help Center fallback stays source-linked without tracker credit', () => {
  const alert = buildCodexResetAlert({
    kind: 'official-update',
    sourceUrl: CODEX_RESET_HELP_URL,
    sourceFamily: 'openai-help',
    summary: null,
  });
  assert.ok(alert.includes(CODEX_RESET_HELP_URL));
  assert.doesNotMatch(alert, /Verification data:/);
});
