# Project destination ownership: V2

The owner authorised code continuation and deployment on 12 September 2026. This package does not enable hosted builds.

## Rules

- `/projecturl` is retired from registration, command help and owner hints.
- A stale Discord invocation replies privately and does not call the old handler.
- `/mygame manage` opens the existing Project editor. A new Project still requires the existing moderator-approved creation flow and an owner-selected status.
- Approved linked Showcase destinations come from the exact same-owner, fixed-source Project already exported by the moderation pipeline.
- An empty Project destination stays empty. An unpublished Project does not expose private destinations or resurrect stale thread metadata.
- Existing unlinked thread URLs stay read-only. There is no data deletion, reassignment, inference or automatic database migration.
- `/assignjam`, voting, scoring identity and moderator approval semantics are unchanged.

Tests cover structured destination priority, exact exporter wiring, explicit removal, owner unpublication, command registry retirement and cached-command guidance. Site tests additionally cover private/malformed joins and independent public Jam browsing.

The existing startup registry performs the normal guild command sync after deployment. A Railway success is deployment evidence, not proof that every Discord client has refreshed its command menu.
