import assert from 'node:assert/strict';
import test from 'node:test';
import { findOwnerReplyImage, THREAD_IMAGE_PAGE_SIZE, THREAD_IMAGE_MAX_PAGES } from '../src/lib/threadImages.js';

const THREAD = '345678901234567890';
const OWNER = '123456789012345678';
const OTHER = '234567890123456789';
const message = (offset, { ownerId = OWNER, image = null, bot = false } = {}) => ({
  id: String(BigInt(THREAD) + BigInt(offset)), author: { id: ownerId, bot }, image,
});
const search = (fetchPage) => findOwnerReplyImage({ threadId: THREAD, ownerId: OWNER, fetchPage, findImage: (value) => value.image });

test('reply image search selects the earliest owner upload regardless of response order', async () => {
  const image = { filename: 'game.png' };
  assert.equal(await search(async () => [
    message(9, { image: { filename: 'later.png' } }),
    message(1, { ownerId: OTHER, image: { filename: 'someone-else.png' } }),
    message(2, { bot: true, image: { filename: 'bot.png' } }),
    message(3, { image }),
  ]), image);
});

test('reply image search advances its cursor and finds uploads beyond the first page', async () => {
  const first = Array.from({ length: 100 }, (_, index) => message(index + 1)).reverse();
  const image = { filename: 'second-page.gif' };
  const calls = [];
  const result = await search(async (options) => {
    calls.push(options);
    return calls.length === 1 ? first : [message(101, { image })];
  });
  assert.equal(result, image);
  assert.deepEqual(calls, [{ after: THREAD, limit: 100 }, { after: message(100).id, limit: 100 }]);
});

test('reply image search checks recent uploads after its bounded early-history scan', async () => {
  const image = { filename: 'fresh-upload.webp' };
  let calls = 0;
  const result = await search(async ({ after, limit }) => {
    calls++;
    assert.equal(limit, THREAD_IMAGE_PAGE_SIZE);
    if (!after) return [message(10000, { image })];
    const offset = Number(BigInt(after) - BigInt(THREAD));
    return Array.from({ length: limit }, (_, index) => message(offset + index + 1)).reverse();
  });
  assert.equal(result, image);
  assert.equal(calls, THREAD_IMAGE_MAX_PAGES + 1);
});

test('reply image search stops on exhaustion and never selects non-owner images', async () => {
  let calls = 0;
  assert.equal(await search(async () => { calls++; return [message(1, { ownerId: OTHER, image: {} })]; }), null);
  assert.equal(calls, 1);
});

test('reply image search does not loop on non-advancing pages or hide lookup failures', async () => {
  let calls = 0;
  assert.equal(await search(async ({ after }) => {
    calls++;
    return after ? Array(100).fill(message(0)) : [];
  }), null);
  assert.equal(calls, 2);
  await assert.rejects(search(async () => { throw new Error('history unavailable'); }), /history unavailable/);
  await assert.rejects(search(async () => [{ id: 'invalid' }]), /invalid message data/);
});

test('an unsearched history gap is inconclusive instead of clearing an existing image', async () => {
  await assert.rejects(search(async ({ after, limit }) => {
    const offset = after ? Number(BigInt(after) - BigInt(THREAD)) : 9000;
    return Array.from({ length: limit }, (_, index) => message(offset + index + 1));
  }), /history limit/);
});
