import { Events } from 'discord.js';
import { hostedPlatformFlags } from '../lib/hostedFeatureFlags.js';
import { reconcileThreadHostedBuild } from '../services/hostedBuildRuntime.js';
import { syncThreadJamEligibility } from '../services/jams.js';

export const name = Events.ThreadUpdate;
export const once = false;

function normalizedTags(thread) {
  return Array.isArray(thread?.appliedTags) ? [...thread.appliedTags].sort() : [];
}

function tagsChanged(oldThread, newThread) {
  const before = normalizedTags(oldThread);
  const after = normalizedTags(newThread);
  return before.length !== after.length || before.some((value, index) => value !== after[index]);
}

export async function execute(oldThread, newThread) {
  const flags = hostedPlatformFlags();
  if (!flags.hostedBuildsEnabled && !flags.jamHostingEnabled) return;
  if (!newThread?.id || !tagsChanged(oldThread, newThread)) return;

  if (flags.jamHostingEnabled) {
    try {
      await syncThreadJamEligibility(newThread);
    } catch (error) {
      console.error(`[hosted-platform] Jam eligibility sync failed for thread ${newThread.id}:`, error.message);
    }
  }

  if (flags.hostedBuildsEnabled) {
    try {
      await reconcileThreadHostedBuild({ threadId: newThread.id, rest: newThread.client.rest });
    } catch (error) {
      console.error(`[hosted-platform] runtime reconciliation failed for thread ${newThread.id}:`, error.message);
    }
  }
}
