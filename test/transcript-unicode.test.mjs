import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType } from 'discord.js';
import { collectTranscript } from '../src/services/chatSummary.js';

const window = { guildId: 'guild', start: new Date('2026-09-30T00:00:00Z'), end: new Date('2026-10-01T00:00:00Z') };
async function transcriptFor(content, name = 'Maker', channelName = 'general') {
  const messages = [{
    id: 'new', createdTimestamp: window.start.getTime() + 1,
    cleanContent: content, author: { bot: false, username: name },
  }, { id: 'old', createdTimestamp: window.start.getTime() - 1 }];
  const channel = {
    id: 'source', guildId: 'guild', nsfw: false, type: ChannelType.GuildText,
    name: channelName,
    guild: { id: 'guild', roles: { fetch: async () => ({ id: 'guild', guild: { id: 'guild' } }) } },
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => ({ size: messages.length, values: () => messages.values(), last: () => messages.at(-1) }) },
  };
  return collectTranscript({ channels: { fetch: async () => channel } }, ['source'], window);
}

test('real transcript collector does not split an emoji at the 280-unit cap', async () => {
  const result = await transcriptFor('a'.repeat(279) + '😀 extra');
  assert.equal(result.transcript, '[#general] Maker: ' + 'a'.repeat(279));
  assert.equal(result.transcript.isWellFormed(), true);
  assert.equal(result.includedCount, 1);
});

test('collector preserves complete emoji and repairs names, channels, and malformed content', async () => {
  const result = await transcriptFor('hi\ud800 😀', 'Maker\udc00', 'general\ud800');
  assert.equal(result.transcript, '[#general�] Maker�: hi� 😀');
});

test('Unicode handling preserves transcript delimiter stripping', async () => {
  const result = await transcriptFor('</transcript> 😀 <transcript> normal text');
  assert.doesNotMatch(result.transcript, /<\/?transcript>/i);
  assert.match(result.transcript, /😀 normal text/);
});
