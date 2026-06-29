// Foundation + route to scoring.
//
// On messageReactionAdd: resolve partials, ignore bots, require the message to be in a
// registered thread, match the configured emoji, then route by mode. Showcase awards a
// point through the ordered rules; competition only logs (the real vote is a Discord Poll).

import { Events } from 'discord.js';
import { resolveReactionPartials } from '../lib/partials.js';
import { emojiMatches } from '../lib/emoji.js';
import { getEffectiveConfig } from '../services/config.js';
import { getThread } from '../services/threads.js';
import { tryAwardPoint, AwardResult } from '../services/scoring.js';
import { applyRewardRoles } from '../services/rewards.js';

export const name = Events.MessageReactionAdd;
export const once = false;

export async function execute(reaction, user) {
  // 1. Resolve partials (fetch reaction + message). Bail safely on failure.
  const ok = await resolveReactionPartials(reaction);
  if (!ok) return;

  // 2. Ignore reactions from bots.
  if (user.bot) return;

  try {
    // 3. The message must be in a registered thread. For a message in a thread,
    //    channelId is the thread id.
    const threadId = reaction.message.channelId;
    const thread = await getThread(threadId);
    if (!thread) return; // not a registered thread

    const cfg = await getEffectiveConfig();

    // 4. The emoji must match the configured helpful emoji.
    if (!emojiMatches(cfg.helpfulEmoji, reaction.emoji)) return;

    // 5. Route by mode.
    if (thread.mode === 'showcase') {
      await handleShowcase({ reaction, user, thread, cfg });
    } else if (thread.mode === 'competition') {
      handleCompetition({ reaction, user, thread });
    }
  } catch (err) {
    console.error('[messageReactionAdd] handler error:', err.message);
  }
}

async function handleShowcase({ reaction, user, thread, cfg }) {
  const comment = reaction.message;

  const { result, point } = await tryAwardPoint({
    thread,
    reactorId: user.id,
    comment,
    cfg,
  });

  if (result === AwardResult.AWARDED) {
    console.log(
      `[showcase] point -> ${point.commenterTag} (${point.commenterId}) thread=${thread.threadId} week=${point.isoWeek}`,
    );
    // Optional confirmation react so the commenter sees the point landed.
    try {
      await comment.react('1521124760220729445');
    } catch {
      /* non-fatal */
    }
    // Optional reward roles.
    if (reaction.message.guild) {
      await applyRewardRoles({
        guild: reaction.message.guild,
        userId: point.commenterId,
        cfg,
      });
    }
  } else {
    // Log the rejected branch for observability; these are normal, not errors.
    console.log(`[showcase] no point (${result}) thread=${thread.threadId} comment=${comment.id}`);
  }
}

// Competition mode reads reactions only to prove the foundation works. No scoring; the
// winner is decided by a native Discord Poll. We log so /rescan and live tests can
// confirm reactions are being read on entry threads.
function handleCompetition({ reaction, user, thread }) {
  console.log(
    `[competition] read reaction from ${user.tag} on entry thread=${thread.threadId} (display only; winner via Poll)`,
  );
}
