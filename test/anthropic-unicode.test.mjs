import assert from 'node:assert/strict';
import test from 'node:test';

// The client is intercepted before every call; this never contacts Anthropic.
process.env.ANTHROPIC_API_KEY = 'test-only-no-network';
const { callClaude, getAnthropic, scrubModelOutput } = await import('../src/services/anthropic.js');
const reply = (model) => ({
  model, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  content: [{ type: 'text', text: 'A valid recap 🎮' }],
});

test('plain Claude requests repair lone surrogates in system and user text', async (t) => {
  const api = getAnthropic();
  t.mock.method(api.messages, 'create', async (request) => {
    assert.equal(request.system, 'rules� 🎮');
    assert.equal(request.messages[0].content, 'Maker�: shipped 😀');
    assert.equal(request.messages[0].content.isWellFormed(), true);
    assert.equal(request.max_tokens, 8000);
    return reply(request.model);
  });
  const result = await callClaude({ model: 'test-plain', system: 'rules\ud800 🎮', userContent: 'Maker\udc00: shipped 😀' });
  assert.equal(result.text, 'A valid recap 🎮');
  assert.equal(api.messages.create.mock.callCount(), 1);
});

test('beta fallback requests receive the same Unicode repair without changing settings', async (t) => {
  const api = getAnthropic();
  t.mock.method(api.beta.messages, 'create', async (request) => {
    assert.equal(request.system.isWellFormed(), true);
    assert.equal(request.messages[0].content.isWellFormed(), true);
    assert.deepEqual(request.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(request.fallbacks, 'default');
    assert.deepEqual(request.output_config, { effort: 'medium' });
    return reply(request.model);
  });
  await callClaude({ model: 'claude-opus-5', system: 'rules\udc00', userContent: 'chat\ud800', effort: 'medium' });
  assert.equal(api.beta.messages.create.mock.callCount(), 1);
});

test('well-formed multilingual text and emoji are preserved exactly', async (t) => {
  const text = '日本語 café 👩🏽‍💻 😀 🎮';
  t.mock.method(getAnthropic().messages, 'create', async (request) => {
    assert.equal(request.system, text);
    assert.equal(request.messages[0].content, text);
    return reply(request.model);
  });
  await callClaude({ model: 'test-plain', system: text, userContent: text });
});

test('output scrubbing keeps mentions neutralised and Unicode well formed after caps', () => {
  const text = '@everyone <@123> @here ' + 'a'.repeat(279) + '😀 next\ud800';
  for (let maxChars = 20; maxChars < text.length; maxChars++) {
    const output = scrubModelOutput(text, { maxChars });
    assert.equal(output.isWellFormed(), true);
    assert.ok(output.length <= maxChars);
    assert.doesNotMatch(output, /@everyone|@here|<@123>/);
  }
});
