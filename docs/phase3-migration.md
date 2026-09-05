# Phase 3 migration runbook — existing public data → Project records

`scripts/migrate-projects.mjs` is an **operator-run administrative script**. It is never
invoked by bot startup, scheduled exports, or slash commands, and it defaults to a
read-only dry run. Production writes require the reviewed plan file plus an explicit
target confirmation on the command line.

What it does, per the architecture plan (§29–31, §62): for every showcase thread that is
**currently published** (Firestore `mode == "showcase"` **and** live Discord
channel/source-forum checks **and** the Publish-to-site tag — the same boundary the site
exporter uses), it creates exactly ONE Project, copies only deterministic metadata,
sets `profileThreadId` to the original thread, and writes the `thread.projectId`
backlink — Project creation and backlink in one Firestore transaction.

## Safety properties

- **Dry run is read-only.** Discord REST reads + Firestore reads only.
- **Idempotent.** A consistent existing Project↔thread relationship is a no-op on
  rerun; the migration never republishes, overwrites, or "repairs" existing records.
  A create planned against a null backlink is refused if the thread gained ANY Project
  link after planning — changed state is never silently accepted.
- **Fail closed.** Any blocked record (missing/inferred-impossible metadata, e.g.
  `status` which has no structured source yet) or conflict (dangling links, owner
  mismatches, malformed or duplicate-claim existing Projects, occupied slugs/ids)
  refuses the entire apply. The full Phase 2 Project contract is validated in
  preflight, not just inside the transaction.
- **Plan stability.** Apply replays the reviewed plan's Project ids during its fresh
  preflight, so unchanged live state compares equal instead of false-drifting on
  regenerated ids. The approval is also bound to the reviewed plan's Firebase target
  and `SITE_PUBLISH_TAG_ID` — a plan reviewed against a different environment or tag
  is not this approval.
- **Nothing private becomes public.** Threads without the Publish-to-site tag (or in a
  different guild) are excluded without their content ever being read. A
  consent-tagged thread whose starter message cannot be read is a completeness
  blocker, never a silent skip.
- **Scoring identity untouched.** The only thread write is `projectId`.

## Operational preconditions (enforced by the operator, not the code)

- **No concurrent Project writers during apply.** Each transaction guards exactly its
  (thread, planned Project) pair; it cannot detect a competing slug or profile-thread
  claim introduced between preflight and commit. While `--apply` runs, nothing else
  may create or edit Project records.
- Live consent is rechecked immediately before each transaction (full boundary:
  channel exists, parent forum unchanged, publish tag applied, guild matches), but
  Firestore transactions cannot be atomic with Discord state.

## Steps

### 1. Dry run (preflight)

```bash
npm run migrate:projects -- --baseline ../AIGameDevSite/src/data/showcase.json
```

- Requires env: `DISCORD_TOKEN`, `FIREBASE_SERVICE_ACCOUNT`, `GUILD_ID`,
  `SITE_PUBLISH_TAG_ID`.
- Writes a plan to `.migration/plan-<timestamp>.json` (git-ignored; it contains internal
  owner IDs — keep it out of version control and public output).
- Exit code `0` = plan is clean; `2` = plan produced but blocked/conflict records exist
  (apply is refused until they are resolved); `1` = hard error.

Review the summary output and the plan file: dispositions (`create`, `already-linked`,
`excluded`, `blocked`, `conflict`), per-record blockers with provenance, unknown tags,
and baseline differences (every difference vs the site's current `showcase.json` must
have an explanation).

### 2. Apply (production writes — operator only)

1. Confirm the Firebase project id (and database id, normally `(default)`) the local
   credentials point at. The script refuses to apply if `--firebase-project` /
   `--database` disagree with the credentials.
2. Prevent concurrent Project writes during apply (no `/mygame` usage once it exists,
   no second migration run in parallel).
3. Run:

```bash
npm run migrate:projects -- --apply \
  --plan .migration/plan-<timestamp>.json \
  --firebase-project <projectId> \
  --database '(default)'
```

The apply re-runs the full preflight live — replaying the reviewed plan's Project ids
and requiring the fresh plan to match the reviewed one exactly (dispositions, ids,
slugs, metadata, and the Firestore source-field snapshot per record) — then re-checks
the full consent boundary immediately before each record's transaction and commits
records sequentially. On ANY failure (consent loss, REST error, transaction rejection)
it stops and writes `.migration/apply-failed-<timestamp>.json` listing every record
that already committed.

### 3. Verify

- Rerun the dry run: every migrated thread must now be `already-linked`, counts must be
  `create: 0`, and the second run must perform zero writes by construction.
- Run the site export against a disposable output directory and compare with the
  pre-migration baseline: the tag-authoritative exporter output must be unchanged
  (same public records, links, assets; no new internal data exposed).
- Keep the plan, apply report, and export comparisons in `.migration/` (git-ignored).

## Recovery

Recovery instructions are limited to migration-touched records. For a bad Project
record: delete `projects/<projectId>` and clear `projectId` on `threads/<threadId>` back
to `null` (the only field this migration writes). There is no automatic rollback or
deletion — manual, reviewed corrections only.
