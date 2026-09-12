// ready event: log who we are and what we're watching. Handlers are already registered
// once at startup (see index.js), so nothing per-connection happens here.

import { Events } from 'discord.js';
import { getEffectiveConfig } from '../services/config.js';
import { reconcileAllActiveJamEligibility } from '../services/jamEligibility.js';
import { startBuildReportNotifier } from '../services/buildReports.js';

export const name = Events.ClientReady;
export const once = true;

const JAM_RECONCILE_MS = 5 * 60 * 1000;

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

  startBuildReportNotifier(client);

  let running = false;
  const reconcile = async () => {
    if (running) return;
    running = true;
    try {
      const result = await reconcileAllActiveJamEligibility(client);
      if (result.checked || result.errors.length) {
        console.log(`[jamEligibility] checked=${result.checked} eligible=${result.eligible} blocked=${result.blocked} errors=${result.errors.length}`);
      }
    } catch (error) {
      console.error('[jamEligibility] periodic reconciliation failed:', error.message);
    } finally {
      running = false;
    }
  };

  await reconcile();
  const timer = setInterval(reconcile, JAM_RECONCILE_MS);
  timer.unref?.();
}
