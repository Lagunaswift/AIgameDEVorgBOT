# Showcase Feedback Bot

A Discord bot for the **AI Game Dev Org** server. It watches forum channels,
auto-registers every thread, and runs an **unfarmable feedback-scoring system**:
the person who posted a game awards points to people who left genuinely helpful
feedback. A second **competition mode** registers contest entries (e.g. the logo
competition) for display and counting.

Built on the EarlyAdoptersScout stack (discord.js v14 + firebase-admin + Railway),
so connection, deploy and secrets handling carry over. This is a scoring service on
that skeleton, not a new architecture.

---

## Core concept

Two modes share one foundation.

- **Foundation** (both modes): the bot watches one or more forum channels. Every new
  forum thread is registered in Firestore with its owner and mode. The bot also listens
  to reactions across those threads. This registration + reaction-listener layer is
  identical for both modes.
- **Showcase mode**: the thread owner reacts with the helpful emoji (`✅` by default) on
  a comment **in their own thread**, awarding one point to the comment's author. The
  receiver decides what counted — which is what makes it unfarmable.
- **Competition mode**: entries are threads in a contest forum. The bot registers them
  and can read reactions for display, **but the actual winner is decided by a native
  Discord Poll, not by reaction tally** (reaction counts are trivially gamed with alts).

---

## How scoring works (showcase)

A point is awarded only if **all** of these pass, checked in this order
(`src/services/scoring.js`):

1. The reactor **is the thread owner** — only the receiver of feedback validates it.
2. The comment author is **not** the thread owner (no self-scoring).
3. The comment author is **not** a bot.
4. The comment text length is **≥ `minCommentLength`** (default 80 — kills one-liners).
5. The commenter is **under `maxPointsPerThreadPerUser`** for this thread (default 2).
6. The comment hasn't already been scored (deterministic point id prevents double-scoring).

If the owner removes their reaction, the point is **revoked**
(`src/events/messageReactionRemove.js`), so misclicks are reversible.

### Anti-farm summary

- Helpful mark must come from the thread owner, not anyone.
- Minimum comment length floor.
- No scoring your own comments.
- Cap on points per commenter per thread.
- Deterministic point doc id (`${threadId}_${commentMessageId}`) prevents double-scoring.
- Reaction-remove revokes the point.

AI quality-grading of comments is **out of scope for v1** — the human tick is the quality
check. Only add it if the tick gets gamed, and it would need a per-user token budget and
input sanitisation (members on an AI server will try to prompt-inject it).

---

## Data model (Firestore)

Event-sourced for points, so there is **no weekly reset job**. The weekly leaderboard is
just a query filtered by ISO week. Nothing is ever wiped.

**`threads`** (doc id = `threadId`)

```
threadId, forumId, ownerId, ownerTag, title,
mode: "showcase" | "competition", createdAt, registeredAt
```

**`points`** (doc id = `${threadId}_${commentMessageId}`)

```
threadId, commentMessageId, commenterId, commenterTag,
threadOwnerId, isoWeek (e.g. "2026-W26"), awardedAt
```

One point per document. Total score = count of docs where `commenterId = user`.
Weekly score = same, filtered by `isoWeek = current week`.

**`config`** (doc id = `guildId`, optional) — overrides env values without a redeploy:

```
watchedShowcaseForumIds[], watchedCompetitionForumIds[], helpfulEmoji,
minCommentLength, maxPointsPerThreadPerUser, leaderboardChannelId,
rewardThresholds: [{ points, roleId }]
```

**`adjustments`** — audit records for manual `/points adjust` overrides.

**`weeklyPosts`** (doc id = ISO week string, e.g. `2026-W26`) — a marker written after the
weekly leaderboard for that week is successfully sent. Makes the post idempotent: a restart
across the Monday boundary, a redeploy, or a since-fixed permission error is recovered by a
boot catch-up that re-posts any week never actually delivered, and never double-posts one
that was.

**`dailyPosts`** (doc id = UTC date string, e.g. `2026-08-19`) — the same marker pattern
for Floppy's daily digest: written after a day's digest is delivered (or deliberately
skipped as quiet), checked by the daily cron and the boot catch-up.

