# AIGAMEDEV Discord bot

Byte registers forum threads, tracks owner-marked helpful feedback, manages Project links, and publishes selected material to the website.

The cross-repo status records are [current state](../AIGameDevSite/docs/CURRENT-STATE.md) and [remaining work](../AIGameDevSite/docs/ROADMAP.md) in the sibling AIGameDevSite checkout. On GitHub use the [site docs](https://github.com/Lagunaswift/AIGAMEDEVSITE/tree/main/docs). Local `/mygame` and copy changes are not proof of a completed release.

## Local checks and runtime

```sh
npm ci
npm test
```

`npm test` runs deterministic tests. Migration and `/mygame` integration suites skip unless `FIRESTORE_EMULATOR_HOST` is set. The full suite passed locally against a loopback demo emulator (130 passed, 0 skipped), including moderator gates, fixed-source publication, reply images, creation races and server-side rollback. Java 21 was installed with owner approval.

The no-secret `.github/workflows/mygame-firestore-emulator.yml` runs on PRs or manual dispatch once pushed. It requires the emulator rather than accepting a skip. Branch protection and live workflow execution have not been configured or verified.

Use `.env.example` as the configuration reference; actual credentials belong in ignored `.env` or the deployment environment. Do not commit service-account JSON or tokens.

`npm start` connects to Discord and normally registers guild commands on boot. `npm run register` replaces the guild command set manually. Both are live operations; run only when requested. `AUTO_REGISTER_COMMANDS=false` disables automatic registration. Railway must keep the bot running for live reactions; missed reactions need `/rescan` recovery.

## Commands

| Command | Access / purpose |
| --- | --- |
| `/help` | Private member command reference |
| `/mystats [user]` | Private feedback totals and rank; another member lookup is moderator-only |
| `/leaderboard [scope]` | Private reply listing scores for week or all time |
| `/needsreviews` | Find Showcase threads with few comments |
| `/posttemplate type:<choice>` | Private copyable build-help, playtest or update template |
| `/gameidea [theme]` | Byte game pitch, with cooldown and AI-call cap |
| `/mygame publish [status]` | Owner of an approved registered game thread; create/reuse its one Project. Explicit status required for creation. |
| `/assignjam jam_id:<ID>` | Moderator; associate current registered thread with a jam |
| `/posthelp` | Moderator; post/pin command reference |
| `/rescan` | Moderator; recover thread registration and currently observable helpful reactions |
| `/points adjust`, `/points reset` | Moderator; audited score administration |
| `/registerforum` | Moderator; configure a watched showcase/competition forum |
| `/seedusers` | Moderator; seed first-poster records |
| `/postleaderboard [week]` | Moderator; post the weekly thank-you roll |
| `/dailydigest [action] [window]` | Moderator; preview/post latest or live digest |
| `/logovotes`, `/logopoll` | Moderator; shortlist by reaction and create native Discord poll |
| `/jamvotes` | Moderator; tally jam entries; placement tags remain manual |
| `/nudgescreenshots`, `/nudgequestions` | Moderator; preview/apply reminders |
| `/communitynote nominate` | Moderator; private manual-consent checklist, no content collection |

Command definitions in `src/commands/` are the exact option/permission source. Most moderator handlers use Manage Server or configured `MOD_ROLE_ID`; Discord command visibility/default permissions may be narrower. Verify integration permissions before release.

## Feedback and recurring jobs

Only the thread owner's helpful reaction awards a point. Self-comments, bots, short comments, duplicate reactions and the per-thread/commenter cap are checked. Removing the owner's reaction revokes the point. Defaults are 80 characters and 2 points per commenter/thread; validated configuration may override them.

`points` is canonical. `pointCounters` enforces caps atomically; `adjustments` records manual changes. Recovery points count all-time without inventing historical weekly timestamps. These controls limit farming; they do not prevent collusion between people.

The weekly public post thanks contributors without scores. Private command replies still contain standings. Milestone notifications and optional configured reward roles are separate mechanisms.

The daily digest uses stored events and optional Anthropic recap. An empty `DAILY_DIGEST_CHAT_CHANNEL_IDS` falls back to the digest channel. Do not treat it as an off switch. Sources must pass refreshed @everyone view/history permission checks in the configured guild and be non-NSFW text/announcement channels. Failed checks discard that source; moderators still choose which public channels are approved. Without an API key the bot uses template recap content. Game ideas have a separate daily API cap and no-key fallback.

## Projects and publication

One game has one Discord thread, with updates inside it. Moderator-only Publish to site approves Showcase and eligibility for `/mygame` Project creation. The command and exporter check live approval. Removing the tag withholds both public records; retagging restores eligibility without overriding owner unpublish. The member linking picker is removed, including safe rejection of stale link interactions.

`projects` stores permanent game identity; `threads` links each discussion to at most one Project. Both ownership checks must pass. New creation uses a Project/slug-reservation/backlink transaction. `projectSlugs` protects newly reserved URLs; existing Project slugs are also checked.

- Project export requires literal `publishToSite: true`.
- Project timeline activity also requires `publishOnProject: true` and a valid purpose. Linking does not turn it on.
- Hero/gallery source selection is separate from timeline visibility. Sources must be linked same-owner public Discord threads with owner-authored images.
- Project and Showcase export both require the live moderated approval tag. Missing approval produces explicit withholding evidence, not data deletion. Operational errors and conflicting source associations abort the candidate export.
- `/projecturl` is retired. Use `/mygame manage` in the existing game thread to edit Project links. Existing unlinked thread URLs are retained read-only; linked/public Projects supply their own destinations. No legacy records are deleted or automatically migrated.

Direct website uploads, video ingestion, hosted per-game Wiki articles, structured builds and per-game roadmaps are not implemented by this bot pipeline.

### Screenshot replies

The nudge asks the owner to attach a screenshot or GIF to a new reply in the existing thread. It does not require editing the first post. Existing starter images keep priority; otherwise Showcase and Project image export use the same owner-reply search as the nudge. Link previews, other members' reply attachments and bot replies are ignored.

`src/lib/threadImages.js` scans up to five pages of 100 early replies, then the most recent 100 if needed. An unreadable response or an unsearched gap with no match fails the check: no false missing-image nudge, and no candidate export replacing a known image with a placeholder. The existing workflow keeps the last successful snapshot. A fresh owner attachment reply is picked up from the recent page. This is bounded automatic fallback, not the future explicit gallery-image selector.

## Site export

`.github/workflows/export-site.yml` runs at minute 17 every six hours, or through an approved manual dispatch. It exports to a staging site clone, validates snapshots, builds the site, then promotes generated data/assets and pushes a site data commit. Scheduling/build failures can delay changes beyond six hours.

The contracts are Projects v1, Showcase v2 and Jams v2. Project asset cleanup is restricted to `public/assets/projects/<slug>/_discord-export/`; manually curated sibling assets stay. Source: `scripts/export-site-data.mjs`, `site-export-contract.mjs`, `site-export-safety.mjs`, and `validate-site-export.mjs`.

`npm run export:site` and workflow dispatch can read live data and write output; they are not local validation substitutes. Do not run them, push or deploy without approval.

## Configuration and permissions

`.env.example` and `src/config.js` cover Discord/Firebase credentials, watched forums, scoring bounds, moderator feeds, milestone/reward settings, automatic registration, polls/jam votes, digest channel/time/model, game-idea budgets and nudge settings. `src/services/config.js` defines supported Firestore overrides. Secret values remain environment-only.

Discord needs Guilds, GuildMessages, GuildMessageReactions and MessageContent intents, plus Message/Channel/Reaction partials. Enable Message Content in the Developer Portal. Invite scopes are `bot` and `applications.commands`. Grant the required channel read/write/reaction permissions; pinning, polls, webhooks and role rewards need their relevant permissions. Role rewards also require the bot role above the reward role.

If commands disappear, check integration/channel permissions and application-command scope before re-registering. If scheduled posts fail, check channel permissions and logs; their Firestore markers prevent normal duplicate sends. Bot Admin access bypasses client Firestore rules, so rules must be reviewed separately.

## Source map and history

Runtime: `src/index.js`, `src/loadCommands.js`, `src/events/`. Features: `src/services/`. Validation and templates: `src/lib/`. Operator/export tools: `scripts/`. Tests: `test/`. Workflows: `.github/workflows/`.

The nine-record Phase 3 production migration was previously reported complete. Do not rerun it as release setup. Its evidence and operational cautions remain in the sibling [deployment notes](../AIGameDevSite/docs/DEPLOYMENT-HANDOFF.md). The retired migration procedure and legacy manual were deleted at the owner's request; application and migration scripts remain unchanged.
