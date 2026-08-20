// One-time private hint that teaches thread owners the feedback-point ritual.
//
// The first time someone ELSE comments in a member's showcase thread, the owner gets a
// single DM explaining that reacting with the helpful emoji on a useful comment awards
// the commenter a feedback point. Strictly private: if the owner's DMs are closed the
// hint is silently dropped, never posted publicly. Dedup is per OWNER (not per thread)
// via the `helpfulHints` collection, claimed atomically with create() so the hint can
// never send twice, then mirrored in a process-lifetime Set to avoid re-reads.

import { getDb, serverTimestamp } from '../firebase.js';
import { getEffectiveConfig, modeForForum } from './config.js';

const hintedThisProcess = new Set();

function hintRef(ownerId) {
  return getDb().collection('helpfulHints').doc(ownerId);
}

// Render the configured helpful emoji for DM text: custom emoji id -> full <:name:id>
// mention when the bot can see it, unicode passes through, otherwise a plain phrase.
function emojiDisplay(client, helpfulEmoji) {
  const value = helpfulEmoji || '✅';
  if (/^\d+$/.test(value)) {
    const custom = client.emojis.cache.get(value);
    return custom ? custom.toString() : 'the helpful emoji';
  }
  return value;
}

export async function maybeSendHelpfulHint(message) {
  try {
    const channel = message.channel;
    if (!channel || typeof channel.isThread !== 'function' || !channel.isThread()) return;
    if (!message.author || message.author.bot) return;

    // Only showcase-forum threads (memory-cached config lookup, no per-message reads).
    const mode = await modeForForum(channel.parentId);
    if (mode !== 'showcase') return;

    const ownerId = channel.ownerId;
    if (!ownerId || message.author.id === ownerId) return;
    if (hintedThisProcess.has(ownerId)) return;

    // Atomic claim: create() throws if the doc exists, so exactly one hint per owner
    // ever, across restarts and concurrent events.
    try {
      await hintRef(ownerId).create({
        ownerId,
        threadId: channel.id,
        sentAt: serverTimestamp(),
      });
    } catch {
      hintedThisProcess.add(ownerId);
      return;
    }
    hintedThisProcess.add(ownerId);

    const cfg = await getEffectiveConfig();
    const emoji = emojiDisplay(message.client, cfg.helpfulEmoji);

    const dm =
      `Hey! Someone just commented on your showcase thread **${channel.name}**.\n\n` +
      `One-time tip: when a comment genuinely helps you, react to it with ${emoji} ` +
      `and the commenter earns a feedback point on the community leaderboard. Only you ` +
      `can award points in your own thread, so it is worth doing for the comments that ` +
      `actually move your game forward.`;

    try {
      const owner = await message.client.users.fetch(ownerId);
      await owner.send(dm);
      console.log(`[helpfulHint] DMed owner ${ownerId} (thread ${channel.id})`);
    } catch (err) {
      // DMs closed or unreachable: stay silent (the hint must be private). The dedup
      // doc stays so we never retry-spam the log on every later comment.
      console.warn(`[helpfulHint] could not DM owner ${ownerId}: ${err.message}`);
    }
  } catch (err) {
    console.warn('[helpfulHint] failed:', err.message);
  }
}
