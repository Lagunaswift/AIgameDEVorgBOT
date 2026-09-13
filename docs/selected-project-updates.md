# Selected development updates V2.4

Private preference contract: `src/lib/project-updates-contracts.mjs`, byte-identical to
the Site contract. The Site owns authenticated preference edits. The Bot reads selections
only after existing owner intent and live Publish to site approval succeed.

`readSelectedUpdates` fetches only exact public-selected messages from the fixed thread.
It rejects wrong authors, bots/webhooks, forwards, crossposts, snapshots and ephemeral
messages. No reply target, embed or attachment is fetched. Dates come from the source.
Text is bounded/flattened and stripped of quoted/spoiler/code material, mention IDs and
raw HTTP links, then exported through the existing escaped Project activity renderer.

Draft choices are not fetched. Missing/deleted/inaccessible messages are omitted. No
unselected fallback exists. Malformed preferences and operational API failures abort the
candidate export. An exact manual activity URL wins over a duplicate selected source.
Existing chronology and 50-entry limit remain. Removal is effective on a successful
static refresh; failed refreshes retain the previous validated snapshot.

No Discord commands, database migrations, Bot tokens on the Site, public hosting flags,
Showcase/Jam identity, scoring, moderator rules or automatic posts change. Deploy the
Site editor/consumer first, then this producer. Main-branch changes trigger the existing
staged export workflow. Its validation and build must pass before data promotion.

Verification: shared strict contract tests, full exporter wiring and privacy/authorship
negative tests, complete Bot suite with loopback demo Firestore, Railway deployment
status and staged live export. Real creator publication remains separate acceptance.
