import { createHash } from 'node:crypto';
import cron from 'node-cron';
import { config } from '../config.js';
import { getDb, serverTimestamp } from '../firebase.js';

export const CODEX_RESET_HELP_URL =
  'https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work';
export const CODEX_RESET_FEED_URL = 'https://codex-reset.com/api/feed';
export const CODEX_RESET_TIMELINE_URL = 'https://codex-reset.com/api/timeline';
export const OPENAI_STATUS_INCIDENTS_URL = 'https://status.openai.com/api/v2/incidents.json';
export const CODEX_RESET_TRACKER_URL = 'https://codex-reset.com/';
export const CODEX_RESET_CHECK_CRON = '*/2 * * * *';

const WATCHER_DOC_ID = 'codex-reset-multisource-v2';
const ALERT_COLLECTION = 'codexResetAlertEvents';
const MAX_SOURCE_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const BOOT_BACKFILL_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = 'AIGAMEDEV-CodexResetWatcher/2.0 (+https://www.aigamedevs.org/)';

function watcherRef() {
  return getDb().collection('externalWatchers').doc(WATCHER_DOC_ID);
}

function alertRef(key) {
  const id = createHash('sha256').update(key, 'utf8').digest('hex');
  return getDb().collection(ALERT_COLLECTION).doc(id);
}

