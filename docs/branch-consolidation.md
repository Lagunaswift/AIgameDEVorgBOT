# Branch consolidation and user guidance

Date: 14 September 2026
Status: **integration candidate; final CI, merge and deployment evidence pending**.

The owner requested updated user-facing documentation and all existing branches merged
into main. The inventory below records every branch tip observed at the start. Reconciliation
preserves those histories as merge parents while resolving obsolete implementations to the
current approved architecture. An old branch having a different commit ID after a squash
merge does not mean its feature is missing.

This is not a promise to activate every prototype. Incomplete transfer payloads do not
constitute a usable implementation. Superseded parallel runtimes, old moderator copy and
unsafe publication assumptions must not replace newer tested behaviour. No branches or
member data are deleted, no migration is rerun, and hosting flags remain off.

Genuine outstanding work integrated here: Game Wiki draft/public editing and its Bot
producer, plus the older combined nudge/exclusion intent reconciled with modern safety
and wording. Updated docs cover creator controls, site moderation, current external-link
jams, commands, feedback, posting, Wiki editing, draft/public separation and refresh delays.

## Verification and release

Before merge: Site/Bot full exact-source suites with loopback-only demo Firestore, all
browser fixtures including Wiki/real Pagefind index, inspected desktop/mobile screenshots,
Astro/production build and documentation checks. No production member records used.

Release order: Site consumer/editor first; verify Vercel and strict live anonymous probes.
Then Bot producer; verify Railway commit status and staged live export/build/promotion.
Record exact merge/run IDs below. A real member's production OAuth/save/publication and
Cloudflare/runtime acceptance remain separate unverified gates.

## Original branch resolution register


### Bot

| Original branch | Exact original tip | Resolution |
| --- | --- | --- |
| `chore/bot-security-baseline` | `9d9dc7d9cb540f22e90e87159c120ddc464ea453` | Already applied; all six baseline files equal current main. |
| `claude/daily-events-summary-humor-v7ftx6` | `b6a79df81b4ae0df630b2b32700f7ae26df6527e` | Already an ancestor of main; preserve later public-source privacy controls. |
| `claude/discord-slash-commands-channels-zz71v0` | `f78253db1a122e47741c8ee496ca36c716151484` | Guild contexts/integration registration already implemented in shared registerCommands; retain current automatic registration and refresh troubleshooting docs. |
| `claude/guidelines-image-attack-messaging-zyl36g` | `3e48ff258158f6de96d393fb74823086ee80e687` | Integrate combined prompt/exclusion intent using modern owner-reply image detection, shared dedup, late archive/owner checks and gentle copy. Do not restore deletion threats or original-post-only images. Exact excluded IDs stay optional; no new live tag assignment. |
| `claude/logo-competition-voting-pmwvgy` | `7e80d946e3673db5a8047cf1d89497bffb93e3e6` | Already an ancestor of main; current voting implementation retained. |
| `claude/weekly-leaderboard-missing-ij6ytq` | `6c9ad573db074bdceb2bfe2bca2b18e041dd04e4` | Catch-up scheduling/manual post command already incorporated. Retain current public names-only thank-you roll; do not restore a public scored/ranked post. |
| `feat/hosted-builds-jam-platform` | `4b0fb755f6f0c7df8e08697f442c2bce77b122d9` | Already released; canonical single runtime-control architecture retained, hosting remains disabled. |
| `feat/hosted-builds-jam-runtime` | `f2ae0b9ce4dfdbb425f6c873bda2f33dbf59114a` | Conflicting earlier parallel runtime/collection design superseded by released hosted-builds-jam-platform. Do not activate a second reconciler/exporter or bypass runtime acceptance. |
| `feat/platform-v2-project-destinations` | `ea792181c1b47fa3aac65db19fda39f470a7308b` | Competing early retirement proposal superseded by current canonical Project destinations. Preserve external/unlinked and event-specific URLs. Full /projecturl retirement still needs reviewed live inventory; no silent migration or new fallback. |
| `feat/project-media-v2-3` | `43c00e2ebe8b219b50b0151bddde962973793b64` | Already released; retain selected attachment safety and later exports. |
| `feat/project-publishing-v2` | `b7eefc78d86d2e29d807960194d39b33db94fcde` | Already released; preserve publishing sidecar and newer exports. |
| `feat/project-updates-v2-4` | `2ade9bb68c0db55297083c9f0f9ac0508bc06b2c` | Already released; exact current files retained. |
| `feat/project-wiki-v2-3` | `9a8855abc4519e8bc765d46fa607080969c30b79` | Integrate pending published-copy-only Wiki sidecar and current export workflow; Site consumer deploys first. |
| `review/phase3-occupancy-repair` | `81b575377c4d874a45239bea573fdf77ad5d416d` | Retain current stronger whole-plan transaction/resume guards and completed migration. Historical single-pair repair is superseded; never rerun live apply. |

## What branch ancestry does and does not prove

Acceptance requires each original tip above to be an ancestor of the corresponding final
main. Final merges must preserve parents, not squash away the consolidation ancestry.
This establishes that every history has an explicit resolution. It does not certify every
old proposal as a shipped feature; the resolution column and the roadmap remain authoritative.

## Live evidence

Pending final CI and deployment. Do not report this table as completed until the exact
release checks pass. The remaining roadmap is in FULL-ROADMAP-EXECUTION.md in the Site.
