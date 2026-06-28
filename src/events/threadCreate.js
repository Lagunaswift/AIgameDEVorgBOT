// Foundation: register threads.
//
// On threadCreate, if the parent forum is watched, write a `threads` doc with the real
// owner and the mode. Native forum ownership (thread.ownerId is the post author) is why
// this is more trustworthy than a /submit command.

import { Events } from 'discord.js';
import { modeForForum } from '../services/config.js';
import { registerThread } from '../services/threads.js';

export const name = Events.ThreadCreate;
export const once = false;

// newlyCreated is true only for genuinely new threads; discord.js also fires this when a
// thread becomes visible to the bot. We register in both cases (registration is
// idempotent), but skip the obvious non-create signal to avoid noise.
export async function execute(thread, newlyCreated) {
  try {
    // parentId is the forum channel id for a forum post.
    const forumId = thread.parentId;
    if (!forumId) return;

    const mode = await modeForForum(forumId);
    if (!mode) return; // not a watched forum

    const data = await registerThread(thread, mode);
    console.log(
      `[threadCreate] registered thread ${thread.id} "${data.title}" mode=${mode} owner=${data.ownerId} (newlyCreated=${newlyCreated})`,
    );
  } catch (err) {
    console.error('[threadCreate] failed to register thread:', err.message);
  }
}
