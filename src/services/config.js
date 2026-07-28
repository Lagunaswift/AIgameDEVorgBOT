// Runtime config: env baseline (src/config.js) merged with an optional Firestore
// `config` doc (id = guildId). The doc lets a mod change watched forums, the helpful
// emoji, length floor, cap, etc. without a redeploy. Env wins as the default; the doc
// overrides any field it sets.
//
// We cache the doc in memory and refresh it on a short interval and after writes, so
// hot-path handlers (every reaction) don't hit Firestore for config each time.

import { getDb } from '../firebase.js';
import { config as envConfig } from '../config.js';

const CACHE_TTL_MS = 60_000;

let cached = null;
let cachedAt = 0;

function emptyDoc() {
  return {};
}

// Build the effective config by overlaying the Firestore doc onto the env baseline.
function merge(docData) {
  const d = docData || emptyDoc();
  return {
    watchedShowcaseForumIds: d.watchedShowcaseForumIds ?? envConfig.watchedShowcaseForumIds,
    watchedCompetitionForumIds:
      d.watchedCompetitionForumIds ?? envConfig.watchedCompetitionForumIds,
    helpfulEmoji: d.helpfulEmoji ?? envConfig.helpfulEmoji,
    minCommentLength: d.minCommentLength ?? envConfig.minCommentLength,
    maxPointsPerThreadPerUser:
      d.maxPointsPerThreadPerUser ?? envConfig.maxPointsPerThreadPerUser,
    leaderboardChannelId: d.leaderboardChannelId ?? envConfig.leaderboardChannelId,
    modFeedChannelId: d.modFeedChannelId ?? envConfig.modFeedChannelId,
    excludedTagNames: d.excludedTagNames ?? envConfig.excludedTagNames,
    rewardThresholds: d.rewardThresholds ?? envConfig.rewardThresholds,
    milestoneThresholds: d.milestoneThresholds ?? envConfig.milestoneThresholds,
  };
}

function configRef() {
  return getDb().collection('config').doc(envConfig.guildId);
}

// Returns the effective config, using the in-memory cache when fresh.
export async function getEffectiveConfig({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }
  let docData = null;
  try {
    const snap = await configRef().get();
    docData = snap.exists ? snap.data() : null;
  } catch (err) {
    console.error('[config] failed to read config doc, falling back to env:', err.message);
  }
  cached = merge(docData);
  cachedAt = now;
  return cached;
}

// Returns the mode for a forum id, or null if it isn't watched.
export async function modeForForum(forumId) {
  const cfg = await getEffectiveConfig();
  if (cfg.watchedShowcaseForumIds.includes(forumId)) return 'showcase';
  if (cfg.watchedCompetitionForumIds.includes(forumId)) return 'competition';
  return null;
}

// Add a forum to the watched list for a mode (used by /registerforum). Writes to the
// config doc and invalidates the cache so the change takes effect immediately.
export async function registerForum(forumId, mode) {
  const cfg = await getEffectiveConfig({ force: true });
  const field =
    mode === 'showcase' ? 'watchedShowcaseForumIds' : 'watchedCompetitionForumIds';

  const current = cfg[field];
  if (current.includes(forumId)) {
    return { added: false };
  }

  const next = [...current, forumId];
  await configRef().set({ [field]: next }, { merge: true });
  invalidate();
  return { added: true };
}

export function invalidate() {
  cached = null;
  cachedAt = 0;
}
