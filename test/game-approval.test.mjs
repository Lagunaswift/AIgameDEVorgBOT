import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGameApproval } from '../src/lib/gameApproval.js';

const ids = {
  threadId: '123456789012345678', ownerId: '234567890123456789',
  forumId: '345678901234567890', guildId: '456789012345678901', publishTagId: '567890123456789012',
};
function rest({ thread = {}, forum = {}, error = null } = {}) {
  return { async get(route) {
    if (error) throw error;
    if (route === `/channels/${ids.threadId}`) return {
      id: ids.threadId, parent_id: ids.forumId, guild_id: ids.guildId, owner_id: ids.ownerId,
      type: 11, applied_tags: [ids.publishTagId], ...thread,
    };
    if (route === `/channels/${ids.forumId}`) return {
      id: ids.forumId, guild_id: ids.guildId, type: 15,
      available_tags: [{ id: ids.publishTagId, moderated: true }], ...forum,
    };
    assert.fail(`Unexpected approval route ${route}`);
  } };
}

test('approval requires the live moderator-only tag on the exact owned game thread', async () => {
  assert.equal((await checkGameApproval(rest(), ids)).approved, true);
  for (const options of [
    { thread: { applied_tags: [] } },
    { thread: { applied_tags: null } },
    { thread: { owner_id: ids.threadId } },
    { thread: { guild_id: ids.threadId } },
    { thread: { parent_id: ids.threadId } },
    { thread: { type: 12 } },
    { forum: { guild_id: ids.threadId } },
    { forum: { available_tags: [{ id: ids.publishTagId, moderated: false }] } },
    { forum: { available_tags: [] } },
  ]) assert.equal((await checkGameApproval(rest(options), ids)).approved, false);
});

test('unavailable approval resources fail closed while operational failures propagate', async () => {
  for (const status of [403, 404]) {
    assert.equal((await checkGameApproval(rest({ error: Object.assign(new Error('unavailable'), { status }) }), ids)).approved, false);
  }
  await assert.rejects(checkGameApproval(rest({ error: Object.assign(new Error('outage'), { status: 500 }) }), ids), /outage/);
  assert.equal((await checkGameApproval({ get: () => assert.fail('invalid identifiers must not fetch') }, { ...ids, publishTagId: undefined })).approved, false);
});
