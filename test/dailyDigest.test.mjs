import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredChatChannelIds, describeDigest } from '../src/services/dailyDigest.js';
import { BUILD_REACTIONS } from '../src/lib/byte.js';

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

  assert.match(content, /Summary of configured public channels, using Anthropic\./);
});


test('digest gives new builds one restrained Byte reaction', () => {
  const content = describeDigest({
    dateStr: '2026-09-20',
    stats: {
      ...stats,
      showcaseThreads: [{ threadId: '123456789012345678', ownerId: '234567890123456789' }],
    },
  });

  assert.ok(
    BUILD_REACTIONS.some((line) => content.includes(line)),
    'expected one Byte build reaction in the rendered digest',
  );
});
