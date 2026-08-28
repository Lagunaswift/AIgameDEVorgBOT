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

test('daily digest never falls back to the posting channel for chat collection', () => {
  assert.deepEqual(
    configuredChatChannelIds({ dailyDigestChannelId: 'general', dailyDigestChatChannelIds: [] }),
    [],
  );
  assert.deepEqual(
    configuredChatChannelIds({ dailyDigestChannelId: 'general', dailyDigestChatChannelIds: ['explicit'] }),
    ['explicit'],
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
