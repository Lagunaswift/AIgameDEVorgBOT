import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHelpfulHintMessage } from '../src/services/helpfulHint.js';

test('helpful hint explains feedback, playable links, and opt-in publishing', () => {
  const message = buildHelpfulHintMessage({ emoji: '🙌', threadName: 'Moon Base', welcome: true });

  assert.match(message, /react to the comment with 🙌/);
  assert.match(message, /\/projecturl/);
  assert.match(message, /Publish to site/);
  assert.match(message, /Only a moderator can apply/);
  assert.match(message, /public pages still need approval and your publication request/);
  assert.match(message, /Saved drafts stay private/);
  assert.match(message, /\/mygame manage/);
  assert.match(message, /ZIPs is not available yet/);
  assert.doesNotMatch(message, /\b(?:\d{15,})\b/);
});
