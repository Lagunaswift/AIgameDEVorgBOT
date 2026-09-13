import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaInput, mediaState, mediaMessageId, mediaAttachmentId, mediaProjectId } from '../src/lib/project-media-contracts.mjs';
const G = '1051088980176805919', T = '345678901234567890', M = '456789012345678901', A = '567890123456789012';
const image = (v = {}) => ({ id: 'gallery_123', messageId: M, attachmentId: A, alt: 'A player crosses a bridge', caption: '', visibility: 'draft', ...v });
const input = (v = {}) => ({ revision: 0, mode: 'selected', items: [image()], ...v });
test('media contract accepts explicit bounded references, never signed image URLs or ownership fields', () => {
  assert.equal(parseMediaInput(input()).items[0].visibility, 'draft');
  for (const extra of [{ ownerId: 'hijack' }, { threadId: T }, { publishToSite: true }, { url: 'https://evil.invalid' }]) assert.equal(parseMediaInput({ ...input(), ...extra }), null);
  assert.equal(parseMediaInput(input({ items: [image({ url: 'https://cdn.discordapp.com/secret?hm=secret' })] })), null);
});
test('media limits, captions, drafts, duplicates and malformed values fail closed', () => {
  for (const value of [null, [], {}, { ...input(), revision: -1 }, input({ mode: 'public' }), input({ items: [image(), image()] }), input({ items: [image({ alt: '' })] }), input({ items: [image({ caption: 'a'.repeat(281) })] }), input({ items: [image({ visibility: true })] }), input({ items: [image({ messageId: M + '?secret' })] }), input({ items: [image({ alt: '\u0000bad' })] }), input({ items: Array(13).fill(image()) })]) assert.equal(parseMediaInput(value), null);
  assert.ok(parseMediaInput(input({ items: [image({ caption: 'a'.repeat(280) })] })));
  assert.ok(parseMediaInput(input({ items: [] })));
  assert.equal(mediaProjectId('a'.repeat(1501)), false);
  assert.equal(mediaProjectId('../other'), false);
});
test('missing media uses legacy automatic gallery, explicit empty selection does not restore fallback', () => {
  const fresh = mediaState(undefined, 'game-123', T);
  assert.equal(fresh.mode, 'automatic');
  const saved = { ...fresh, revision: 1, mode: 'selected', updatedAt: null };
  assert.equal(mediaState(saved, 'game-123', T).mode, 'selected');
  for (const bad of [null, { ...saved, projectId: 'other' }, { ...saved, threadId: M }, { ...saved, surprise: true }, { ...saved, revision: 0 }]) assert.equal(mediaState(bad, 'game-123', T), null);
});
test('copy-link helpers require exact trusted Discord sources and discard expiring signatures', () => {
  const message = `https://discord.com/channels/${G}/${T}/${M}`;
  assert.equal(mediaMessageId(message, G, T), M);
  for (const bad of [message+'?x=1', message+'/', message.replace(T,A), message.replace('discord.com','discord.com.evil.invalid'), message.replace('https:','http:'), 'https://discord.com/channels/@me/'+M]) assert.equal(mediaMessageId(bad,G,T), null);
  const link = `https://cdn.discordapp.com/attachments/${T}/${A}/test.png?ex=123&hm=SECRET`;
  assert.equal(mediaAttachmentId(link,T), A);
  assert.equal(mediaAttachmentId(link.replace('cdn.discordapp.com','media.discordapp.net'),T), A);
  for (const bad of [link.replace(T,M), link.replace('cdn.discordapp.com','evil.invalid'), link.replace('https:','http:'), link.replace('cdn.discordapp.com','user@cdn.discordapp.com'), link.replace('/test.png','/../../file.png')]) assert.equal(mediaAttachmentId(bad,T), null);
});
