import { getDb, serverTimestamp, Timestamp } from '../firebase.js';
import { getEffectiveConfig } from './config.js';

const REPORT_ID_RE = /^report_[A-Za-z0-9_-]{16,128}$/;
const LEASE_MS = 2 * 60_000;
const POLL_MS = 60_000;
const MAX_ALERTS_PER_POLL = 20;

function assertReportId(value) {
  if (typeof value !== 'string' || !REPORT_ID_RE.test(value)) throw new Error('Invalid report ID');
  return value;
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export function buildReportAlertText(report) {
  const details = String(report?.details ?? '').trim().replace(/\s+/g, ' ').slice(0, 700) || 'No extra details.';
  const category = String(report?.category ?? 'other').trim().slice(0, 40);
  return [
    '🚨 **Hosted Build report**',
    `Report: \`${report.reportId}\``,
    `Build: \`${report.buildId}\``,
    `Project: \`${report.projectId}\``,
    `Category: **${category}**`,
    `Reporter: <@${report.reporterDiscordId}>`,
    details,
    '',
    `Use \`/build disable build_id:${report.buildId}\` if public play must stop immediately.`,
    `Use \`/build resolve report_id:${report.reportId}\` when review is complete.`,
  ].join('\n');
}

async function claimReport(reportRef, workerId, nowMs, db) {
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(reportRef);
    if (!snap.exists) return null;
    const report = snap.data();
    if (report.status !== 'open' || report.notified === true) return null;
    const leaseUntil = timestampMillis(report.notificationLeaseUntil);
    if (leaseUntil > nowMs) return null;
    transaction.update(reportRef, {
      notificationLeaseOwner: workerId,
      notificationLeaseUntil: Timestamp.fromMillis(nowMs + LEASE_MS),
      notificationAttempts: Number.isInteger(report.notificationAttempts) ? report.notificationAttempts + 1 : 1,
      updatedAt: serverTimestamp(),
    });
    return { id: snap.id, ...report };
  });
}

async function releaseFailedClaim(reportRef, workerId, db) {
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(reportRef);
    if (!snap.exists) return;
    const report = snap.data();
    if (report.notificationLeaseOwner !== workerId || report.notified === true) return;
    transaction.update(reportRef, {
      notificationLeaseOwner: null,
      notificationLeaseUntil: null,
      lastNotificationErrorAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

export async function notifyPendingBuildReports(client, { db = getDb(), workerId = client?.user?.id || 'bot' } = {}) {
  const cfg = await getEffectiveConfig();
  if (!cfg.modFeedChannelId) return { status: 'no-config', checked: 0, sent: 0 };

  const snapshot = await db.collection('buildReports').where('notified', '==', false).limit(MAX_ALERTS_PER_POLL).get();
  if (snapshot.empty) return { status: 'ok', checked: 0, sent: 0 };

  let channel;
  try {
    channel = await client.channels.fetch(cfg.modFeedChannelId);
  } catch (error) {
    return { status: 'channel-failed', checked: snapshot.size, sent: 0, error: error.message };
  }
  if (!channel?.isTextBased?.()) return { status: 'channel-invalid', checked: snapshot.size, sent: 0 };

  let sent = 0;
  const nowMs = Date.now();
  for (const doc of snapshot.docs) {
    const claimed = await claimReport(doc.ref, workerId, nowMs, db);
    if (!claimed) continue;
    const report = { ...claimed, reportId: claimed.reportId || doc.id };
    try {
      const message = await channel.send({
        content: buildReportAlertText(report),
        allowedMentions: { parse: [] },
      });
      await doc.ref.update({
        notified: true,
        notificationMessageId: message.id,
        notificationChannelId: channel.id,
        notifiedAt: serverTimestamp(),
        notificationLeaseOwner: null,
        notificationLeaseUntil: null,
        updatedAt: serverTimestamp(),
      });
      sent += 1;
    } catch (error) {
      await releaseFailedClaim(doc.ref, workerId, db);
      console.error(`[buildReports] failed to notify ${doc.id}:`, error.message);
    }
  }
  return { status: 'ok', checked: snapshot.size, sent };
}

export async function listOpenBuildReports({ db = getDb(), limit = 10 } = {}) {
  const snapshot = await db.collection('buildReports').where('status', '==', 'open').limit(Math.max(1, Math.min(limit, 20))).get();
  return snapshot.docs
    .map((doc) => ({ reportId: doc.id, ...doc.data() }))
    .sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt));
}

export async function resolveBuildReport({ reportId, moderatorId, resolution, note = null, db = getDb() }) {
  const id = assertReportId(reportId);
  if (!['resolved', 'dismissed'].includes(resolution)) throw new Error('Invalid report resolution');
  if (typeof moderatorId !== 'string' || !/^\d{17,20}$/.test(moderatorId)) throw new Error('Invalid moderator ID');
  const cleanNote = note == null ? null : String(note).trim().slice(0, 500) || null;
  const ref = db.collection('buildReports').doc(id);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new Error('Report not found');
    const report = snap.data();
    if (report.status !== 'open') throw new Error('Report is already closed');
    transaction.update(ref, {
      status: resolution,
      resolutionNote: cleanNote,
      resolvedBy: moderatorId,
      resolvedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { reportId: id, buildId: report.buildId, status: resolution };
  });
}

export function startBuildReportNotifier(client) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await notifyPendingBuildReports(client);
      if (result.sent) console.log(`[buildReports] sent ${result.sent} moderator alert${result.sent === 1 ? '' : 's'}`);
    } catch (error) {
      console.error('[buildReports] notification poll failed:', error.message);
    } finally {
      running = false;
    }
  };
  run();
  const timer = setInterval(run, POLL_MS);
  timer.unref?.();
  return timer;
}