function isAlreadyExists(err) {
  return err?.code === 6 || err?.code === 'already-exists' || err?.code === 'ALREADY_EXISTS';
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function truncate(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

async function fetchBoundedText(url, { accept = 'text/plain', fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      accept,
      'user-agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    throw new Error(
      `${url} returned HTTP ${response.status}${retryAfter ? ` (retry-after ${retryAfter})` : ''}.`,
    );
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_SOURCE_BYTES) {
    throw new Error(`${url} exceeded the maximum accepted response size.`);
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) {
    throw new Error(`${url} exceeded the maximum accepted response size.`);
  }
  return text;
}

async function fetchJson(url, fetchImpl = fetch) {
  const text = await fetchBoundedText(url, {
    accept: 'application/json',
    fetchImpl,
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} returned invalid JSON.`);
  }
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function htmlToPlainText(html) {
  const stripped = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|section|article|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(stripped)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function extractResetAnnouncement(html) {
  const text = htmlToPlainText(html);
  const startMatch = /(?:^|\n)As (?:a )?part of\b/i.exec(text);
  if (!startMatch) {
    throw new Error('Official reset announcement start marker was not found.');
  }

  const start = startMatch.index + (text[startMatch.index] === '\n' ? 1 : 0);
  const remainder = text.slice(start);
  const overviewMatch = /\nOverview(?:\n|$)/i.exec(remainder);
  if (!overviewMatch) {
    throw new Error('Official reset announcement end marker was not found.');
  }

  const announcement = remainder
    .slice(0, overviewMatch.index)
    .replace(/\s+/g, ' ')
    .trim();

  if (announcement.length < 120 || !/\breset/i.test(announcement)) {
    throw new Error('Official reset announcement did not pass content validation.');
  }

  return announcement;
}

export function fingerprintResetAnnouncement(announcement) {
  return createHash('sha256').update(announcement, 'utf8').digest('hex');
}

function tiboAudience(text) {
  const lower = String(text || '').toLowerCase();
  return (
    /\bcodex\b/.test(lower) ||
    /chatgpt work/.test(lower) ||
    /\bpaid users?\b/.test(lower) ||
    /plus/.test(lower) ||
    /\bpro\b/.test(lower) ||
    /business/.test(lower) ||
    /all accounts/.test(lower)
  );
}

export function candidatesFromTiboFeed(data) {
  if (!data || data.stale === true || !Array.isArray(data.tweets)) return [];

  const candidates = [];
  for (const tweet of data.tweets) {
    const id = String(tweet?.id || '').trim();
    const announcedAt = validDate(tweet?.at || tweet?.declared_at);
    const sourceUrl = String(tweet?.url || '').trim();
    const text = String(tweet?.text || '');
    if (!id || !announcedAt || !sourceUrl) continue;

    const lower = text.toLowerCase();
    const banked =
      tweet.kind === 'banked' &&
      /\bbanked reset\b/.test(lower) &&
      tiboAudience(text);

    const hard =
      tweet.explicit_reset_claim === true &&
      tweet.tibo_lane === 'reset_announcement' &&
      /\breset(?:ting|s|ted)?\b/.test(lower) &&
      /usage limits?|weekly usage|rate limits?/.test(lower) &&
      tiboAudience(text);

    if (!banked && !hard) continue;

    candidates.push({
      key: `tibo:${id}`,
      kind: banked ? 'banked' : 'hard',
      announcedAt,
      sourceUrl,
      sourceFamily: 'tibo',
      sourceLabel: 'Tibo Sottiaux',
      summary: truncate(text),
      verification: 'direct-public-post',
    });
  }
  return candidates;
}

export function candidatesFromVerifiedTimeline(data) {
  if (!data || !Array.isArray(data.events)) return [];

  const candidates = [];
  for (const event of data.events) {
    const id = String(event?.id || '').trim();
    const announcedAt = validDate(event?.announced_at);
    const sourceUrl = String(event?.url || '').trim();
    if (!id || !announcedAt || !sourceUrl || event.confidence !== 'high') continue;

    const hard =
      event.group === 'reset' &&
      event.announcement_state === 'announced';

    const banked =
      event.reset_kind === 'banked' &&
      ['announced', 'arriving', 'available'].includes(event.banked_state);

    if (!hard && !banked) continue;

    candidates.push({
      key: `tibo:${id}`,
      kind: banked ? 'banked' : 'hard',
      announcedAt,
      sourceUrl,
      sourceFamily: 'tracker',
      sourceLabel: event.source_label || 'Verified Codex reset timeline',
      summary: truncate(event.summary || event.text),
      verification: 'verified-timeline',
    });
  }
  return candidates;
}

function statusUpdateIsResetAction(body) {
  const text = String(body || '');
  if (!/\bcodex\b/i.test(text)) return false;
  return (
    /\bwe (?:have )?(?:reset|are resetting|will reset)\b/i.test(text) ||
    /\busage limits? (?:have been|are being|will be) reset\b/i.test(text) ||
    /\b(?:codex )?usage limits? reset for\b/i.test(text)
  );
}

export function candidatesFromOpenAIStatus(data) {
  if (!data || !Array.isArray(data.incidents)) return [];

  const candidates = [];
  for (const incident of data.incidents) {
    const incidentText = `${incident?.name || ''} ${(incident?.incident_updates || [])
      .map((update) => update?.body || '')
      .join(' ')}`;
    if (!/\bcodex\b/i.test(incidentText)) continue;

    for (const update of incident.incident_updates || []) {
      if (!statusUpdateIsResetAction(update?.body)) continue;
      const id = String(update?.id || '').trim();
      const announcedAt = validDate(update?.created_at || update?.display_at);
      if (!id || !announcedAt) continue;

      candidates.push({
        key: `openai-status:${id}`,
        kind: /\bbanked reset\b/i.test(update.body || '') ? 'banked' : 'hard',
        announcedAt,
        sourceUrl:
          `https://status.openai.com/incidents/${String(incident.id || '').trim()}`,
        sourceFamily: 'openai-status',
        sourceLabel: 'OpenAI Status',
        summary: truncate(update.body),
        verification: 'official-status',
      });
    }
  }
  return candidates;
}

export function mergeCandidates(...groups) {
  const merged = new Map();
  const rank = {
    'verified-timeline': 4,
    'direct-public-post': 3,
    'official-status': 2,
    'official-help': 1,
  };

  for (const candidate of groups.flat()) {
    if (!candidate?.key) continue;
    const existing = merged.get(candidate.key);
    if (!existing || (rank[candidate.verification] || 0) > (rank[existing.verification] || 0)) {
      merged.set(candidate.key, candidate);
    }
  }
  return [...merged.values()];
}

