// Tally logo-competition votes across a channel and rank the entries.
//
// The competition can be laid out two ways, and this reads both by inspecting the channel:
//   • Forum / Media channel — each post is a thread and one entry. The vote reaction lives
//     on the thread's starter message; the entry owner is the thread owner.
//   • Text / Announcement channel (or a single thread) — each message that carries the vote
//     emoji is an entry, owned by that message's author.
//
// An entry's score is the number of DISTINCT non-bot users who reacted with the vote emoji,
// with a configurable rule for whether the entry's own owner (or any contestant) is allowed
// to count. Everything here reads Discord live, so it does not depend on the bot having
// registered the competition channel or its threads beforehand.

import { ChannelType } from 'discord.js';

// How many messages to scan when the competition is a plain text channel rather than a
// forum. Generous for a competition channel; entries beyond this are reported as skipped
// rather than silently dropped.
const MAX_MESSAGES_SCANNED = 1000;

// Voter-scope rules. Exported so the command can validate/label them.
export const VoterScope = {
  // Count everyone except the owner of the entry being tallied (no self-votes). Default.
  EXCLUDE_SELF: 'exclude-self',
  // Count only users who did not submit any entry (exclude every contestant).
  NON_CONTESTANTS: 'non-contestants',
  // Count every non-bot reaction.
  ALL: 'all',
};

// --- emoji matching ---------------------------------------------------------------

// Parse a user-supplied emoji into a matcher. Accepts any of:
//   "logocomp" / ":logocomp:"          -> match a custom (or unicode) emoji by name
//   "<:logocomp:123>" / "<a:name:123>" -> match by the extracted id
//   "123456789012345678"               -> match a custom emoji by id
//   "✅"                                -> match a unicode emoji (name is the char itself)
// Returns { id, name } where exactly one is set, or null for empty input.
export function parseEmojiSpec(spec) {
  const raw = (spec || '').trim();
  if (!raw) return null;

  // Full mention form <:name:id> or animated <a:name:id> — the id is authoritative.
  const mention = raw.match(/^<a?:([a-zA-Z0-9_]+):(\d+)>$/);
  if (mention) return { id: mention[2], name: mention[1] };

  // Bare snowflake — a custom emoji id.
  if (/^\d{15,}$/.test(raw)) return { id: raw, name: null };

  // Otherwise treat it as a name (strip surrounding colons if the user typed them).
  return { id: null, name: raw.replace(/^:+|:+$/g, '') };
}

// Does a discord.js reaction emoji (reaction.emoji) match the parsed spec?
export function reactionMatchesSpec(spec, reactionEmoji) {
  if (!spec || !reactionEmoji) return false;
  // Prefer id matching for custom emoji: it survives the emoji being renamed in the server.
  if (spec.id) return reactionEmoji.id === spec.id;
  if (!reactionEmoji.name || !spec.name) return false;
  return reactionEmoji.name.toLowerCase() === spec.name.toLowerCase();
}

// A short, human-readable label for the emoji, for the summary line.
export function emojiLabel(spec) {
  if (!spec) return '?';
  if (spec.name) return `:${spec.name}:`;
  return `id ${spec.id}`;
}

// --- reaction reading -------------------------------------------------------------

// Every distinct non-bot user id that reacted to `message` with the vote emoji.
// Returns null when the message has no matching reaction at all (so "no reaction" is
// distinguishable from "reacted, but zero counted after exclusions").
async function voteReactorIds(message, emojiSpec) {
  const reaction = message.reactions.cache.find((r) => reactionMatchesSpec(emojiSpec, r.emoji));
  if (!reaction) return null;

  const ids = new Set();
  let after;
  // The reaction-users endpoint returns at most 100 per page; walk it with an `after`
  // cursor so entries with a lot of votes are fully counted, not truncated at 100.
  for (;;) {
    const options = { limit: 100 };
    if (after) options.after = after;
    const page = await reaction.users.fetch(options);
    if (page.size === 0) break;
    for (const user of page.values()) {
      if (!user.bot) ids.add(user.id);
    }
    after = page.lastKey();
    if (page.size < 100) break;
  }
  return ids;
}

// --- gathering entries ------------------------------------------------------------

// All threads in a forum/media channel: active plus public archived (paginated).
async function collectForumThreads(channel) {
  const byId = new Map();

  try {
    const active = await channel.threads.fetchActive();
    for (const [id, thread] of active.threads) byId.set(id, thread);
  } catch {
    /* no access to active threads; fall through to whatever we can read */
  }

  let before;
  for (;;) {
    let page;
    try {
      page = await channel.threads.fetchArchived({ type: 'public', limit: 100, before });
    } catch {
      break; // missing Read Message History, or nothing archived — stop paginating.
    }
    if (!page || page.threads.size === 0) break;

    let oldest;
    for (const [id, thread] of page.threads) {
      byId.set(id, thread);
      oldest = thread;
    }
    if (!page.hasMore || !oldest) break;
    before = oldest; // a ThreadChannel is a valid `before` cursor (uses its archive time).
  }

  return [...byId.values()];
}