---

## Slash commands

| Command | Who | What |
| --- | --- | --- |
| `/leaderboard [scope]` | everyone | Top 10 by points. `scope` = `week` (default) or `all`. |
| `/mystats` | everyone | Your total points, weekly points, and weekly rank. |
| `/needsreviews` | everyone | Showcase threads with the fewest comments — where reviewers should go. |
| `/rescan` | mod | Backfill registration + points from watched forums (downtime recovery). |
| `/points adjust <user> <amount> <reason>` | mod | Manual point override; writes an audit doc. |
| `/registerforum <channel> <mode>` | mod | Add a forum to the watched list with a mode. |
| `/postleaderboard [week]` | mod | Post the weekly leaderboard to the leaderboard channel now. `week` = `previous` (default, matches the automated post) or `current`. Useful for verifying channel permissions and recovering a missed week. |
| `/logovotes [channel] [emoji] [voters] [top]` | mod | Tally a logo (or any) competition by reaction and show the ranked entries. Defaults: the configured channel, the `:logocomp:` emoji (matched by id), and votes from everyone **except each entry's own owner**. See the logo-competition section for the alt-gaming caveat. |
| `/logopoll [channel] [post_to] [finalists] [hours] [question] [emoji] [voters]` | mod | Shortlist the top entries by reaction, then post a **native Discord poll** (single-select, one vote per account) of the finalists to decide the winner. Poll caps at 10 options; ties squeezed out are reported. |
| `/dailydigest [action] [window]` | mod | Preview (ephemeral, default) or post Floppy's daily digest now. `window` = `latest` (the completed day, re-postable to recover a failed scheduled post) or `live` (everything since the last digest, as a bonus post). |

Mod-only commands are gated by **Manage Server** or the configured `MOD_ROLE_ID`, checked
in the handler.

---

## Discord setup (must be correct or reactions silently fail)

**Gateway intents** (all required):

- Guilds
- GuildMessages
- GuildMessageReactions
- **MessageContent** (privileged — enable in the Developer Portal; needed to read comment
  length for the anti-farm floor)

**Partials** (required): `Message`, `Channel`, `Reaction`. Without these, reactions on
messages the bot hasn't cached (anything posted before the bot started, or after a
restart) arrive incomplete and score nothing. Every reaction handler resolves partials in
a try/catch before doing anything.

**OAuth scopes**: `bot` and `applications.commands`.

**Bot permissions**: View Channels, Read Message History, Send Messages, Send Messages in
Threads, Add Reactions, and — if reward roles are enabled — **Manage Roles** with the
bot's role dragged **above** any role it hands out. For the daily digest's floppy-disk
persona, **Manage Webhooks** on the digest channel (optional — without it the digest posts
as the bot).

**Leaderboard channel**: the bot must have **View Channel**, **Send Messages**, and **Use
External Emojis** (the post uses custom emojis) on the channel set by `LEADERBOARD_CHANNEL_ID`.
A channel-level permission override beats a server-wide role grant, so check the channel's own
permissions (and its category, if synced). Missing any of these makes the weekly post fail
with a `Missing Permissions` error; run `/postleaderboard` after fixing it to re-post the week.

---

## Configuration / env

```
DISCORD_TOKEN=
CLIENT_ID=
GUILD_ID=
FIREBASE_SERVICE_ACCOUNT=     # JSON string of the service account key
WATCHED_SHOWCASE_FORUM_IDS=   # comma-separated
WATCHED_COMPETITION_FORUM_IDS=
HELPFUL_EMOJI=✅
MIN_COMMENT_LENGTH=80
MAX_POINTS_PER_THREAD_PER_USER=2
LEADERBOARD_CHANNEL_ID=
MOD_ROLE_ID=                  # optional
WEEKLY_POST_ENABLED=true      # optional
LOGO_COMPETITION_CHANNEL_ID=  # optional — default channel for /logovotes
LOGO_VOTE_EMOJI=1537600958245249154  # optional — :logocomp: custom emoji id (matched by id)
DAILY_DIGEST_CHANNEL_ID=      # optional — enables Floppy's daily digest (point at #general)
DAILY_DIGEST_ENABLED=true     # optional
DAILY_DIGEST_TIME_UTC=20:00   # optional — daily posting time, HH:MM UTC
DAILY_DIGEST_SKIP_QUIET=false # optional — true = stay silent on zero-activity days
DAILY_DIGEST_NAME=Floppy      # optional — webhook persona name
DAILY_DIGEST_AVATAR_URL=      # optional — webhook persona avatar (defaults to a 💾 image)
```