export function buildCodexResetAlert(event) {
  const title =
    event.kind === 'banked'
      ? '**Banked Codex reset announced**'
      : event.kind === 'official-update'
        ? '**Official Codex reset notice updated**'
        : '**Codex usage reset announced**';

  const explanation =
    event.kind === 'banked'
      ? 'A banked Codex reset has been announced for eligible paid accounts.'
      : event.kind === 'official-update'
        ? 'OpenAI changed its official Codex reset notice.'
        : 'A discretionary Codex usage-limit reset has been announced.';

  const lines = [
    title,
    '',
    explanation,
  ];

  if (event.summary) lines.push('', truncate(event.summary, 700));
  lines.push('', `Source: <${event.sourceUrl}>`);

  if (event.sourceFamily === 'tibo' || event.sourceFamily === 'tracker') {
    lines.push(`Verification data: <${CODEX_RESET_TRACKER_URL}>`);
  }

  lines.push('', 'Check **Settings → Usage** for your account. Propagation and eligibility can vary.');
  return lines.join('\n');
}

export async function fetchResetSources(fetchImpl = fetch) {
  const requests = {
    feed: fetchJson(CODEX_RESET_FEED_URL, fetchImpl),
    timeline: fetchJson(CODEX_RESET_TIMELINE_URL, fetchImpl),
    status: fetchJson(OPENAI_STATUS_INCIDENTS_URL, fetchImpl),
    help: fetchBoundedText(CODEX_RESET_HELP_URL, {
      accept: 'text/html,application/xhtml+xml',
      fetchImpl,
    }),
  };

  const entries = await Promise.all(
    Object.entries(requests).map(async ([name, promise]) => {
      try {
        return [name, { ok: true, value: await promise }];
      } catch (err) {
        return [name, { ok: false, error: err }];
      }
    }),
  );

  return Object.fromEntries(entries);
}

async function fetchAlertChannel(client) {
  let channel;
  try {
    channel = await client.channels.fetch(config.codexResetChannelId);
  } catch (err) {
    throw new Error(
      `Could not fetch Codex reset channel ${config.codexResetChannelId}: ${err.message}`,
    );
  }

  if (!channel || !channel.isTextBased()) {
    throw new Error(`Codex reset channel ${config.codexResetChannelId} is not text-based.`);
  }
  if (channel.guildId && channel.guildId !== config.guildId) {
    throw new Error('Codex reset channel belongs to a different guild.');
  }
  return channel;
}

async function claimCandidate(candidate, trigger) {
  const ref = alertRef(candidate.key);
  try {
    await ref.create({
      key: candidate.key,
      kind: candidate.kind,
      sourceUrl: candidate.sourceUrl,
      sourceFamily: candidate.sourceFamily,
      announcedAt: candidate.announcedAt,
      verification: candidate.verification,
      state: 'claimed',
      trigger,
      claimedAt: serverTimestamp(),
    });
    return { claimed: true, ref };
  } catch (err) {
    if (isAlreadyExists(err)) return { claimed: false, ref };
    throw err;
  }
}

async function postCandidate(channel, candidate, trigger) {
  const claim = await claimCandidate(candidate, trigger);
  if (!claim.claimed) return { status: 'already', key: candidate.key };

  try {
    const message = await channel.send({
      content: buildCodexResetAlert(candidate),
      allowedMentions: { parse: [] },
    });

    await claim.ref.set(
      {
        state: 'sent',
        messageId: message.id,
        sentAt: serverTimestamp(),
      },
      { merge: true },
    );

    return { status: 'posted', key: candidate.key, messageId: message.id };
  } catch (err) {
    await claim.ref.delete().catch(() => {});
    throw err;
  }
}

function candidateAfterBaseline(candidate, baselineAt) {
  const candidateTime = new Date(candidate.announcedAt).getTime();
  const baselineTime = new Date(baselineAt).getTime();
  return Number.isFinite(candidateTime) && Number.isFinite(baselineTime) && candidateTime >= baselineTime;
}

