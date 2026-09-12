import { Events } from 'discord.js';
import { config } from '../config.js';
import { reconcileHostedBuildsForThread } from '../services/hostedBuilds.js';
import { reconcileAllActiveJamEligibility, reconcileJamEligibilityForThread } from '../services/jamEligibility.js';
import { lockQualifiedJamSubmissions, reconcileJamPhaseFromThread } from '../services/jams.js';

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
      const phase = await reconcileJamPhaseFromThread(newThread, {
        beforeVoting: async () => reconcileAllActiveJamEligibility(newThread.client),
      });
      if (phase.status === 'updated' || phase.status === 'invalid-tags' || phase.status === 'blocked-transition') {
        console.log(`[threadUpdate] jam phase thread=${newThread.id} status=${phase.status}${phase.phase ? ` phase=${phase.phase}` : ''}`);
      }
      if (phase.status === 'updated' && phase.phase === 'voting') {
        const results = await lockQualifiedJamSubmissions(newThread.id);
        const locked = results.filter((item) => item.status === 'locked').length;
        const blocked = results.filter((item) => item.status === 'blocked').length;
        console.log(`[threadUpdate] jam voting lock thread=${newThread.id} locked=${locked} blocked=${blocked}`);
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
