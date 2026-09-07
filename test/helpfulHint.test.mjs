import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHelpfulHintMessage } from '../src/services/helpfulHint.js';

test('helpful hint explains feedback, playable links, and opt-in publishing', () => {
  const message = buildHelpfulHintMessage({ emoji: '🙌', threadName: 'Moon Base', welcome: true });

  assert.match(message, /react to the comment with 🙌/);
  assert.match(message, /\/projecturl/);
  assert.match(message, /Publish to site/);
  assert.match(message, /stays out of Showcase/);
  assert.match(message, /Project publication is a separate setting/);
  assert.match(message, /does not publish or create a Project page/);
  assert.doesNotMatch(message, /\b(?:\d{15,})\b/);
});
