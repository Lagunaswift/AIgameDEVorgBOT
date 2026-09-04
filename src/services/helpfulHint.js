// One-time private hint that teaches thread owners the feedback-point ritual.
//
// A newly registered showcase thread gets the first opportunity to receive the DM. The
// first time someone ELSE comments remains the fallback. Strictly private: if the owner's
// DMs are closed the hint is silently dropped, never posted publicly. Dedup is per OWNER
// (not per thread) via the `helpfulHints` collection, claimed atomically with create() so
// the hint can never send twice, then mirrored in a process-lifetime Set to avoid re-reads.

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

export function buildHelpfulHintMessage({ emoji, threadName, welcome = false }) {
  const opening = welcome
    ? `Your new showcase thread **${threadName}** is registered.`
    : `Someone just commented on your showcase thread **${threadName}**.`;

  return `${opening}\n\n` +
    `One-time tip: when feedback genuinely helps you, react to that comment with ${emoji} ` +
    `and the commenter earns a feedback point. As the thread owner, use **/projecturl** in ` +
    `this registered thread to save playable URL metadata; it does not publish or create a ` +
    `Project/page. Public site listing is controlled only by the community's **Publish to site** ` +
    `forum tag. Without that tag, your project stays in Discord.`;
}

async function sendHelpfulHint({ channel, client, authorId, welcome = false }) {
  if (!channel || !authorId || hintedThisProcess.has(authorId)) return;

  // Atomic claim: create() throws if the doc exists, so exactly one hint per owner
  // ever, across restarts and concurrent events.
  try {
    await hintRef(authorId).create({
      ownerId: authorId,
      threadId: channel.id,
      sentAt: serverTimestamp(),
    });
  } catch {
    hintedThisProcess.add(authorId);
    return;
  }
  hintedThisProcess.add(authorId);

  const cfg = await getEffectiveConfig();
  const emoji = emojiDisplay(client, cfg.helpfulEmoji);
  const dm = buildHelpfulHintMessage({ emoji, threadName: channel.name, welcome });

  try {
    const owner = await client.users.fetch(authorId);
    await owner.send(dm);
    console.log(`[helpfulHint] DMed owner ${authorId} (thread ${channel.id})`);
  } catch (err) {
    // DMs closed or unreachable: stay silent (the hint must be private). The dedup
    // doc stays so we never retry-spam the log on every later comment.
    console.warn(`[helpfulHint] could not DM owner ${authorId}: ${err.message}`);
  }
}

export async function maybeSendHelpfulHintForThread(thread) {
  try {
    if (!thread || typeof thread.isThread !== 'function' || !thread.isThread()) return;
    await sendHelpfulHint({
      channel: thread,
      client: thread.client,
      authorId: thread.ownerId,
      welcome: true,
    });
  } catch (err) {
    console.warn('[helpfulHint] failed:', err.message);
  }
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
    await sendHelpfulHint({ channel, client: message.client, authorId: ownerId });
  } catch (err) {
    console.warn('[helpfulHint] failed:', err.message);
  }
}
