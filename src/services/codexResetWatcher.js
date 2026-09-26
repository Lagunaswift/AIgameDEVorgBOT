import { createHash } from 'node:crypto';
import cron from 'node-cron';
import { config } from '../config.js';
import { getDb, serverTimestamp } from '../firebase.js';

export const CODEX_RESET_SOURCE_URL =
  'https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work';
export const CODEX_RESET_CHECK_CRON = '*/30 * * * *';

const WATCHER_DOC_ID = 'openai-banked-codex-resets';
const MOCK_DOC_ID = 'codex-reset-live-test-2026-09-26';
const MAX_SOURCE_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;

function watcherRef() {
  return getDb().collection('externalWatchers').doc(WATCHER_DOC_ID);
}

function mockRef() {
  return getDb().collection('oneShotOperations').doc(MOCK_DOC_ID);
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

export function buildCodexResetAlert() {
  return [
    '**Codex reset update**',
    '',
    'OpenAI changed its official Codex reset announcement.',
    'Check **Settings → Usage** to see whether your account received a reset and any expiry or eligibility details.',
    '',
    `Official source: <${CODEX_RESET_SOURCE_URL}>`,
  ].join('\n');
}

export function buildCodexResetMockAlert() {
  return [
    '**TEST — Codex reset alert**',
    '',
    'This is a live delivery test from Byte running on Railway.',
    '**No Codex reset has been detected.**',
    '',
    'When OpenAI changes the official Codex reset announcement, the real alert will appear in this private channel automatically.',
  ].join('\n');
}

export async function fetchOfficialResetAnnouncement(fetchImpl = fetch) {
  const response = await fetchImpl(CODEX_RESET_SOURCE_URL, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'AIGAMEDEV-CodexResetWatcher/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`OpenAI reset source returned HTTP ${response.status}.`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_SOURCE_BYTES) {
    throw new Error('OpenAI reset source exceeded the maximum accepted response size.');
  }

  const html = await response.text();
  if (Buffer.byteLength(html, 'utf8') > MAX_SOURCE_BYTES) {
    throw new Error('OpenAI reset source exceeded the maximum accepted response size.');
  }

  const announcement = extractResetAnnouncement(html);
  return {
    announcement,
    fingerprint: fingerprintResetAnnouncement(announcement),
  };
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

export async function checkCodexResetWatcher(
  client,
  { trigger = 'manual', fetchImpl = fetch } = {},
) {
  if (!config.codexResetChannelId) {
    console.warn('[codexReset] no channel configured; skipping');
    return { status: 'no-config' };
  }

  const current = await fetchOfficialResetAnnouncement(fetchImpl);
  const ref = watcherRef();
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set({
      sourceUrl: CODEX_RESET_SOURCE_URL,
      fingerprint: current.fingerprint,
      announcement: current.announcement,
      seededAt: serverTimestamp(),
      lastTrigger: trigger,
    });
    console.log('[codexReset] seeded current official announcement without posting');
    return { status: 'seeded', fingerprint: current.fingerprint };
  }

  const previous = snap.data() || {};
  if (previous.fingerprint === current.fingerprint) {
    return { status: 'unchanged', fingerprint: current.fingerprint };
  }

  const channel = await fetchAlertChannel(client);
  await channel.send({
    content: buildCodexResetAlert(),
    allowedMentions: { parse: [] },
  });

  await ref.set(
    {
      sourceUrl: CODEX_RESET_SOURCE_URL,
      previousFingerprint: previous.fingerprint || null,
      fingerprint: current.fingerprint,
      announcement: current.announcement,
      alertedAt: serverTimestamp(),
      lastTrigger: trigger,
    },
    { merge: true },
  );

  console.log(`[codexReset] posted official reset update (${trigger})`);
  return {
    status: 'posted',
    fingerprint: current.fingerprint,
    previousFingerprint: previous.fingerprint || null,
  };
}

export async function postCodexResetMockOnce(client) {
  if (!config.codexResetChannelId) return { status: 'no-config' };

  const ref = mockRef();
  try {
    await ref.create({
      state: 'claimed',
      claimedAt: serverTimestamp(),
      channelId: config.codexResetChannelId,
    });
  } catch (err) {
    if (err?.code === 6 || err?.code === 'already-exists') {
      return { status: 'already' };
    }
    throw err;
  }

  try {
    const channel = await fetchAlertChannel(client);
    const message = await channel.send({
      content: buildCodexResetMockAlert(),
      allowedMentions: { parse: [] },
    });

    await ref.set(
      {
        state: 'sent',
        sentAt: serverTimestamp(),
        messageId: message.id,
      },
      { merge: true },
    );

    console.log(`[codexReset] live test posted to ${config.codexResetChannelId}`);
    return { status: 'posted', messageId: message.id };
  } catch (err) {
    await ref.delete().catch(() => {});
    throw err;
  }
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
  console.log('[codexReset] scheduled every 30 minutes');
  return task;
}
