import assert from 'node:assert/strict';
import test from 'node:test';
import { threadFollowsGuidelines } from '../src/services/guidelinesNudge.js';

test('a retired just-sharing tag does not bypass guidelines', async () => {
  const thread = {
    appliedTags: ['retired-just-sharing-tag'],
    parent: {
      availableTags: [{ id: 'retired-just-sharing-tag', name: 'just-sharing' }],
    },
    async fetchStarterMessage() {
      return { content: 'Here is the newest build.' };
    },
  };

  assert.equal(await threadFollowsGuidelines(thread), false);
});
