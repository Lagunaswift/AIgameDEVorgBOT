import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScreenshotNudgeMessage, threadHasScreenshot } from '../src/services/screenshotNudge.js';

const THREAD = '345678901234567890';
const OWNER = '123456789012345678';
const image = { name: 'game.webp', contentType: 'image/webp' };
const reply = (offset, attachments = [], ownerId = OWNER) => ({
  id: String(BigInt(THREAD) + BigInt(offset)),
  author: { id: ownerId, bot: false },
  attachments: new Map(attachments.map((value, index) => [String(index), value])),
});

test('screenshot nudge asks for an owner-uploaded reply rather than editing the first post', () => {
  const text = buildScreenshotNudgeMessage(OWNER);
  assert.match(text, /attach a screenshot or short gameplay GIF to a new reply in this thread/);
  assert.match(text, /your own account/);
  assert.doesNotMatch(text, /first (message|post)|edit/i);
});

test('screenshot check keeps an existing owner starter image without reading replies', async () => {
  assert.equal(await threadHasScreenshot({
    id: THREAD, ownerId: OWNER,
    fetchStarterMessage: async () => reply(0, [image]),
    messages: { fetch: () => assert.fail('an existing starter image should keep priority') },
  }), true);
});

test('screenshot check recognises an owner image uploaded later in the same thread', async () => {
  const messages = Array.from({ length: 120 }, (_, index) => reply(index + 1, index === 119 ? [image] : []));
  let calls = 0;
  const thread = {
    id: THREAD, ownerId: OWNER,
    fetchStarterMessage: async () => reply(0),
    messages: { fetch: async ({ after, limit }) => {
      calls++;
      const page = messages.filter((message) => BigInt(message.id) > BigInt(after)).slice(0, limit).reverse();
      return new Map(page.map((message) => [message.id, message]));
    } },
  };
  assert.equal(await threadHasScreenshot(thread), true);
  assert.equal(calls, 2);
});

test('screenshot check ignores other members uploads and does not mistake a failed lookup for no image', async () => {
  const thread = {
    id: THREAD, ownerId: OWNER,
    fetchStarterMessage: async () => reply(0),
    messages: { fetch: async () => new Map([['other', reply(1, [image], '234567890123456789')]]) },
  };
  assert.equal(await threadHasScreenshot(thread), false);
  thread.messages.fetch = async () => { throw new Error('history unavailable'); };
  await assert.rejects(threadHasScreenshot(thread), /history unavailable/);
});
