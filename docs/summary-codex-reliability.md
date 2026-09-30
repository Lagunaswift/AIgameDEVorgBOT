# Summary Unicode and Codex source reliability

## Failure addressed

The September 30 runtime logs show Anthropic rejecting the chat summary request with `no low surrogate in string`, while the daily digest still posts its fallback. `String.slice(0, 280)` can split a valid emoji into a lone leading surrogate. Transcript cuts now retain the same UTF-16 budget without splitting surrogate pairs. Malformed content, display names, and channel names are repaired. Both Claude request paths also repair system/user strings at the final transport boundary. Output scrubbing retains mention protection and safe truncation. Model selection, request limits, fallback behavior, prompts, and public-source permission checks are unchanged.

## Codex source outages

A Help Center 403 is an unavailable source, not evidence of a reset or of no reset. The four configured sources continue independently. Healthy sources retain the two-minute schedule. A 401/403/429 starts a 30-minute cooldown; subsequent failures double the delay up to six hours. Network, server, and parse errors start at two minutes. Retry-After seconds and HTTP dates can extend this delay, bounded at one day. A 200 HTML challenge page is not accepted as a healthy Help Center read.

Only actual failed probes log warnings, with the next attempt time. Skipped probes remain unhealthy in Firestore and do not log the same failure again. Recovery logs once. If all sources are unavailable, the watcher records that health and returns source-failed without sending anything. Next retry times are recorded in sourceRetryAt. Cooldowns are process-local: a redeploy makes one fresh probe. This does not bypass access controls or guarantee that the Help Center stops returning 403.

Private channel routing, allowedMentions, event verification filters, deduplication, and first-boot lookback are unchanged. No personal weekly/hourly rollover notifications are introduced. No new environment variables are required.

## Regression coverage

- A real 280-unit cut that previously created a lone surrogate, complete emoji, malformed names/content, multilingual text, and output limits.
- Plain and beta Claude request construction with intercepted SDK methods; no paid requests.
- Per-source 403 cooldown, healthy-source continuity, exponential retries, Retry-After, recovery, single-flight, and malformed response handling.
- Existing full bot/Firestore suite remains the release gate. No production digest replay or test-channel post is part of this repair.