The helpful emoji is read from config, so swapping `✅` for a custom server emoji later is
a one-value change with no logic edit. **For a custom emoji, the value is the emoji id** —
matching is done on `reaction.emoji.id` rather than name, so renaming the emoji doesn't
break scoring.

A Firestore `config` doc (id = `guildId`) overrides any of these at runtime.

---

## Running

```bash
npm install
cp .env.example .env        # fill in your values
npm run register            # register slash commands to the guild (run when commands change)
npm start                   # start the bot
```

Slash commands are registered to the guild (near-instant), not globally.

### Deploy (Railway)

Matches the EarlyAdoptersScout setup. Set the env vars above in the Railway service (paste
the whole service account JSON as `FIREBASE_SERVICE_ACCOUNT`). The bot must be
**always-on** — see reliability notes.

---

## Competition mode & the logo competition

For the logo competition test, competition mode only proves the foundation: it registers
entry threads and confirms reactions are being read (logged, not scored).

> **Do not pick the winner by reaction tally.** Reaction counts are trivially gamed with
> alt accounts. The real vote is a **native Discord Poll** posted in a voting channel once
> entries close — one vote per person, enforced by Discord.

If a reaction tally is wanted anyway (for display), **`/logovotes`** does exactly that:
it counts the vote emoji (the `:logocomp:` custom emoji by default, matched by id) across the competition channel and ranks
the entries. It reads two layouts automatically —

- **Forum / Media channel**: each post is a thread and one entry; the vote reaction sits on
  the thread's starter message and the entry owner is the thread owner.
- **Text / Announcement channel**: each message carrying the vote emoji is an entry, owned
  by its author (older messages beyond a 1000-message scan are reported as skipped).

By default it counts votes from everyone **except each entry's own owner** (no self-votes).
The `voters` option switches this to *only non-contestants* (exclude everyone who submitted
an entry) or *everyone*. The reply is ephemeral, ranks ties as ties, and notes how many
owner self-votes were dropped. This is still **gameable with alt accounts** — treat it as a
quick read of who's ahead, and shortlist finalists with it, not as the final word.

### The poll: `/logopoll`

To decide the winner cleanly, **`/logopoll`** shortlists the top entries by that same
reaction tally and posts a **native Discord poll** of the finalists — single-select, so each
account gets **one** vote (Discord-enforced), with a set closing time (`hours`, 1–768).

A poll caps at **10 options** and can't contain the images, so the command posts a numbered
legend (`1️⃣ <#entry> — by @maker`) linking each option to its post, and the matching poll
below it. Flow:

1. Entries collected as posts.
2. Reactions accumulate; `/logovotes` shows the running tally.
3. `/logopoll` posts the finalist poll (top `finalists`, default 10) to `post_to` (defaults
   to the current channel). Ties squeezed out by the 10-option cap are reported back.

Honest caveat: a poll is **one-vote-per-account and single-select**, which stops one person
boosting every entry — but an alt account can still vote, so it is *cleaner and enforced*,
not truly alt-proof. Only gating who can vote (e.g. a required role) fully stops alts. Note
Discord only lets the **poll's author** (the bot) end a bot-made poll early; otherwise it
closes itself at the deadline.

### First live test

Run build phases 1–3 against the logo competition forum to prove the foundation (does it
catch every entry thread, does it read reactions reliably) before showcase scoring goes
live. Decide the logo winner with a Poll, then finish phases 4+ for showcase mode.

---

## Floppy's daily digest (optional)

A short end-of-day summary of server activity, posted to a general channel in the voice of
**Floppy** — a sentient 3.5" disk with a dry sense of humour and its own floppy-disk avatar.
Off until `DAILY_DIGEST_CHANNEL_ID` is set.

