import { Events } from 'discord.js';
import { config } from '../config.js';
import { reconcileHostedBuildsForThread } from '../services/hostedBuilds.js';

export const name = Events.ThreadUpdate;
export const once = false;

function hasTag(thread, tagId) {
  return Boolean(tagId) && Array.isArray(thread?.appliedTags) && thread.appliedTags.includes(tagId);
}

export async function execute(oldThread, newThread) {
  try {
    const tagId = config.sitePublishTagId;
    if (!tagId) return;
    const wasApproved = hasTag(oldThread, tagId);
    const isApproved = hasTag(newThread, tagId);
    if (wasApproved === isApproved) return;

    const result = await reconcileHostedBuildsForThread({
      threadId: newThread.id,
      moderatorApproved: isApproved,
    });
    console.log(`[threadUpdate] hosted-build approval thread=${newThread.id} approved=${isApproved} status=${result.status}`);
  } catch (error) {
    console.error('[threadUpdate] hosted-build reconciliation failed:', error.message);
  }
}
