# AIGAMEDEV Discord bot

Byte connects one game thread to one Project, checks moderator site approval, exports
selected creator content and recognises useful feedback. Discussion and voting stay in Discord.

Member instructions: https://www.aigamedevs.org/wiki/managing-your-game/
Command guide: https://www.aigamedevs.org/wiki/bot-commands/
Jam guide: https://www.aigamedevs.org/wiki/jam-handbook/

For maintainers, the Site repository contains the current role guides, architecture and
`docs/releases/FULL-ROADMAP-EXECUTION.md`. This repository's
[branch consolidation record](docs/branch-consolidation.md) identifies integrated heads and
remaining live acceptance. Code, CI, merge and deployment are separate facts.

## Member commands

| Command | Behaviour |
| --- | --- |
| `/help` | Private reference |
| `/mygame publish [status]` | Owner requests a Project from the exact moderator-approved registered thread; status required for creation |
| `/mygame manage` | Owner opens website tools for the existing Project |
| `/projecturl url:<URL>` | Legacy external playable link on an owned thread; does not update an existing Project URL or publish anything |
| `/mystats [user]` | Private totals/rank; another-member lookup is moderator-only |
| `/leaderboard [scope]` | Private response containing feedback scores; no public score table |
| `/needsreviews` | Few-comment Showcase threads, excluding configured sharing-only tags |
| `/posttemplate` | Copyable help/playtest/update text, not an automatic post |
| `/gameidea [theme]` | Theme-first idea generation when supplied; otherwise random collision, subject to configured cooldown/call limits |

One thread per game. `/mygame link` is retired. Website editors cover Project details,
external releases/roadmap, private launch checks, selected gallery images, selected own
Discord messages and Game Wiki draft/public copies. Public content needs both moderator
approval and the applicable explicit owner choices. Save does not equal publication.

## Moderator tools

`/assignjam`, `/jamvotes`, `/posthelp`, `/rescan`, `/points`, `/registerforum`, `/seedusers`,
`/postleaderboard`, `/dailydigest`, `/logovotes`, `/logopoll`, `/nudgescreenshots`,
`/nudgequestions` and `/communitynote nominate` retain their respective moderator scopes.
Use preview before any batch operation. Do not post help, send nudges, change channels/tags,
reset points or re-run migrations as release tests.

Jam tallies use tagged entry starter messages and announced voter scope, with self-votes
excluded by default. Organisers still review qualification/ties and apply placement tags.
A jam tag is not site approval. `/assignjam` is a thread/event association, not publication.

## Hosting remains disabled

Browser ZIP uploads, runtime previews/public play and automatic jam build locks are not
available. `/jam` and `/build` hosting workflows are feature-gated. Keep them off until
provider, engine, moderation and runtime security acceptance passes. Do not activate a
second runtime implementation from a historical branch. External game links remain supported.

## Reminders and feedback

The scheduled question/image checks can send one combined message, not two back-to-back.
Each half keeps its own dedup record and failed sends release newly acquired claims.
Missing images still use the modern bounded owner-reply search; the request asks for a
fresh reply attachment, not a first-post edit. No automatic post deletion is implemented.

`EXCLUDED_TAG_NAMES` (default `just-sharing`) and optional `EXCLUDED_TAG_IDS` apply to question
reminders and review discovery. Exact IDs survive renaming; names need forum tag metadata.
The consolidation does not create/apply a tag or impose a new hard-coded production ID.
Both prompt features retain their own enable flags; the shorter enabled delay is used.

Points require the owner's helpful reaction and configured comment/cap rules. Public weekly
thank-you posts show names without scores. Private statistics and score administration
remain. Scheduled digest/recap and milestone notices retain their configured policies;
refer to the Site privacy notice and operational configuration.

## Export and content safety

The Site editor stores bounded preferences. The Bot reads them only after verifying the
current approved owner-published Project and fixed source. Gallery selection verifies
owned attachments. Selected updates fetch only explicitly public-selected own messages,
not drafts, forwards, embeds or other members' replies. Wiki export contains only the
published article copy, never later private draft edits. External Wiki links remain.

`.github/workflows/export-site.yml` runs at minute 17 every six hours and on relevant
producer changes. It stages data/assets, validates, builds, then promotes and pushes.
Failed validation keeps the previous snapshot. Publication/withdrawal is not instant;
urgent removal needs operator attention. No private draft, checklist or service credential
belongs in generated public data or logs.

## Development and verification

```sh
npm ci
npm test
```

The CI workflow `mygame-firestore-emulator.yml` runs the full suite against a loopback-only
demo Firestore project using Java. Integration tests must not silently skip for acceptance.
Local emulator-only skips are reported separately. No live credentials are required for
unit or fixture tests. The current Node engine range is in package.json; use the lockfile.

Live export scripts and migration tools are operational actions, not substitutes for unit
tests. The original production migration is complete; do not repeat it as setup. Existing
association and slug corrections require reviewed exact evidence, never fuzzy matching.

## Permissions and missing commands

Keep tokens/service-account keys in deployment secret storage, not source files or chat.
Use the Discord application that owns the Bot and correct guild. Invite scopes include
`bot` and `applications.commands`; enable Message Content intent. Grant only permissions
needed for configured features and the relevant channels. Role rewards need correct role order.

Registration supports guild contexts through the shared registerCommands module. Startup
sync is controlled by configuration. If commands disappear, check the application/guild,
channel integration permissions, invite scope and registration logs before resyncing.
A successful repository deployment is not proof of a real member command interaction.

Firebase Admin bypasses client rules. Client-rule denial, backups, restore tests, retention,
billing and runtime monitoring require separate operational evidence.

Runtime: `src/index.js`, `src/loadCommands.js`, `src/events/`. Services: `src/services/`.
Contracts/helpers: `src/lib/`. Export/operator tools: `scripts/`. Regression tests: `test/`.
