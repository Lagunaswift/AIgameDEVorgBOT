// Centralised env loading + defaults.
//
// A Firestore `config` doc (id = guildId) can override these at runtime so values
// change without a redeploy (see services/config.js for the merge). This module is
// the static, env-backed baseline that the bot boots with.

import { assertScoringPolicy } from './lib/scoringPolicy.js';

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

// Scoring settings must not use intOr: malformed values must fail startup rather than
// silently reverting to a permissive default.
function scoringInt(value, fallback) {
  return value === undefined ? fallback : Number(value);
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

  minCommentLength: scoringInt(process.env.MIN_COMMENT_LENGTH, 80),
  maxPointsPerThreadPerUser: scoringInt(process.env.MAX_POINTS_PER_THREAD_PER_USER, 2),

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

  // Forum tags excluded by raw id rather than by name. Matching on id survives the tag
  // being renamed in Discord and needs no parent-forum lookup, so it holds even when the
  // thread's parent isn't cached. Default is the server's "just sharing"-style tag that
  // must never draw a posting-guidelines nudge.
  excludedTagIds: parseIdList(process.env.EXCLUDED_TAG_IDS || '1545025922355298374'),

  weeklyPostEnabled: (process.env.WEEKLY_POST_ENABLED || 'true').toLowerCase() !== 'false',

  // Sync slash commands to the guild on boot, so deploying new commands needs no manual
  // `npm run register`. Set to "false" to go back to manual-only registration.
  autoRegisterCommands:
    (process.env.AUTO_REGISTER_COMMANDS || 'true').toLowerCase() !== 'false',

  // Logo-design competition tallying (/logovotes, /logopoll). Defaults so the commands can be
  // run bare; both are overridable per-invocation via command options. The vote-emoji default
  // is the :logocomp: custom emoji *id* — matching on id (not name) means renaming the emoji
  // in the server never breaks the tally. A name ("logocomp"), a full "<:logocomp:id>", or a
  // unicode emoji also work when passed via env or the command option.
  logoCompetitionChannelId: process.env.LOGO_COMPETITION_CHANNEL_ID || null,
  logoVoteEmoji: process.env.LOGO_VOTE_EMOJI || '1537600958245249154',

  // Jam voting (/jamvotes). The vote emoji members react with on jam entries; falls back
  // to the logo-competition emoji when unset, so the command works before a dedicated
  // jam emoji exists. Same formats accepted as LOGO_VOTE_EMOJI.
  jamVoteEmoji: process.env.JAM_VOTE_EMOJI || null,

  // The dedicated jam-submissions forum (one thread per entry). /jamvotes defaults to it,
  // and it should ALSO be listed in WATCHED_SHOWCASE_FORUM_IDS so entries get registered,
  // scored, and exported like any other game post.
  jamSubmissionsForumId: process.env.JAM_SUBMISSIONS_FORUM_ID || null,

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

  // The chat-recap half of the digest (services/chatSummary.js). Off without an API key or
  // an explicit channel list — the digest then posts its template-only version. The key is
  // env only (it's a secret); model and channel list are also overridable via the config doc.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  dailyDigestModel: process.env.DAILY_DIGEST_MODEL || 'claude-opus-5',
  dailyDigestChatChannelIds: parseIdList(process.env.DAILY_DIGEST_CHAT_CHANNEL_IDS),

  // /gameidea throttles. The cooldown is per user (mods bypass); the daily cap bounds the
  // server's total API spend (the no-key mad-lib fallback is uncapped — it costs nothing).
  gameIdeaModel: process.env.GAME_IDEA_MODEL || 'claude-opus-5',
  gameIdeaCooldownSeconds: intOr(process.env.GAME_IDEA_COOLDOWN_SECONDS, 300),
  gameIdeaDailyCap: intOr(process.env.GAME_IDEA_DAILY_CAP, 30),

  // Screenshot nudge: a one-time friendly reminder posted in new showcase threads that
  // still have no image after a short grace period, pointing the poster at the site
  // showcase. Set to "false" to disable the scheduled check entirely (the /nudgescreenshots
  // mod command still works either way). Delay is in minutes.
  screenshotNudgeEnabled:
    (process.env.SCREENSHOT_NUDGE_ENABLED || 'true').toLowerCase() !== 'false',
  screenshotNudgeDelayMinutes: intOr(process.env.SCREENSHOT_NUDGE_DELAY_MINUTES, 10),

  // Posting-guidelines nudge. Shares one delayed check (and one posted message) with the
  // screenshot nudge above: see services/postNudge.js. Threads carrying an excluded tag
  // (EXCLUDED_TAG_NAMES / EXCLUDED_TAG_IDS) never get the guidelines half.
  guidelinesNudgeEnabled:
    (process.env.GUIDELINES_NUDGE_ENABLED || 'true').toLowerCase() !== 'false',
  guidelinesNudgeDelayMinutes: intOr(process.env.GUIDELINES_NUDGE_DELAY_MINUTES, 10),
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

  // Dynamic Firestore config is validated again after it overlays this baseline.
  // Validate env here first so a malformed deployment never starts scoring at all.
  assertScoringPolicy(config, 'environment scoring policy');

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
