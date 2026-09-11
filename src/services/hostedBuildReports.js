import { config } from '../config.js';
import { Timestamp, getDb } from '../firebase.js';
import { hostedPlatformFlags } from '../lib/hostedFeatureFlags.js';

const POLL_INTERVAL_MS = 60_000;
let timer = null;
let inFlight = false;

function reportLine(value) {
  const details = String(value.details || '').trim().replace(/\s+/g, ' ').slice(0, 700);
  return [
    '**Hosted Build report**',
    `Build: \`${value.buildId ?? 'unknown'}\``,
    `Project: \`${value.projectId ?? 'unknown'}\``,
    `Category: **${value.category ?? 'other'}**`,
    `Reporter Discord ID: \`${value.reporterDiscordId ?? 'unknown'}\``,
    details ? `Details: ${details}` : 'Details: none',
    `Use \`/build inspect\` or \`/build disable\` with this Build ID if action is required.`,
  ].join('\n');
}

export async function notifyPendingHostedBuildReports(client) {
  if (!hostedPlatformFlags().hostedBuildsEnabled) return { status: 'disabled', notified: 0 };
  if (!config.modFeedChannelId) return { status: 'no-channel', notified: 0 };
  if (inFlight) return { status: 'busy', notified: 0 };
  inFlight = true;
  try {
    const db = getDb();
    const snapshot = await db.collection('buildReports').where('notified', '==', false).limit(20).get();
    if (snapshot.empty) return { status: 'ok', notified: 0 };
    const channel = await client.channels.fetch(config.modFeedChannelId);
    if (!channel?.isTextBased?.()) return { status: 'invalid-channel', notified: 0 };

    let notified = 0;
    for (const doc of snapshot.docs) {
      const report = doc.data();
      if (report?.status !== 'open') {
        await doc.ref.set({ notified: true, notifiedAt: Timestamp.now() }, { merge: true });
        continue;
      }
      try {
        const message = await channel.send({ content: reportLine(report), allowedMentions: { parse: [] } });
        await doc.ref.set({
          notified: true,
          notifiedAt: Timestamp.now(),
          notificationChannelId: channel.id,
          notificationMessageId: message.id,
        }, { merge: true });
        notified += 1;
      } catch (error) {
        console.error(`[hosted-platform] failed to notify Build report ${doc.id}:`, error.message);
      }
    }
    return { status: 'ok', notified };
  } finally {
    inFlight = false;
  }
}

export function scheduleHostedBuildReports(client) {
  if (!hostedPlatformFlags().hostedBuildsEnabled || !config.modFeedChannelId) return null;
  if (timer) return timer;
  const poll = () => notifyPendingHostedBuildReports(client).catch((error) =>
    console.error('[hosted-platform] Build report polling failed:', error.message));
  poll();
  timer = setInterval(poll, POLL_INTERVAL_MS);
  return timer;
}
