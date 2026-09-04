// Text normalisation, REST helpers, and the showcase eligibility decision shared by
// export-site-data.mjs and migrate-projects.mjs.
//
// This module was extracted behaviour-preserving from export-site-data.mjs so the
// Phase 3 migration reproduces the exporter's publication boundary exactly instead of
// re-implementing it. The eligibility rules live here once, in one place:
//
//   1. the Discord channel must still exist;
//   2. the channel's parent forum must match the Firestore thread's forumId and be one
//      of the source forums the showcase set was read from;
//   3. the channel must return an applied_tags array;
//   4. applied_tags must contain the SITE_PUBLISH_TAG_ID tag — this is the publication
//      boundary: untagged (private) threads are never treated as public data.
//
// Anything else (unknown tag ids, missing starter messages) is a caller-level failure
// and deliberately stays out of this decision.

export const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

// Strips the markdown constructs called out in the data contract: custom emoji tags,
// link syntax (kept as its label), bold/italic/underline/strikethrough/code markers.
// Longest markers are stripped first so triple/double sequences don't leave stray chars.
export function stripMarkdown(input) {
  if (!input) return '';
  let text = String(input);
  text = text.replace(/<a?:([A-Za-z0-9_]+):\d+>/g, ':$1:');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/~~/g, '');
  text = text.replace(/```/g, '');
  text = text.replace(/``/g, '');
  text = text.replace(/`/g, '');
  text = text.replace(/\*\*\*/g, '');
  text = text.replace(/\*\*/g, '');
  text = text.replace(/__/g, '');
  text = text.replace(/\*/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

export function truncate(text, max) {
  if (!text) return text;
  if (text.length <= max) return text;
  return text.slice(0, max).trim();
}

export function extractText(message, max) {
  if (!message) return null;
  const cleaned = truncate(stripMarkdown(message.content || ''), max);
  return cleaned || null;
}

export function isMissingResource(err) {
  if (!err) return false;
  if (err.status === 404 || err.status === 403) return true;
  if (err.code === 10003 || err.code === 10004) return true;
  return false;
}

export async function getChannel(rest, id) {
  return rest.get(`/channels/${id}`);
}

export async function getStarterMessage(rest, threadId) {
  // In a forum thread the starter message id equals the thread id.
  try {
    return await rest.get(`/channels/${threadId}/messages/${threadId}`);
  } catch (err) {
    if (isMissingResource(err)) return null;
    throw err;
  }
}

// Pure eligibility decision for one showcase thread. `channel` is the live Discord
// channel object, or null when the REST lookup reported the channel missing. Returns a
// machine-readable status; callers keep their own reporting semantics (the exporter
// warns and withholds; the migration records an exclusion reason).
export function checkShowcaseEligibility({ channel, firestoreData, sourceForumIds, publishTagId }) {
  if (!channel) return { status: 'missing-channel' };

  const forumId = channel.parent_id || null;
  if (!forumId || forumId !== firestoreData.forumId || !sourceForumIds.has(forumId)) {
    return { status: 'uncertain-forum' };
  }
  if (!Array.isArray(channel.applied_tags)) {
    return { status: 'no-applied-tags' };
  }
  // This is the publication boundary: untagged threads never have their text or assets read.
  if (!channel.applied_tags.includes(publishTagId)) {
    return { status: 'not-published' };
  }
  return { status: 'ok', forumId };
}

// Resolves a forum's available tags into an id -> {name, emojiId, emojiName} map.
// Throws when the forum is missing its tag list or returns a malformed tag, so no
// caller ever guesses what an unknown tag id meant.
export async function getForumTagMap(rest, forumId, cache) {
  if (cache.has(forumId)) return cache.get(forumId);
  const map = new Map();
  const forum = await getChannel(rest, forumId);
  if (!Array.isArray(forum.available_tags)) {
    throw new Error(`forum ${forumId} did not return available_tags`);
  }
  for (const tag of forum.available_tags) {
    if (!tag || !tag.id || !tag.name) {
      throw new Error(`forum ${forumId} returned a malformed tag`);
    }
    map.set(tag.id, { name: tag.name, emojiId: tag.emoji_id || null, emojiName: tag.emoji_name || null });
  }
  cache.set(forumId, map);
  return map;
}
