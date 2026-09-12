import { Events } from 'discord.js';
import { config } from '../config.js';
import { reconcileHostedBuildsForThread } from '../services/hostedBuilds.js';
import { reconcileJamEligibilityForThread } from '../services/jamEligibility.js';
import { reconcileJamPhaseFromThread } from '../services/jams.js';

export const name = Events.ThreadUpdate;
export const once = false;

function hasTag(thread, tagId) {
  return Boolean(tagId) && Array.isArray(thread?.appliedTags) && thread.appliedTags.includes(tagId);
}

function tagsChanged(oldThread, newThread) {
  const oldTags = Array.isArray(oldThread?.appliedTags) ? [...oldThread.appliedTags].sort() : [];
  const newTags = Array.isArray(newThread?.appliedTags) ? [...newThread.appliedTags].sort() : [];
  return oldTags.length !== newTags.length || oldTags.some((tag, index) => tag !== newTags[index]);
}

export async function execute(oldThread, newThread) {
  try {
    const publishTagId = config.sitePublishTagId;
    if (publishTagId) {
      const wasApproved = hasTag(oldThread, publishTagId);
      const isApproved = hasTag(newThread, publishTagId);
      if (wasApproved !== isApproved) {
        const result = await reconcileHostedBuildsForThread({
          threadId: newThread.id,
          moderatorApproved: isApproved,
        });
        console.log(`[threadUpdate] hosted-build approval thread=${newThread.id} approved=${isApproved} status=${result.status}`);
      }
    }

    if (tagsChanged(oldThread, newThread)) {
      const phase = await reconcileJamPhaseFromThread(newThread);
      if (phase.status === 'updated' || phase.status === 'invalid-tags' || phase.status === 'blocked-transition') {
        console.log(`[threadUpdate] jam phase thread=${newThread.id} status=${phase.status}${phase.phase ? ` phase=${phase.phase}` : ''}`);
      }

      const eligibility = await reconcileJamEligibilityForThread({ channel: newThread });
      if (eligibility.status === 'ok' && eligibility.updates.length) {
        console.log(`[threadUpdate] jam eligibility thread=${newThread.id} updates=${eligibility.updates.length}`);
      }
    }
  } catch (error) {
    console.error('[threadUpdate] hosted-build/jam reconciliation failed:', error.message);
  }
}
