import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiImageClient, decodeGeneratedImage, outputBlocks, GEMINI_ENDPOINT } from '../src/services/geminiImages.js';
import { readImageConfig } from '../src/lib/gameIdeaScreenshot.js';
import { sampleBrief } from './fixtures/game-idea-image.mjs';
const cfg = readImageConfig({ GAME_IDEA_IMAGES_ENABLED: 'true', GEMINI_API_KEY: 'test-secret-not-for-logs' });
const response = content => ({ status: 'completed', steps: [{ type: 'model_output', content }] });
const textResponse = data => response([{ type: 'text', text: JSON.stringify(data) }]);
const imageResponse = () => response([{ type: 'image', mime_type: 'image/jpeg', data: Buffer.from('fake-image-bytes').toString('base64') }]);
const pass = { safe: true, noText: true, singleGameplayScreen: true, styleMatches: true, mechanicVisible: true };
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('uses documented Interactions contract, header auth and stateless requests for all three stages', async () => {
  const calls = [];
  const replies = [textResponse(sampleBrief()), imageResponse(), textResponse(pass)];
  const client = createGeminiImageClient(cfg, async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return json(replies.shift()); });
  const brief = await client.direct('**Title** A microwave fleet game. **The hook:** Commands burn out.', 'handdrawn', '');
  const image = await client.render(brief);
  assert.deepEqual(await client.review(image, brief), pass);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, GEMINI_ENDPOINT);
    assert.equal(call.options.headers['x-goog-api-key'], cfg.apiKey);
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.body.store, false);
    assert.ok(!call.url.includes(cfg.apiKey));
  }
  assert.equal(calls[0].body.response_format.mime_type, 'application/json');
  assert.ok(calls[0].body.system_instruction.includes('untrusted'));
  assert.deepEqual(calls[1].body.response_format, { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '16:9', image_size: '1K' });
  assert.ok(!calls[1].body.input.includes('**Title**'));
  assert.equal(calls[2].body.input[1].type, 'image');
});
for (const status of [400, 401, 403, 429, 500, 503]) test(`HTTP ${status} does not retry a potentially billed render or leak provider errors`, async () => {
  let calls = 0;
  const client = createGeminiImageClient(cfg, async () => { calls++; return new Response('test-secret-not-for-logs RAW-PROMPT', { status }); });
  await assert.rejects(client.render(sampleBrief()), { message: `gemini_http_${status}` });
  assert.equal(calls, 1);
});
test('network and timeout errors are bounded and sanitized', async () => {
  const client = createGeminiImageClient(cfg, async () => { throw new Error(cfg.apiKey); });
  await assert.rejects(client.render(sampleBrief()), { message: 'gemini_network_or_timeout' });
});
test('missing credential does not make a request', async () => {
  const client = createGeminiImageClient({ ...cfg, apiKey: '' }, () => assert.fail('must not fetch'));
  await assert.rejects(client.render(sampleBrief()), { message: 'gemini_missing_key' });
});
test('reject refusal, incomplete interaction and empty/multiple/remote image output', () => {
  for (const value of [{ status: 'in_progress', steps: [] }, { status: 'failed', steps: [] }, response([]), response([{ type: 'text', text: 'Cannot comply' }]), response([...imageResponse().steps[0].content, ...imageResponse().steps[0].content]), response([{ type: 'image', mime_type: 'image/jpeg', uri: 'https://attacker.test' }])]) assert.throws(() => decodeGeneratedImage(value));
  assert.deepEqual(outputBlocks({ status: 'completed', steps: [{ type: 'thought', content: [{ type: 'text', text: 'not output' }] }, { type: 'user_input', content: [{ type: 'image' }] }] }), []);
});
test('reject malformed base64, disallowed MIME and excessive payloads', () => {
  for (const patch of [{ mime_type: 'text/html' }, { data: '%%%%' }, { data: 'YQ=' }, { data: '' }, { data: 'a'.repeat(12 * 1024 * 1024) }]) {
    const value = imageResponse(); Object.assign(value.steps[0].content[0], patch);
    assert.throws(() => decodeGeneratedImage(value));
  }
});
test('reject oversized streamed JSON even without content-length', async () => {
  const client = createGeminiImageClient(cfg, async () => new Response('x'.repeat(129 * 1024)));
  await assert.rejects(client.direct('**Title** A racing game.', 'auto'), { message: 'gemini_response_too_large' });
});
test('reject provider prose, invalid JSON and incomplete safety review', async () => {
  for (const value of [response([{ type: 'text', text: 'sure, here you go' }]), textResponse({ safe: true }), { status: 'failed', steps: [] }]) {
    const client = createGeminiImageClient(cfg, async () => json(value));
    await assert.rejects(client.review({ buffer: Buffer.from('image'), mimeType: 'image/jpeg' }, sampleBrief()));
  }
});
