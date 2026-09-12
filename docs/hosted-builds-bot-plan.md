# Hosted Builds & Jam Platform V1 — Bot implementation plan

Status: implementation in progress on feature branch. This document records the Bot-side responsibilities only.

## Authority split

Discord remains authoritative for:
- moderator approval (`Publish to site`)
- Jam lifecycle and phase
- Jam eligibility tags
- voting and awards
- moderator emergency actions

The website remains authoritative for:
- owner-facing Project/Build/Jam management UX
- Build upload state and validation state
- private preview requests
- owner publication intent

Cloudflare is not part of this domain model. The Bot talks only to Firestore/runtime-control interfaces and can run against a no-op/fake adapter until infrastructure is connected.

## Bot responsibilities

1. Mirror Jam records into Firestore using exact Discord IDs.
2. Reconcile `Publish to site` changes for linked Projects.
3. Lock exact Jam build IDs when a Jam moves to voting.
4. Revoke public runtime state promptly when moderator approval is removed.
5. Re-enable only when both owner publication intent and moderator approval are valid.
6. Export public hosted-build/Jam-submission data using exact IDs only.
7. Keep existing `/jamvotes` as voting authority.
8. Add operator commands for Jam setup/status/phase and Build disable/restore.
9. Never create a second Project or game thread for a hosted build.

## Acceptance rules

- No public hosted game without current moderator approval.
- Jam membership never bypasses `Publish to site`.
- Voting uses one immutable `buildId` per submission.
- Removing approval does not delete Project/Build/JamSubmission records.
- Reapproval can restore the same build when owner intent remains valid.
- All joins use `projectId`, `buildId`, `jamId`, `threadId`; no title/name matching.
- Runtime-control failures fail closed and are retried/reconciled.
