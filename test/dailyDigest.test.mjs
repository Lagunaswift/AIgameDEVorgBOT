import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredChatChannelIds, describeDigest } from '../src/services/dailyDigest.js';

const stats = {
  showcaseThreads: [],
  competitionThreads: [],
  points: [],
  newPosterCount: 0,
  milestones: [],
};

test('chat collection falls back to digest channel when no explicit channels configured', () => {
  assert.deepEqual(
    configuredChatChannelIds({ dailyDigestChannelId: 'general', dailyDigestChatChannelIds: [] }),
    ['general'],
  );
  assert.deepEqual(
    configuredChatChannelIds({ dailyDigestChannelId: 'general', dailyDigestChatChannelIds: ['explicit'] }),
    ['explicit'],
  );
  assert.deepEqual(
    configuredChatChannelIds({ dailyDigestChannelId: null, dailyDigestChatChannelIds: [] }),
    [],
  );
});

test('generated chat recaps include the Anthropic disclosure', () => {
  const content = describeDigest({
    dateStr: '2026-08-28',
    stats,
    chat: { messageCount: 5, channelsRead: 1, summary: 'People discussed the jam.' },
  });

  assert.match(content, /Summarises configured public channels using Anthropic\./);
});
