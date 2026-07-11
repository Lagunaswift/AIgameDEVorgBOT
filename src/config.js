// Centralised env loading + defaults.
//
// A Firestore `config` doc (id = guildId) can override these at runtime so values
// change without a redeploy (see services/config.js for the merge). This module is
// the static, env-backed baseline that the bot boots with.

function parseIdList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function intOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export const config = {
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,

  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT,

  watchedShowcaseForumIds: parseIdList(process.env.WATCHED_SHOWCASE_FORUM_IDS),
  watchedCompetitionForumIds: parseIdList(process.env.WATCHED_COMPETITION_FORUM_IDS),

  // The helpful emoji can be unicode ("✅") or a custom emoji id (a numeric snowflake).
  // We match on id when the value is all digits, otherwise on the unicode name.
  helpfulEmoji: process.env.HELPFUL_EMOJI || '✅',

  minCommentLength: intOr(process.env.MIN_COMMENT_LENGTH, 0),
  maxPointsPerThreadPerUser: intOr(process.env.MAX_POINTS_PER_THREAD_PER_USER, 2),

  leaderboardChannelId: process.env.LEADERBOARD_CHANNEL_ID || null,
  modFeedChannelId: process.env.MOD_FEED_CHANNEL_ID || null,
  modRoleId: process.env.MOD_ROLE_ID || null,

  rewardThresholds: parseJson(process.env.REWARD_THRESHOLDS, []),
  excludedTagNames: parseIdList(process.env.EXCLUDED_TAG_NAMES || 'just-sharing'),

  weeklyPostEnabled: (process.env.WEEKLY_POST_ENABLED || 'true').toLowerCase() !== 'false',
};

// Validate the essentials at boot so we fail loud rather than silently mis-scoring later.
export function assertConfig() {
  const missing = [];
  if (!config.discordToken) missing.push('DISCORD_TOKEN');
  if (!config.clientId) missing.push('CLIENT_ID');
  if (!config.guildId) missing.push('GUILD_ID');
  if (!config.firebaseServiceAccount) missing.push('FIREBASE_SERVICE_ACCOUNT');

  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  if (
    config.watchedShowcaseForumIds.length === 0 &&
    config.watchedCompetitionForumIds.length === 0
  ) {
    console.warn(
      '[config] No watched forums configured via env. The bot will register nothing until a config doc or /registerforum adds one.',
    );
  }
}

// True when the configured helpful emoji is a custom emoji (matched by id), false for unicode.
export function helpfulEmojiIsCustom(value = config.helpfulEmoji) {
  return /^\d+$/.test(value);
}
