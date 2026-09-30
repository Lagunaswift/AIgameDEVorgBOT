import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { imageReplyPayload, createDiscordImageDelivery, queueGameIdeaImage, normaliseGameImage } from '../src/services/gameIdeaImages.js';
const job = { messageId: '1553439895924510888', channelId: '1553439895924510802', guildId: '1051088980176805919', idea: '**Title** A microwave fleet game.' };
const image = { buffer: Buffer.from('image'), mimeType: 'image/jpeg' };
function context(t) {
  const original = process.env.GAME_IDEA_IMAGES_ENABLED;
  process.env.GAME_IDEA_IMAGES_ENABLED = 'true';
  t.after(() => { if (original === undefined) delete process.env.GAME_IDEA_IMAGES_ENABLED; else process.env.GAME_IDEA_IMAGES_ENABLED = original; });
  const requested = [];
  const channel = { guildId: job.guildId, isTextBased: () => true, isDMBased: () => false, isThread: () => false,
    permissionsFor: () => ({ has: list => { requested.push(list); return true; } }),
    messages: { fetch: async options => { assert.equal(options.message, job.messageId); assert.equal(options.force, true); return { author: { id: 'bot-id' }, content: `${job.idea}\n\n-# seed` }; } },
    send: async payload => { requested.push(payload); return { id: 'reply-id' }; },
  };
  const client = { user: { id: 'bot-id' }, channels: { fetch: async id => { assert.equal(id, job.channelId); return channel; } } };
  return { channel, requested, client, delivery: createDiscordImageDelivery(client, job.guildId) };
}

test('attachment-only reply points to original, suppresses mentions and uses a stable nonce', () => {
  const payload = imageReplyPayload(job, image, 'handdrawn');
  assert.equal(payload.reply.messageReference, job.messageId);
  assert.equal(payload.reply.failIfNotExists, true);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(payload.nonce, `gi-${job.messageId}`); assert.equal(payload.enforceNonce, true);
  assert.ok(payload.nonce.length <= 25);
  assert.equal(payload.files[0].attachment, image.buffer);
  assert.match(payload.files[0].description, /AI-generated gameplay mockup/);
  assert.ok(!Object.hasOwn(payload, 'content')); assert.ok(!Object.hasOwn(payload, 'embeds'));
});
test('normal-channel delivery verifies the exact message and attachment/reply permissions', async t => {
  const h = context(t); assert.equal(await h.delivery.check(job), true);
  assert.ok(h.requested[0].includes('SendMessages')); assert.ok(h.requested[0].includes('AttachFiles'));
  assert.deepEqual(await h.delivery.send(job, image, 'ps2'), { id: 'reply-id' });
});
test('threads require thread-send permission and archived/locked threads are skipped', async t => {
  const h = context(t); h.channel.isThread = () => true;
  assert.equal(await h.delivery.check(job), true);
  assert.ok(h.requested[0].includes('SendMessagesInThreads'));
  h.channel.archived = true; assert.equal(await h.delivery.check(job), false);
  h.channel.archived = false; h.channel.locked = true; assert.equal(await h.delivery.check(job), false);
});
test('wrong guild, DM, missing permissions, changed original and deleted message all fail closed', async t => {
  const h = context(t);
  assert.equal(await h.delivery.check({ ...job, guildId: '1553439895924510803' }), false);
  h.channel.isDMBased = () => true; assert.equal(await h.delivery.check(job), false); h.channel.isDMBased = () => false;
  h.channel.permissionsFor = () => ({ has: () => false }); assert.equal(await h.delivery.check(job), false);
  h.channel.permissionsFor = () => ({ has: () => true });
  h.channel.messages.fetch = async () => ({ author: { id: 'another-author' }, content: job.idea });
  assert.equal(await h.delivery.check(job), false);
  h.channel.messages.fetch = async () => ({ author: { id: 'bot-id' }, content: 'replaced original' });
  assert.equal(await h.delivery.check(job), false);
  h.channel.messages.fetch = async () => { throw new Error('Unknown message'); }; assert.equal(await h.delivery.check(job), false);
});
test('switch off prevents further work and free fallback ideas never initialise image services', async t => {
  const h = context(t); process.env.GAME_IDEA_IMAGES_ENABLED = 'false';
  assert.equal(await h.delivery.check(job), false);
  for (const status of ['madlib', 'fallback', 'capped']) assert.equal((await queueGameIdeaImage({ result: { status } })).status, 'skipped');
  assert.equal((await queueGameIdeaImage({ result: { status: 'ok' } })).status, 'disabled');
});
test('command queues only after posting text and keeps the original text/mention handling', async () => {
  const source = await readFile(new URL('../src/commands/gameidea.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('const message = await interaction.editReply') < source.indexOf('void queueGameIdeaImage('));
  assert.match(source, /result: res, message, client: interaction.client/);
  assert.match(source, /allowedMentions: \{ parse: \[\] \}/);
  assert.match(source, /\.setName\('style'\)/);
  assert.match(source, /\.catch\(\(\) => console.error\('\[gameIdeaImages\] image_queue_failed'\)\)/);
});

let sharp;
try { sharp = (await import('sharp')).default; } catch { /* local dependency-free harness; CI installs repository dependencies */ }
test('real decoder accepts landscape image and rejects squares, malformed bytes and MIME lies', { skip: !sharp }, async () => {
  const buffer = await sharp({ create: { width: 1024, height: 576, channels: 3, background: '#123456' } }).png().toBuffer();
  const output = await normaliseGameImage({ buffer, mimeType: 'image/png' });
  assert.equal(output.mimeType, 'image/jpeg');
  assert.equal((await sharp(output.buffer).metadata()).width, 1024);
  await assert.rejects(normaliseGameImage({ buffer, mimeType: 'image/jpeg' }));
  await assert.rejects(normaliseGameImage({ buffer: Buffer.from('garbage'), mimeType: 'image/jpeg' }));
  const square = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#123456' } }).png().toBuffer();
  await assert.rejects(normaliseGameImage({ buffer: square, mimeType: 'image/png' }), { message: 'image_invalid_dimensions' });
});
