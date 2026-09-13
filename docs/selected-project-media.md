# Creator-selected gallery export, V2.3

Status: candidate; verify and deploy the Site consumer before this exporter.

The Site owns private `projectMedia/{projectId}` choices. The Bot reads them only after
its existing exact canonical-source and current Publish to site approval checks. It never
enumerates all private choices, creates a second Project/thread, or copies member comments.

The shared pure contract at `src/lib/project-media-contracts.mjs` matches the Site copy.
Preferences contain exact message/attachment IDs, descriptions, captions, visibility,
a mode and a revision. No signed CDN URLs, bot credentials or guessed source routes.

Automatic mode retains old gallery behaviour. Selected mode uses only explicitly public
items. Empty/invalid/unavailable selections never fall back to other pictures. The cover
image and Showcase thumbnail are unchanged. A malformed preference record aborts the
candidate export rather than being silently repaired.

`selected-project-media.mjs` checks exact owner/message/thread/attachment, disallows
webhooks/bots/ephemeral/forwarded data, bounds file size and pixels, fetches only a fresh
exact Discord CDN path without credentials/redirects, checks raster signatures and emits
bounded WebP. GIFs use the first frame. SVG/original-file fallback is not allowed.
Generated filenames contain hashes, not Discord IDs. The existing generated-asset cleanup
removes old selections on the next successful export/deployment, not instantly.

Unit tests cover the real exporter call path, approval withdrawal/reapproval, drafts,
wrong authors, deletion, operational failures, URL safety, real Sharp encoding, stream
limits, cleanup and automatic compatibility. Existing regression doubles now model a
missing preference document explicitly. Real Discord/member production behaviour is a
separate end-to-end acceptance gate.

No new slash command, hosting flag, account or secret is required. Existing GitHub export
and Railway integrations deploy this code. Do not enable Hosted Builds as part of V2.3.
The full step-by-step roadmap and role guides are maintained in AIGAMEDEVSITE docs.
