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
  // Milestone alerts get their own channel. Falls back to the mod feed when unset, so
  // new-thread and new-poster notices don't have to share with reward actions.
  milestoneChannelId: process.env.MILESTONE_CHANNEL_ID || null,
  modRoleId: process.env.MOD_ROLE_ID || null,

  rewardThresholds: parseJson(process.env.REWARD_THRESHOLDS, []),

  // All-time point totals that alert the mod feed. Notification only — no role is
  // assigned; rewards are handed out by hand after a mod reaches out.
  milestoneThresholds: parseIdList(process.env.MILESTONE_THRESHOLDS || '10,20,40').map(Number),

  excludedTagNames: parseIdList(process.env.EXCLUDED_TAG_NAMES || 'just-sharing'),

  weeklyPostEnabled: (process.env.WEEKLY_POST_ENABLED || 'true').toLowerCase() !== 'false',

  // Logo-design competition tallying (/logovotes, /logopoll). Defaults so the commands can be
  // run bare; both are overridable per-invocation via command options. The vote-emoji default
  // is the :logocomp: custom emoji *id* — matching on id (not name) means renaming the emoji
  // in the server never breaks the tally. A name ("logocomp"), a full "<:logocomp:id>", or a
  // unicode emoji also work when passed via env or the command option.
  logoCompetitionChannelId: process.env.LOGO_COMPETITION_CHANNEL_ID || null,
  logoVoteEmoji: process.env.LOGO_VOTE_EMOJI || '1537600958245249154',

  // Byte's daily digest: a witty end-of-day recap posted to a general channel.
  // Off until DAILY_DIGEST_CHANNEL_ID is set. The persona name/avatar are used on a webhook
  // so the post appears as Byte with a floppy-disk avatar; without Manage Webhooks the
  // digest falls back to posting as the bot. Time is "HH:MM" UTC.
  dailyDigestChannelId: process.env.DAILY_DIGEST_CHANNEL_ID || null,
  dailyDigestEnabled: (process.env.DAILY_DIGEST_ENABLED || 'true').toLowerCase() !== 'false',
  dailyDigestTimeUtc: process.env.DAILY_DIGEST_TIME_UTC || '20:00',
  dailyDigestSkipQuiet:
    (process.env.DAILY_DIGEST_SKIP_QUIET || 'false').toLowerCase() === 'true',
  dailyDigestName: process.env.DAILY_DIGEST_NAME || 'Byte',
  // Explicit avatar override. When unset, the digest derives the avatar from BYTE_EMOJI's
  // CDN image, and falls back to a generic floppy image (see services/dailyDigest.js).
  dailyDigestAvatarUrl: process.env.DAILY_DIGEST_AVATAR_URL || null,

  // Byte's face: a custom server emoji (bare id, or full <:byte:id> / <a:byte:id>) or a
  // unicode emoji. Used inline wherever Byte signs something (digest header + signoff,
  // /gameidea footer) and — for a custom emoji — as the digest webhook's avatar image.
  // Default 💾 until the server has real Byte art uploaded as an emoji.
  byteEmoji: process.env.BYTE_EMOJI || null,

  // The chat-recap half of the digest (services/chatSummary.js). Off without an API key —
  // the digest then posts its template-only version. Which channels get read defaults to
  // the digest channel itself; DAILY_DIGEST_CHAT_CHANNEL_IDS widens that. The key is env
  // only (it's a secret); model and channel list are also overridable via the config doc.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  dailyDigestModel: process.env.DAILY_DIGEST_MODEL || 'claude-opus-5',
  dailyDigestChatChannelIds: parseIdList(process.env.DAILY_DIGEST_CHAT_CHANNEL_IDS),

  // /gameidea throttles. The cooldown is per user (mods bypass); the daily cap bounds the
  // server's total API spend (the no-key mad-lib fallback is uncapped — it costs nothing).
  gameIdeaModel: process.env.GAME_IDEA_MODEL || 'claude-opus-5',
  gameIdeaCooldownSeconds: intOr(process.env.GAME_IDEA_COOLDOWN_SECONDS, 300),
  gameIdeaDailyCap: intOr(process.env.GAME_IDEA_DAILY_CAP, 30),
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
