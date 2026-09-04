import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHelpfulHintMessage } from '../src/services/helpfulHint.js';

test('helpful hint explains feedback, playable links, and opt-in publishing', () => {
  const message = buildHelpfulHintMessage({ emoji: '🙌', threadName: 'Moon Base', welcome: true });

  assert.match(message, /react to that comment with 🙌/);
  assert.match(message, /\/projecturl/);
  assert.match(message, /Publish to site/);
  assert.match(message, /stays in Discord/);
  assert.match(message, /does not publish or create a Project\/page/);
  assert.doesNotMatch(message, /\b(?:\d{15,})\b/);
});