export async function checkCodexResetWatcher(
  client,
  { trigger = 'manual', fetchImpl = fetch, now = new Date() } = {},
) {
  if (!config.codexResetChannelId) {
    console.warn('[codexReset] no channel configured; skipping');
    return { status: 'no-config' };
  }

  const sources = await fetchResetSources(fetchImpl);
  for (const [name, result] of Object.entries(sources)) {
    if (!result.ok) console.error(`[codexReset] ${name} source failed:`, result.error.message);
  }

  if (!sources.feed.ok && !sources.timeline.ok && !sources.status.ok && !sources.help.ok) {
    return { status: 'source-failed' };
  }

  let help = null;
  if (sources.help.ok) {
    try {
      const announcement = extractResetAnnouncement(sources.help.value);
      help = {
        announcement,
        fingerprint: fingerprintResetAnnouncement(announcement),
      };
    } catch (err) {
      console.error('[codexReset] help source parse failed:', err.message);
    }
  }

  const ref = watcherRef();
  const snap = await ref.get();
  const previous = snap.exists ? snap.data() || {} : {};
  const baselineAt =
    validDate(previous.baselineAt) ||
    new Date(now.getTime() - BOOT_BACKFILL_MS).toISOString();

  const feedCandidates = sources.feed.ok
    ? candidatesFromTiboFeed(sources.feed.value)
    : [];
  const timelineCandidates = sources.timeline.ok
    ? candidatesFromVerifiedTimeline(sources.timeline.value)
    : [];
  const statusCandidates = sources.status.ok
    ? candidatesFromOpenAIStatus(sources.status.value)
    : [];

  let candidates = mergeCandidates(feedCandidates, timelineCandidates, statusCandidates)
    .filter((candidate) => candidateAfterBaseline(candidate, baselineAt));

  const helpChanged =
    help &&
    previous.helpFingerprint &&
    previous.helpFingerprint !== help.fingerprint;

  if (helpChanged) {
    const recentPrimary = candidates.some((candidate) => {
      if (!['hard', 'banked'].includes(candidate.kind)) return false;
      return now.getTime() - new Date(candidate.announcedAt).getTime() < 36 * 60 * 60 * 1000;
    });

    if (!recentPrimary) {
      candidates.push({
        key: `openai-help:${help.fingerprint}`,
        kind: 'official-update',
        announcedAt: now.toISOString(),
        sourceUrl: CODEX_RESET_HELP_URL,
        sourceFamily: 'openai-help',
        sourceLabel: 'OpenAI Help Center',
        summary: null,
        verification: 'official-help',
      });
    }
  }

  candidates = mergeCandidates(candidates).sort(
    (a, b) => new Date(a.announcedAt).getTime() - new Date(b.announcedAt).getTime(),
  );

  const stateUpdate = {
    version: 2,
    baselineAt,
    lastCheckedAt: serverTimestamp(),
    lastTrigger: trigger,
    sourceHealth: Object.fromEntries(
      Object.entries(sources).map(([name, result]) => [name, result.ok]),
    ),
  };
  if (!snap.exists || !previous.baselineAt) stateUpdate.seededAt = serverTimestamp();
  if (help) stateUpdate.helpFingerprint = help.fingerprint;

  if (candidates.length === 0) {
    await ref.set(stateUpdate, { merge: true });
    return {
      status: snap.exists ? 'unchanged' : 'seeded',
      baselineAt,
      sourceHealth: stateUpdate.sourceHealth,
    };
  }

  const channel = await fetchAlertChannel(client);
  const results = [];
  for (const candidate of candidates) {
    try {
      results.push(await postCandidate(channel, candidate, trigger));
    } catch (err) {
      console.error(`[codexReset] failed to post ${candidate.key}:`, err.message);
      results.push({ status: 'send-failed', key: candidate.key, error: err.message });
    }
  }

  const posted = results.filter((result) => result.status === 'posted');
  if (posted.length > 0) {
    stateUpdate.lastAlertAt = serverTimestamp();
    stateUpdate.lastAlertKey = posted.at(-1).key;
  }
  await ref.set(stateUpdate, { merge: true });

  console.log(
    `[codexReset] check complete (${trigger}): ${posted.length} posted, ${results.length - posted.length} skipped/failed`,
  );

  return {
    status: posted.length > 0 ? 'posted' : 'unchanged',
    posted: posted.length,
    results,
    sourceHealth: stateUpdate.sourceHealth,
  };
}

export function scheduleCodexResetWatcher(client) {
  const task = cron.schedule(
    CODEX_RESET_CHECK_CRON,
    () => {
      checkCodexResetWatcher(client, { trigger: 'cron' }).catch((err) =>
        console.error('[codexReset] scheduled check failed:', err.message),
      );
    },
    { timezone: 'UTC' },
  );
  console.log('[codexReset] scheduled every 2 minutes');
  return task;
}
