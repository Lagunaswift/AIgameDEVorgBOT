// ready event: log who we are and what we're watching. Handlers are already registered
// once at startup (see index.js), so nothing per-connection happens here.

import { Events } from 'discord.js';
import { getEffectiveConfig } from '../services/config.js';

export const name = Events.ClientReady;
export const once = true;

export async function execute(client) {
  console.log(`[ready] logged in as ${client.user.tag} (${client.user.id})`);

  try {
    const cfg = await getEffectiveConfig({ force: true });
    console.log(
      `[ready] watching showcase forums: [${cfg.watchedShowcaseForumIds.join(', ')}]`,
    );
    console.log(
      `[ready] watching competition forums: [${cfg.watchedCompetitionForumIds.join(', ')}]`,
    );
    console.log(
      `[ready] helpfulEmoji=${cfg.helpfulEmoji} minCommentLength=${cfg.minCommentLength} maxPointsPerThreadPerUser=${cfg.maxPointsPerThreadPerUser}`,
    );
  } catch (err) {
    console.error('[ready] could not load config:', err.message);
  }
}
