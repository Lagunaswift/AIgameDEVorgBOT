const snowflake = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);

async function readResource(rest, route) {
  try {
    return await rest.get(route);
  } catch (error) {
    if ([403, 404].includes(error.status) || [10003, 10004].includes(error.code)) return null;
    throw error;
  }
}

// The tag is moderator approval, never a replacement for the owner's Project intent.
// Raw REST requests avoid a stale gateway cache. Callers still enforce stored ownership
// and the exact single-thread association; export is the final live-approval gate.
export async function checkGameApproval(rest, { threadId, ownerId, forumId, guildId, publishTagId }) {
  if (![threadId, ownerId, forumId, guildId, publishTagId].every(snowflake)) {
    return { approved: false, reason: 'invalid-approval-identifiers' };
  }
  const channel = await readResource(rest, `/channels/${threadId}`);
  if (!channel) return { approved: false, reason: 'thread-unavailable' };
  if (channel.id !== threadId || channel.guild_id !== guildId || channel.parent_id !== forumId
    || channel.owner_id !== ownerId || channel.type !== 11) {
    return { approved: false, reason: 'thread-identity-mismatch' };
  }
  const forum = await readResource(rest, `/channels/${forumId}`);
  if (!forum) return { approved: false, reason: 'forum-unavailable' };
  if (forum.id !== forumId || forum.guild_id !== guildId || ![15, 16].includes(forum.type)) {
    return { approved: false, reason: 'forum-identity-mismatch' };
  }
  const tag = Array.isArray(forum.available_tags) ? forum.available_tags.find((value) => value.id === publishTagId) : null;
  if (tag?.moderated !== true) return { approved: false, reason: 'moderated-approval-tag-missing' };
  if (!Array.isArray(channel.applied_tags) || !channel.applied_tags.includes(publishTagId)) {
    return { approved: false, reason: 'not-approved' };
  }
  return { approved: true, channel };
}
