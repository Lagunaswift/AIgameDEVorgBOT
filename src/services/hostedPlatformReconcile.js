import { getDb } from '../firebase.js';
import { hostedPlatformFlags } from '../lib/hostedFeatureFlags.js';
import { reconcileProjectHostedBuild } from './hostedBuildRuntime.js';
import { syncThreadJamEligibility } from './jams.js';

const DEFAULT_INTERVAL_MS = 10 * 60_000;
let timer = null;
let running = false;

async function mapWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const results = [];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { results.push(await worker(item)); }
      catch (error) { results.push({ status: 'error', error }); }
    }
  });
  await Promise.all(runners);
  return results;
}

async function hostedProjectIds() {
  const db = getDb();
  const [states, submissions, publicBuilds] = await Promise.all([
    db.collection('projectBuildState').get(),
    db.collection('jamSubmissions').get(),
    db.collection('projectBuilds').where('runtimeState', '==', 'public').get(),
  ]);
  const ids = new Set();
  for (const doc of states.docs) ids.add(doc.id);
  for (const doc of submissions.docs) {
    const projectId = doc.data()?.projectId;
    if (typeof projectId === 'string') ids.add(projectId);
  }
  for (const doc of publicBuilds.docs) {
    const projectId = doc.data()?.projectId;
    if (typeof projectId === 'string') ids.add(projectId);
  }
  return [...ids].sort();
}

async function refreshOpenJamEligibility(client) {
  const db = getDb();
  const openJams = await db.collection('jams').where('phase', 'in', ['upcoming', 'active']).limit(20).get();
  if (openJams.empty) return { checked: 0, failed: 0 };

  const projects = await db.collection('projects').get();
  const threadIds = [...new Set(projects.docs
    .map((doc) => doc.data()?.profileThreadId)
    .filter((value) => typeof value === 'string'))];
  let checked = 0;
  let failed = 0;
  await mapWithConcurrency(threadIds, 3, async (threadId) => {
    try {
      const thread = await client.channels.fetch(threadId, { force: true });
      if (!thread?.isThread?.()) {
        failed += 1;
        return;
      }
      await syncThreadJamEligibility(thread);
      checked += 1;
    } catch (error) {
      failed += 1;
      console.error(`[hosted-platform] failed to refresh Jam eligibility for ${threadId}:`, error.message);
    }
  });
  return { checked, failed };
}

export async function reconcileHostedPlatform(client) {
  const flags = hostedPlatformFlags();
  if (!flags.hostedBuildsEnabled && !flags.jamHostingEnabled) return { status: 'disabled' };
  if (running) return { status: 'busy' };
  running = true;
  try {
    const summary = {
      status: 'ok',
      eligibility: { checked: 0, failed: 0 },
      runtime: { checked: 0, blocked: 0, failed: 0 },
    };

    if (flags.jamHostingEnabled) {
      summary.eligibility = await refreshOpenJamEligibility(client);
    }

    if (flags.hostedBuildsEnabled) {
      const projectIds = await hostedProjectIds();
      await mapWithConcurrency(projectIds, 2, async (projectId) => {
        try {
          const result = await reconcileProjectHostedBuild({ projectId, rest: client.rest });
          summary.runtime.checked += 1;
          if (result.status === 'blocked') summary.runtime.blocked += 1;
        } catch (error) {
          summary.runtime.failed += 1;
          console.error(`[hosted-platform] periodic runtime reconciliation failed for ${projectId}:`, error.message);
        }
      });
    }

    return summary;
  } finally {
    running = false;
  }
}

export function scheduleHostedPlatformReconciliation(client, intervalMs = DEFAULT_INTERVAL_MS) {
  const flags = hostedPlatformFlags();
  if (!flags.hostedBuildsEnabled && !flags.jamHostingEnabled) return null;
  if (timer) return timer;
  const run = () => reconcileHostedPlatform(client)
    .then((result) => {
      if (result.status === 'ok') {
        console.log(`[hosted-platform] reconcile: eligibility=${result.eligibility.checked}/${result.eligibility.failed} failed; runtime=${result.runtime.checked} checked, ${result.runtime.blocked} blocked, ${result.runtime.failed} failed`);
      }
    })
    .catch((error) => console.error('[hosted-platform] reconciliation pass failed:', error.message));
  run();
  timer = setInterval(run, intervalMs);
  return timer;
}
