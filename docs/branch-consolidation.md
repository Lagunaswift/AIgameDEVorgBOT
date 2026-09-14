# Branch consolidation and user guidance

Date: 14 September 2026
Status: **merged; full CI, Railway deployment and live staged export passed**.

The owner requested updated user-facing documentation and all existing branches merged
into main. All 14 original Bot tips below are now ancestors of main through a normal
consolidation merge. The Site likewise incorporated its 14 original tips. Branch refs
were retained, and both repositories had zero open pull requests at the final check.

Histories have explicit resolutions, not blanket activation of obsolete prototypes.
Incomplete encoded transfers, parallel runtimes and superseded migration/publication
assumptions do not replace newer safe code. No production migration was rerun, member
records were not created for tests, and hosted-game flags remain off.

## Delivered and verified

Current README, private help and owner/welcome guidance now match the Site's creator and
moderator guides. Game Wiki export contains only explicit published copies from approved
owner-published Projects. Existing gallery/update/publishing behaviour remains intact.

The combined question/image reminder uses current owner-reply image checks, existing
per-half dedup records, late owner/archive checks and gentle copy. The /posthelp handler
now has a server-side moderator check. No announcement, channel/tag change or batch nudge
was run as a deployment test.

A final audit found that tag exclusions were documented and read by callers but not loaded
by the environment/runtime configuration. Both paths now forward excludedTagNames and
excludedTagIds; tests cover defaults, overrides, empty lists and malformed inputs. No live
tag ID or configuration document was changed. Optional ID exclusions do not need cached
forum names; name-based exclusions use available forum metadata.

## Original branch resolution register

### Bot

| Original branch | Exact original tip | Resolution |
| --- | --- | --- |
| `chore/bot-security-baseline` | `9d9dc7d9cb540f22e90e87159c120ddc464ea453` | Already applied; current security baseline retained. |
| `claude/daily-events-summary-humor-v7ftx6` | `b6a79df81b4ae0df630b2b32700f7ae26df6527e` | Already an ancestor; later public-source privacy controls retained. |
| `claude/discord-slash-commands-channels-zz71v0` | `f78253db1a122e47741c8ee496ca36c716151484` | Guild contexts/integration registration already implemented in shared registerCommands. Current startup registration and troubleshooting guidance retained. |
| `claude/guidelines-image-attack-messaging-zyl36g` | `3e48ff258158f6de96d393fb74823086ee80e687` | Combined prompt/exclusion intent integrated with current owner-reply images, dedup records, late owner/archive checks and gentle copy. No deletion threat or first-post-only restriction. Environment/runtime exclusions now wired and tested. |
| `claude/logo-competition-voting-pmwvgy` | `7e80d946e3673db5a8047cf1d89497bffb93e3e6` | Already an ancestor; current voting implementation retained. |
| `claude/weekly-leaderboard-missing-ij6ytq` | `6c9ad573db074bdceb2bfe2bca2b18e041dd04e4` | Catch-up scheduling/manual post command already incorporated. Current public names-only thank-you roll retained, not old public scored/ranked output. |
| `feat/hosted-builds-jam-platform` | `4b0fb755f6f0c7df8e08697f442c2bce77b122d9` | Already released; canonical single runtime-control architecture retained; hosting disabled. |
| `feat/hosted-builds-jam-runtime` | `f2ae0b9ce4dfdbb425f6c873bda2f33dbf59114a` | Conflicting parallel runtime/collection design superseded by released foundation. No second reconciler/exporter activated or runtime acceptance bypassed. |
| `feat/platform-v2-project-destinations` | `ea792181c1b47fa3aac65db19fda39f470a7308b` | Competing early retirement proposal superseded by current canonical destinations. External/unlinked and event-specific URLs preserved. Full /projecturl retirement still needs reviewed live inventory. |
| `feat/project-media-v2-3` | `43c00e2ebe8b219b50b0151bddde962973793b64` | Already released; selected-attachment safety and later exports retained. |
| `feat/project-publishing-v2` | `b7eefc78d86d2e29d807960194d39b33db94fcde` | Already released; publishing sidecar and newer exports retained. |
| `feat/project-updates-v2-4` | `2ade9bb68c0db55297083c9f0f9ac0508bc06b2c` | Already released; current selected-update files retained. |
| `feat/project-wiki-v2-3` | `9a8855abc4519e8bc765d46fa607080969c30b79` | Published-copy-only Wiki sidecar and current staged export integrated; deployed after Site consumer. |
| `review/phase3-occupancy-repair` | `81b575377c4d874a45239bea573fdf77ad5d416d` | Current stronger whole-plan transaction/resume guards retained. Historical single-pair repair superseded; completed production migration not rerun. |

## Branch ancestry proof

The final full CI gate verified that all 14 tips are ancestors of the candidate. GitHub's
candidate-to-merge comparison then confirmed zero commits behind and an identical tree.
Fresh branch listings matched the original tips and retained the consolidation branch.
The normal merge preserves those relationships; no squash or history rewrite was used.
This proves each recorded history is resolved, not that every old proposal is a live feature.

## Release evidence

| Gate | Evidence | Result |
| --- | --- | --- |
| Final Bot candidate | `3eee9cb3c1ac322105d3e47b43f57626b229def0` | Includes configuration wiring repair |
| Full Bot CI | `34851992349` | Clean install, all-tip ancestry and real demo-Firestore suite passed |
| Site deployed first | Site #14 merge `2965195a7dc5945216137708cbc461e535e0d2c0`, production `34852200679` | Build, Vercel deployment and live guards passed before Bot merge |
| Bot normal merge | PR #11, `0ac567f00c8e9d00a7bacbcb16cd020f609cd663` | Railway reported successful deployment of this exact commit |
| Live staged export | `34852522691` | Source export, validation, staged Site build, promotion and push passed |
| Refreshed Site | `2e1be76c61a0bc00dbe902211617709df70acaa7`, production `34852731575` | Resulting production deployment and live checks passed |

Review was assistant source/test verification, not a claimed independent specialist review.
Live export of existing data and anonymous Site checks do not prove a real member completed
production OAuth/edit/save/publication. Real member and moderator end-to-end acceptance,
client rules/TTL, backups, account-wide deletion and Cloudflare runtime acceptance remain
separate gates. No real member content was fabricated for testing and no old migration
was rerun.

The Site maintains the cross-repository release register in
`docs/releases/BRANCH-CONSOLIDATION.md` and remaining work in
`docs/releases/FULL-ROADMAP-EXECUTION.md`. Next independent package: explicit Project/tool/
guide connections. Hosted-game ZIP uploads and public runtime remain disabled.