A digest covers the 24 hours ending at `DAILY_DIGEST_TIME_UTC` (default 20:00 UTC), so
consecutive digests tile exactly — nothing falls between two windows or shows up twice.
(The cron is read at boot, so changing the time via the config doc takes effect on the
next restart.) It
reports what the bot already records, so there is no new tracking: new showcase builds
(linked), competition entries, feedback points awarded plus the day's top helper, milestone
crossings, and first-time posters. On a day with nothing to report Floppy posts a deadpan
one-liner instead ("Nothing happened today. I checked both sides.") — set
`DAILY_DIGEST_SKIP_QUIET=true` for silence instead.

How the pieces work:

- **The avatar is a webhook.** A webhook message carries its own username and avatar, so
  the digest appears as "Floppy" 💾 without touching the bot's identity. This needs
  **Manage Webhooks** on the digest channel; without it the digest still posts, just as
  the bot. Name and avatar are configurable (`DAILY_DIGEST_NAME`, `DAILY_DIGEST_AVATAR_URL`).
- **The wit is curated, not generated.** Lines live in `src/lib/floppy.js` and rotate on a
  seed derived from the date, so re-renders of the same day are identical (a retried post
  can't come out reworded) and no AI call sits in the loop. The digest body contains **no
  user-authored text** — threads and users appear as `<#id>`/`<@id>` mentions that Discord
  renders itself — so on a server full of people who *will* try to prompt-inject a bot,
  there is nothing to inject into. Mentions are sent no-ping.
- **Idempotent like the weekly post.** A `dailyPosts` marker per day plus a boot catch-up
  recovers a digest missed to a restart or a since-fixed permission error, and never
  double-posts. `/dailydigest` previews the exact message ephemerally or posts on demand.

---

## Reward roles (optional)

When a user's total crosses a threshold in `config.rewardThresholds`, the bot assigns the
matching role (`src/services/rewards.js`). Requires **Manage Roles** and the bot's role
above the reward roles. Re-checked on each point award. Off by default
(`rewardThresholds` empty).

---

## Reliability notes

- **Always-on is a hard requirement.** Reactions added while the bot is down are lost and
  **not replayed by Discord**. `/rescan` is the only backfill path, so keep the Railway
  service from sleeping.
- All partial fetches are wrapped in try/catch and bail safely rather than throwing.
- discord.js auto-reconnects; handlers are registered **once at startup**, not per
  connection.
- firebase-admin runs server-side with full access, so **Firestore security rules should
  deny all client access**. No secrets or tokens are logged.

---

## Project structure

```
src/
  index.js                  client + intents + partials, login, handler binding
  config.js                 env loading + defaults
  firebase.js               firebase-admin init from service account
  loadCommands.js           command registry loader
  register-commands.js      registers slash commands to the guild
  lib/
    week.js                 ISO week helper (single source for week strings)
    emoji.js                helpful-emoji matching (unicode vs custom id)
    partials.js             reaction/message partial resolution
    permissions.js          mod gating
    floppy.js               daily-digest persona: line pools + seeded picker
  events/
    ready.js
    threadCreate.js         foundation: register threads
    messageReactionAdd.js   foundation + route to scoring
    messageReactionRemove.js  revoke on un-tick
    interactionCreate.js    command router
  services/
    config.js               env + Firestore config merge, forum lookup
    threads.js              register / lookup threads
    scoring.js              showcase award rules (in order) + revoke + adjust
    leaderboard.js          aggregation queries
    rescan.js               downtime backfill
    weeklyPost.js           scheduled weekly leaderboard post
    rewards.js              optional role thresholds
    logoVotes.js            live reaction tally + finalist poll builder (/logovotes, /logopoll)
    dailyDigest.js          Floppy's daily digest: gather, render, webhook post, schedule
  commands/
    leaderboard.js  mystats.js  needsreviews.js  rescan.js  admin.js
    postleaderboard.js  logovotes.js  logopoll.js  dailydigest.js
```

---

## Out of scope for v1

- AI/Claude grading of feedback quality (revisit only if the tick gets gamed).
- A `/submit` modal command (native forum posting is the v1 path).
- Any Reddit integration. This is Discord-only.
