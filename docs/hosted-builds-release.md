# Hosted Builds foundation release

This release ships code, not operational game hosting.

## Safe default

`HOSTED_BUILDS_ENABLED` is false when absent. Until runtime/provider acceptance, keep it absent or set it to `false` on the Bot.

When disabled:
- `/jam` and `/build` are not added to command registration.
- Hosted report notifications and Jam reconciliation jobs do not start.
- The registered thread-update handler returns without Discord/Firestore side effects.
- Existing `/mygame`, `/jamvotes`, moderation and community commands remain available.

When eventually enabled, `/jam` and `/build` additionally require actual ManageThreads permission in the configured AIGAMEDEV guild at the production command router. Default Discord command visibility alone is not sufficient.

## Release verification

The event registry is tested independently of Bot login. Thread-update handling is registered exactly once per client. Permission tests cover ordinary members, missing permissions, other guilds and authorised moderators. Rollout tests cover default-off registration and no-side-effect reconciliation.

A CI pass or merge does not verify Railway deployment, live command registration, R2 uploads, engine compatibility or runtime revocation. Record that evidence separately before enabling hosting.

The provider-neutral runtime-control implementation is still a placeholder. In particular, live revocation/retry guarantees and complete Jam/Project reference reconciliation require provider integration and further acceptance testing. Do not treat the disabled foundation as full V1 completion.