// Build entry records from a forum/media channel: one per thread, vote on the starter msg.
async function gatherThreadEntries(channel, emojiSpec) {
  const threads = await collectForumThreads(channel);
  const entries = [];

  for (const thread of threads) {
    let starter = null;
    try {
      starter = await thread.fetchStarterMessage();
    } catch {
      starter = null; // starter message deleted or unreadable.
    }

    const voters = starter ? await voteReactorIds(starter, emojiSpec) : null;

    entries.push({
      ownerId: thread.ownerId || starter?.author?.id || null,
      voters: voters || new Set(),
      hasReaction: voters !== null,
      link: `<#${thread.id}>`,
      title: thread.name || 'Untitled entry',
      url: starter?.url || null,
    });
  }

  return { entries, truncated: false };
}

// Build entry records from a text-based channel: one per message carrying the vote emoji.
async function gatherMessageEntries(channel, emojiSpec) {
  const entries = [];
  let before;
  let scanned = 0;
  let truncated = false;

  outer: for (;;) {
    let batch;
    try {
      batch = await channel.messages.fetch({ limit: 100, before });
    } catch {
      break; // missing Read Message History, or the channel became unreadable.
    }
    if (batch.size === 0) break;

    for (const message of batch.values()) {
      scanned += 1;
      if (scanned > MAX_MESSAGES_SCANNED) {
        truncated = true;
        break outer;
      }
      if (message.author?.bot) continue;

      const voters = await voteReactorIds(message, emojiSpec);
      if (voters === null) continue; // not an entry — no vote emoji on it.

      entries.push({
        ownerId: message.author?.id || null,
        voters,
        hasReaction: true,
        link: `[${message.author?.username || 'entry'}](${message.url})`,
        title: message.author?.username || 'entry',
        url: message.url,
      });
      before = message.id;
    }

    // `before` must advance even across a page of all-bot/no-vote messages.
    before = batch.lastKey();
  }

  return { entries, truncated };
}

// --- public API -------------------------------------------------------------------

// True for channel types where each post is its own thread/entry.
export function isThreadedChannel(channel) {
  return (
    channel?.type === ChannelType.GuildForum || channel?.type === ChannelType.GuildMedia
  );
}

// Tally votes and return a ranked result.
//
// Returns { entries, totals } where entries are sorted by counted votes (desc) and carry a
// `rank` with ties shared (1, 2, 2, 4). `totals` summarises the run for the header line.
export async function tallyLogoVotes({ channel, emojiSpec, voterScope = VoterScope.EXCLUDE_SELF }) {
  const { entries, truncated } = isThreadedChannel(channel)
    ? await gatherThreadEntries(channel, emojiSpec)
    : await gatherMessageEntries(channel, emojiSpec);

  // The set of everyone who submitted an entry — needed for the non-contestants rule.
  const contestantIds = new Set(entries.map((e) => e.ownerId).filter(Boolean));

  let totalCounted = 0;
  let ownerSelfVotes = 0;

  for (const entry of entries) {
    let counted = 0;
    for (const voterId of entry.voters) {
      // Track owner self-votes regardless of scope, so the summary can report them.
      if (entry.ownerId && voterId === entry.ownerId) ownerSelfVotes += 1;

      if (voterScope === VoterScope.EXCLUDE_SELF && voterId === entry.ownerId) continue;
      if (voterScope === VoterScope.NON_CONTESTANTS && contestantIds.has(voterId)) continue;
      counted += 1;
    }
    entry.votes = counted;
    entry.rawVotes = entry.voters.size;
    totalCounted += counted;
  }

  entries.sort((a, b) => b.votes - a.votes || b.rawVotes - a.rawVotes);

  // Competition ranking: equal scores share a rank, next distinct score skips the tie group.
  let lastVotes = null;
  let lastRank = 0;
  entries.forEach((entry, i) => {
    if (entry.votes !== lastVotes) {
      lastRank = i + 1;
      lastVotes = entry.votes;
    }
    entry.rank = lastRank;
  });

  return {
    entries,
    totals: {
      entryCount: entries.length,
      totalCounted,
      ownerSelfVotes,
      contestants: contestantIds.size,
      truncated,
    },
  };
}
