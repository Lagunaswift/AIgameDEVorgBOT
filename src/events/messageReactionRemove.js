// Reaction removed, so misclicks are reversible.
//
// In showcase mode: if a points doc exists for this comment and the remover is the
// thread owner, delete it. The owner un-ticking a comment revokes the point. Resolve
// partials the same way as the add handler.

import { Events } from 'discord.js';
import { resolveReactionPartials } from '../lib/partials.js';
import { emojiMatches } from '../lib/emoji.js';
import { getEffectiveConfig } from '../services/config.js';
import { getThread } from '../services/threads.js';
import { revokePoint } from '../services/scoring.js';

export const name = Events.MessageReactionRemove;
export const once = false;

export async function execute(reaction, user) {
  const ok = await resolveReactionPartials(reaction);
  if (!ok) return;

  if (user.bot) return;

  try {
    const threadId = reaction.message.channelId;
    const thread = await getThread(threadId);
    if (!thread) return;

    // Only showcase points are revocable; competition has no points to revoke.
    if (thread.mode !== 'showcase') return;

    const cfg = await getEffectiveConfig();
    if (!emojiMatches(cfg.helpfulEmoji, reaction.emoji)) return;

    const revoked = await revokePoint({
      thread,
      removerId: user.id,
      commentMessageId: reaction.message.id,
    });

    if (revoked) {
      console.log(
        `[showcase] point revoked thread=${thread.threadId} comment=${reaction.message.id} by owner ${user.id}`,
      );
      // Remove the confirmation medal if we added one.
      try {
        const medal = reaction.message.reactions.cache.find((r) => r.emoji.id === '1521124760220729445');
        if (medal) await medal.users.remove(reaction.message.client.user.id);
      } catch {
        /* non-fatal */
      }
    }
  } catch (err) {
    console.error('[messageReactionRemove] handler error:', err.message);
  }
}
