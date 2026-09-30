# Automatic game-idea screenshots (Gemini)

`/gameidea [theme] [style]` posts Byte's existing written pitch first, then queues a
separate, image-only reply to that exact message. The text generator, persona,
existing cooldowns, daily idea allowance and free fallbacks are unchanged.

## Enable on Railway

This is opt-in. Deployment alone does not start image spending. Add these variables
to the **existing bot service**, not the website or a public repository:

```dotenv
GEMINI_API_KEY=<a Gemini API key from the operator's billed AI Studio project>
GAME_IDEA_IMAGES_ENABLED=true
GAME_IDEA_IMAGE_MODEL=gemini-3.1-flash-image
GAME_IDEA_IMAGE_DIRECTOR_MODEL=gemini-3.1-flash-lite
GAME_IDEA_IMAGE_DAILY_CAP=10
GAME_IDEA_IMAGE_MAX_ATTEMPTS=2
GAME_IDEA_IMAGE_STYLE=auto
GAME_IDEA_IMAGE_QUEUE_SIZE=4
GAME_IDEA_IMAGE_TIMEOUT_MS=120000
```

Only the API key and enabled flag are required; the other values show defaults.
Never paste the API key into Discord, source code, logs or a PR. The API project
must have access to both configured models and an appropriate billing/quota setup.
No new npm dependency is required. Calls use Node's fetch and Google's Interactions
API; the existing sharp dependency validates and prepares Discord attachments.

Deploy the reviewed commit, then verify bot startup and slash-command registration.
The existing `AUTO_REGISTER_COMMANDS=true` setting registers the new optional
`style` choices on startup; otherwise run `npm run register` as usual.

The bot needs View Channel, Read Message History, Attach Files and Send Messages.
In a thread it needs Send Messages in Threads. Archived or locked threads are
skipped rather than changed. Images use bot-token replies, not expiring interaction
follow-up tokens. Missing/deleted/edited originals, wrong-guild messages or
permission failures are never redirected to a different channel.

## Art direction and output contract

Styles: automatic, hand-drawn adventure (`handdrawn`), PS2-era stylised 3D (`ps2`),
papercraft (`papercraft`), retro cel anime (`anime`), and pixel art (`pixel`).

A supplied `/gameidea style` overrides the server default and the director's choice.
Without an explicit style the director selects from the concrete stored presets,
using a recognisable art request in the member theme where appropriate. For a
server-wide hand-drawn default use `GAME_IDEA_IMAGE_STYLE=handdrawn`.

The director removes the title, worrying-part commentary, seed footer and extra
reaction. It translates the remaining idea into a structured genre, camera,
playable moment, player action, visible hook, icon-only interface, palette,
required evidence and contradictory details to avoid. Only this validated brief
reaches the image model. The renderer never receives the formatted Discord post.

The fixed prompt requires a single 16:9 gameplay viewport with integrated HUD,
not a poster, title screen, collage, concept presentation or monitor mockup.
No visible text, numbers, letters, captions, labels, dialogue or pseudo-writing;
use icons, portraits, unlabelled meters and bars. The requested style applies to
both world and UI, but never changes the gameplay genre.

For the microwave fleet example, the director is instructed to show a depleted
late-game menu and forbid the missing controls from also appearing active.
The pipeline is not hardcoded to generate a microwave or strategy game for every
idea. All five presets have explicit rendering instructions and exclusions.

A separate multimodal review checks community suitability, absence of text,
single-screen composition, style consistency and visible mechanics. Any ambiguous
or malformed verdict fails closed. A non-safety visual rejection permits one
corrective regeneration by default, using fixed trusted correction instructions.
A safety refusal is not retried. The checks reduce mistakes but are not a guarantee
that generated art contains no lettering or perfectly implements a mechanic.

## Spend, retries and persistence

The default cap admits at most **10 jobs per UTC day**, independently of Byte's
existing text-generation cap. Each job allows at most two render requests. A
second transactional counter separately caps all render requests at **20 per UTC
day**, including corrective attempts. Lower the cap or set max attempts to one
for a smaller budget. No moderator bypass exists for image caps. These are call
limits, not a fixed currency budget; API prices and account billing remain external.

Firestore owns atomic admission, deduplication and render reservations:

- `gameIdeaImageJobs/{originalMessageId}`: state, model IDs, style, attempts, source
  channel/guild IDs and final reply ID. No prompt, image bytes or credentials.
- `gameIdeaImageStats/{YYYY-MM-DD}`: accepted-job and render-request counters.

A process runs one image job at a time and holds at most four active/pending jobs
by default. A full queue silently leaves the written idea alone. Per-message
Firestore dedup prevents duplicate processing across replicas and restarts.
Firestore failures and malformed counters stop spending. Reservations are not
refunded after provider errors because a timed-out request may have been billed.

A job normally makes one director call, one image call and one review call.
The maximum is one director plus two image and two review calls. HTTP/auth/rate
limit/timeout/invalid-payload failures do not cause an image API retry. Each API
call has a timeout, input/output size limits and no credential-bearing redirects.
Image responses must contain exactly one supported inline image. sharp verifies
actual encoding, dimensions, pixel limits and landscape aspect ratio, then creates
a bounded JPEG attachment. The review sees that prepared attachment.

Transient Discord upload errors allow one application-level retry with the SAME
bytes and stable enforced nonce; never another paid render. The reply suppresses
all mentions, including reply-author pings. The visible message has no caption;
the attachment's accessible description identifies it as an AI-generated mockup.

This is a **best-effort in-memory queue, not a durable image archive**. A restart
can drop pending jobs or image bytes. Previously claimed jobs are never replayed
automatically; an interrupted job may retain its last state. This intentionally
favours bounded spending/no duplicates over guaranteed eventual delivery. There
is no automatic historical backfill. Do not delete job dedup records to retry a
possibly delivered image. Job/stat records currently have no automatic cleanup.

## Verification and activation canary

Run `npm test`. The existing PR workflow runs the full suite with the Firestore
emulator and real image decoder. New tests cover prompt contracts, unsafe/malformed
outputs, all API error paths, original-message targeting, thread permissions,
non-pinging payloads, duplicate/queue/budget behaviour, bounded corrections,
same-image upload retries and transactional contention/UTC rollover.

After deployment with the API key and flag, run one `/gameidea` in a channel with
the listed permissions, optionally choosing the hand-drawn preset. Verify:

1. The ordinary written idea arrives first, unchanged.
2. Exactly one image-only reply references that message and sends no mention.
3. The image is a single gameplay view in the chosen style, with no lettering.
4. Its Firestore job ends `sent`, with the reply ID and one or two attempts.
5. A provider refusal or inaccessible original leaves the written idea intact.

Do not treat mocked tests as a live provider or Discord canary. Live API access,
visual quality and Railway environment/deployment must be checked separately.

Disable by setting `GAME_IDEA_IMAGES_ENABLED=false` and redeploying/restarting the
bot. Setting `GAME_IDEA_IMAGE_DAILY_CAP=0` also disables admission. The original text
command keeps working. These settings and the API key are environment-owned;
Firestore's existing runtime config cannot override them.

## Primary API references (verified 2026-09-30)

- Image models and image response formats: https://ai.google.dev/gemini-api/docs/image-generation
- Interactions API, stateless requests and output steps: https://ai.google.dev/gemini-api/docs/interactions-overview
- JSON-schema output: https://ai.google.dev/gemini-api/docs/structured-output
- REST schema: https://ai.google.dev/api/interactions-api
- Discord replies, attachments, allowed mentions and enforced nonce: https://docs.discord.com/developers/resources/message
