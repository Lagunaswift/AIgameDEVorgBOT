# Game discovery and resource links

The Site owns `projectConnections/{projectId}` edits. Contract
`src/lib/project-connections/contracts.mjs` must match the Site byte-for-byte.
The core exporter passes only freshly approved owner-published Projects to
`readProjectConnections`. The current staged Site tool IDs and guide filenames form the
public catalogue. Draft labels/links and unavailable targets are not exported.

Deploy the Site consumer first. The existing export workflow reads into staging, validates,
builds, then promotes `project-connections.json`. Failure preserves previous-good output.
Do not add names, contact details, message bodies or inferred endorsements to the sidecar.
A resource link is a creator statement, not moderator certification or a licence check.

Clear and account-removal work must cover the private collection and regenerate public
snapshots. No new Bot commands or live tags are required. Hosting remains disabled.
