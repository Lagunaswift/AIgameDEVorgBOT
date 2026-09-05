// Phase 3 — migrate existing public data into Project records.
//
// Operator-run administrative script (never bot startup, scheduled export, or a slash
// command). Creates exactly ONE Project per currently published showcase Thread by
// reproducing the exporter's publication boundary (Firestore mode query + live Discord
// channel/source-forum/guild state + Publish-to-site tag consent), copying only
// deterministic metadata, and setting thread.projectId + project.profileThreadId
// atomically in one Firestore transaction per record.
//
// Usage:
//   dry-run (default, read-only):
//     node scripts/migrate-projects.mjs [--baseline ../AIGameDevSite/src/data/showcase.json] [--out .migration]
//   apply (production writes; requires the reviewed plan):
//     node scripts/migrate-projects.mjs --apply --plan .migration/plan-<ts>.json \
//          --firebase-project <projectId> --database '(default)'
//
// Exit codes: 0 = plan clean; 2 = plan produced but blocked/conflict records exist
// (apply is refused); 1 = hard error.

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REST } from 'discord.js';
import { config } from '../src/config.js';
import { getDb, getFirebaseProjectId, initFirebase, serverTimestamp } from '../src/firebase.js';
import { normalizeProjectUrl } from '../src/lib/publicMetadata.js';
import {
  applyMigrationRecordTransaction,
  planMigration,
  platformsFromTagNames,
} from '../src/services/migration.js';
import { parsePublishTagId, readJson } from './site-export-safety.mjs';
import {
  checkShowcaseEligibility,
  extractText,
  getChannel,
  getForumTagMap,
  getStarterMessage,
  isDirectRun,
  isMissingResource,
  truncate,
} from './site-export-shared.mjs';

const PLAN_VERSION = 2;

// ---------- CLI args ----------

function parseArgs(argv) {
  const args = {
    baseline: null, out: '.migration',
    apply: false, plan: null, firebaseProject: null, database: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--baseline') args.baseline = argv[i += 1];
    else if (arg.startsWith('--baseline=')) args.baseline = arg.slice('--baseline='.length);
    else if (arg === '--out') args.out = argv[i += 1];
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--plan') args.plan = argv[i += 1];
    else if (arg.startsWith('--plan=')) args.plan = arg.slice('--plan='.length);
    else if (arg === '--firebase-project') args.firebaseProject = argv[i += 1];
    else if (arg.startsWith('--firebase-project=')) args.firebaseProject = arg.slice('--firebase-project='.length);
    else if (arg === '--database') args.database = argv[i += 1];
    else if (arg.startsWith('--database=')) args.database = arg.slice('--database='.length);
    else throw new Error(`migrate-projects: unknown argument ${arg}`);
  }
  return args;
}

function validateEnv(args) {
  const missing = [];
  if (!config.discordToken) missing.push('DISCORD_TOKEN');
  if (!config.firebaseServiceAccount) missing.push('FIREBASE_SERVICE_ACCOUNT');
  if (!config.guildId) missing.push('GUILD_ID');
  if (args.apply) {
    if (!args.plan) missing.push('--plan');
    if (!args.firebaseProject) missing.push('--firebase-project');
    if (!args.database) missing.push('--database');
  }
  if (missing.length) {
    throw new Error(`migrate-projects: missing required value(s): ${missing.join(', ')}`);
  }
  return parsePublishTagId(process.env.SITE_PUBLISH_TAG_ID);
}

// ---------- preflight: build the candidate plan (read-only) ----------

async function buildCandidates(db, rest, publishTagId) {
  const threadsSnap = await db.collection('threads').where('mode', '==', 'showcase').get();
  const threadDocs = threadsSnap.docs;

  const sourceForumIds = new Set();
  for (const docSnap of threadDocs) {
    const forumId = docSnap.data().forumId;
    if (!forumId || !/^\d{17,20}$/.test(forumId)) {
      throw new Error(`showcase thread ${docSnap.id} has no valid source forum id`);
    }
    sourceForumIds.add(forumId);
  }

  const forumTagCache = new Map();
  for (const forumId of sourceForumIds) {
    let tags;
    try {
      tags = await getForumTagMap(rest, forumId, forumTagCache);
    } catch (err) {
      if (isMissingResource(err)) {
        console.warn(`[migrate] warn: forum ${forumId} no longer exists; its threads will be excluded`);
        sourceForumIds.delete(forumId);
        continue;
      }
      throw err;
    }
    if (!tags.has(publishTagId)) {
      throw new Error(`SITE_PUBLISH_TAG_ID is not available in showcase forum ${forumId}`);
    }
  }

  const candidates = [];
  const excluded = [];
  for (const docSnap of threadDocs) {
    const threadId = docSnap.id;
    const data = docSnap.data();

    let channel = null;
    try {
      channel = await getChannel(rest, threadId);
    } catch (err) {
      if (!isMissingResource(err)) throw err;
    }

    const eligibility = checkShowcaseEligibility({ channel, firestoreData: data, sourceForumIds, publishTagId });
    if (eligibility.status !== 'ok') {
      excluded.push({ threadId, disposition: 'excluded', reason: eligibility.status, eligibility });
      continue;
    }

    // Guild boundary (F11): a channel in a different guild than the one this deployment
    // serves is not migration input, no matter what the Firestore record says.
    if (channel.guild_id && channel.guild_id !== config.guildId) {
      excluded.push({
        threadId, disposition: 'excluded', reason: 'wrong-guild',
        eligibility: { ...eligibility, channelGuildId: channel.guild_id },
      });
      continue;
    }

    const tagMap = await getForumTagMap(rest, eligibility.forumId, forumTagCache);
    const appliedTags = channel.applied_tags.map((id) => {
      const tag = tagMap.get(id);
      if (!tag) throw new Error(`showcase thread ${threadId} has an unknown tag ${id}`);
      return tag;
    });
    const tagNames = appliedTags.map((tag) => tag.name);

    // Exporter-equivalent public title/description (site-export-shared normalisation).
    const title = truncate((channel.name || data.title || '').trim(), 120);
    const starterMessage = await getStarterMessage(rest, threadId);
    const summary = extractText(starterMessage, 280);

    // Owner: registered owner wins, live Discord owner as fallback; a disagreement
    // between the two is an ambiguity that blocks the record rather than guessing.
    const ownerConflict = Boolean(data.ownerId && channel.owner_id && data.ownerId !== channel.owner_id);
    const ownerId = ownerConflict ? null : (data.ownerId || channel.owner_id || null);

    const rawProjectUrl = data.projectUrl ?? null;
    const projectUrl = rawProjectUrl == null ? null : normalizeProjectUrl(rawProjectUrl);

    const { platforms, ignored } = platformsFromTagNames(tagNames);

    const extraBlockers = [];
    if (ownerConflict) {
      extraBlockers.push({ field: 'ownerId', reason: 'registered owner differs from live Discord owner', provenance: 'thread.ownerId vs channel.owner_id' });
    }
    // F12: a consent-tagged public thread whose starter content cannot be read is a
    // completeness blocker (matching the exporter's hard error), not an exclusion —
    // inability to read currently public material is not evidence it should be skipped.
    if (!starterMessage) {
      extraBlockers.push({ field: 'summary', reason: 'starter message inaccessible; cannot derive the public description', provenance: 'starter message' });
    }

    candidates.push({
      threadId,
      thread: data,
      eligibility: {
        ...eligibility,
        consentTag: true,
        ownerSource: data.ownerId ? 'thread.ownerId' : 'channel.owner_id',
        jamThreadId: data.jamId ?? null,
      },
      // Snapshot of the Firestore-side source fields the transaction revalidates.
      expectedThread: {
        mode: data.mode ?? null,
        forumId: data.forumId ?? null,
        projectUrl: rawProjectUrl,
      },
      title,
      summary,
      ownerId,
      projectUrl,
      projectUrlInvalid: rawProjectUrl != null && projectUrl == null,
      platforms,
      unknownTags: ignored,
      extraBlockers,
    });
  }

  return { candidates, excluded };
}

async function loadExistingProjects(db) {
  const snap = await db.collection('projects').get();
  // _docId keeps the physical document id so identity can be validated instead of
  // trusting the embedded field (F9).
  return snap.docs.map((d) => ({ ...d.data(), _docId: d.id }));
}

// ---------- baseline reconciliation ----------

// The baseline (site showcase.json) is an ID-set cross-check ONLY — never a consent
// authority, an input database, or a metadata/asset equality proof (that comparison
// happens post-apply against a fresh export). Differences are reported with the
// disposition evidence we actually have; no publication history is invented.
function reconcileBaseline(baseline, plan) {
  if (!baseline) return { supplied: false, differences: [] };
  const byThreadId = new Map([
    ...plan.records.map((r) => [r.threadId, r]),
    ...plan.excluded.map((r) => [r.threadId, r]),
  ]);
  const plannedIds = new Set(byThreadId.keys());
  const baselineIds = new Set((baseline.games || []).map((game) => game.id));

  const differences = [];
  for (const id of baselineIds) {
    if (!plannedIds.has(id)) {
      differences.push({
        threadId: id, difference: 'in-baseline-but-not-eligible',
        explanation: 'not in the current showcase Firestore set; cause not established by this preflight',
      });
    } else {
      const record = byThreadId.get(id);
      if (record.disposition !== 'create' && record.disposition !== 'already-linked') {
        differences.push({
          threadId: id, difference: 'baseline-public-but-not-migratable',
          explanation: `${record.disposition}${record.reason ? `: ${record.reason}` : ''}${record.blockers?.length ? `: ${JSON.stringify(record.blockers)}` : ''}`,
        });
      }
    }
  }
  for (const id of plannedIds) {
    if (!baselineIds.has(id)) {
      const record = byThreadId.get(id);
      differences.push({
        threadId: id, difference: `${record.disposition}-but-not-in-baseline`,
        explanation: 'absent from the supplied baseline; no publication history inferred',
      });
    }
  }
  return {
    supplied: true,
    differences,
    scope: 'id-set cross-check only; metadata/asset equality is established post-apply by export comparison, not here',
  };
}

// ---------- plan assembly ----------

function assemblePlan({ db, target, publishTagId, candidates, excluded, existingProjects, baseline, replayIds, statusSources }) {
  // F3: during apply, planned ids are REPLAYED from the reviewed plan rather than
  // regenerated, so a fresh preflight of unchanged state produces an identical plan
  // instead of false drift. Fresh random ids are allocated only in dry-run mode.
  const replay = replayIds instanceof Map ? replayIds : null;
  const allocated = new Set();
  const freshId = () => db.collection('projects').doc().id;
  const allocateProjectId = (candidate) => {
    const replayed = replay ? replay.get(candidate.threadId) : undefined;
    if (replayed != null && !allocated.has(replayed)) {
      allocated.add(replayed);
      return replayed;
    }
    let id = freshId();
    while (allocated.has(id)) id = freshId();
    allocated.add(id);
    return id;
  };

  const planned = planMigration({
    candidates,
    existingProjects,
    allocateProjectId,
    // Undefined in production: the frozen empty registry applies (status gate closed).
    // Injectable so tests can exercise the create path with a simulated structured
    // source without weakening the production gate.
    ...(statusSources ? { statusSources } : {}),
  });

  const counts = {
    ...planned.counts,
    excluded: excluded.length,
    baselineGames: baseline ? (baseline.games || []).length : null,
  };

  return {
    version: PLAN_VERSION,
    mode: replay ? 'apply-preflight' : 'dry-run',
    createdAt: new Date().toISOString(),
    target,
    publishTagId,
    counts,
    baseline: reconcileBaseline(baseline, { records: planned.records, excluded }),
    records: planned.records,
    excluded,
  };
}

function summarise(plan) {
  const lines = [
    '=== migrate-projects preflight ===',
    `target: ${plan.target.firebaseProject} / ${plan.target.database}`,
    `counts: ${JSON.stringify(plan.counts)}`,
  ];
  for (const record of plan.records) {
    if (record.disposition === 'create') {
      lines.push(`create         ${record.threadId} -> ${record.plannedProjectId} slug=${record.slug}`);
    } else if (record.disposition === 'already-linked') {
      lines.push(`already-linked ${record.threadId} -> ${record.plannedProjectId}`);
    } else if (record.disposition === 'blocked') {
      lines.push(`blocked        ${record.threadId} ${JSON.stringify(record.blockers)}`);
    } else if (record.disposition === 'conflict') {
      lines.push(`conflict       ${record.threadId} ${record.reason}`);
    }
  }
  for (const record of plan.excluded) {
    lines.push(`excluded       ${record.threadId} ${record.reason}`);
  }
  if (plan.baseline.supplied) {
    for (const diff of plan.baseline.differences) {
      lines.push(`baseline-diff  ${diff.threadId} ${diff.difference} (${diff.explanation})`);
    }
  }
  return lines.join('\n');
}

// ---------- apply ----------

function planIsApplicable(plan) {
  if (!plan || plan.version !== PLAN_VERSION) {
    throw new Error(`plan version ${plan?.version} is not supported by this build (expected ${PLAN_VERSION}); regenerate the plan`);
  }
  if (plan.counts.blocked > 0) throw new Error(`reviewed plan has ${plan.counts.blocked} blocked record(s); apply is refused`);
  if (plan.counts.conflict > 0) throw new Error(`reviewed plan has ${plan.counts.conflict} conflict record(s); apply is refused`);
}

function diffPlans(reviewed, fresh) {
  const key = (record) => `${record.threadId}|${record.disposition}|${record.plannedProjectId ?? ''}|${record.slug ?? ''}`;
  const reviewedKeys = new Set(reviewed.records.map(key).concat(reviewed.excluded.map((r) => `${r.threadId}|excluded|`)));
  const freshKeys = new Set(fresh.records.map(key).concat(fresh.excluded.map((r) => `${r.threadId}|excluded|`)));
  const changed = [...reviewedKeys].filter((k) => !freshKeys.has(k)).concat([...freshKeys].filter((k) => !reviewedKeys.has(k)));
  if (changed.length) return changed;
  const reviewedCreates = new Map(reviewed.records.filter((r) => r.disposition === 'create').map((r) => [r.threadId, r]));
  for (const freshRecord of fresh.records.filter((r) => r.disposition === 'create')) {
    const reviewedRecord = reviewedCreates.get(freshRecord.threadId);
    if (JSON.stringify(reviewedRecord?.metadata) !== JSON.stringify(freshRecord.metadata)) {
      return [`${freshRecord.threadId}|metadata-drift`];
    }
    if (JSON.stringify(reviewedRecord?.expectedThread) !== JSON.stringify(freshRecord.expectedThread)) {
      return [`${freshRecord.threadId}|source-state-drift`];
    }
  }
  return [];
}

// Live consent + source recheck for one record, immediately before its transaction.
// Rechecks the full eligibility boundary (channel exists, parent forum unchanged,
// applied_tags present, publish tag applied) — not just the tag bit. The transaction
// guards Firestore state; this guards the Discord side as closely as a REST read allows.
async function consentStillActive(rest, record, publishTagId) {
  let channel;
  try {
    channel = await getChannel(rest, record.threadId);
  } catch (err) {
    if (isMissingResource(err)) return false;
    throw err;
  }
  if (channel.guild_id && channel.guild_id !== config.guildId) return false;
  const eligibility = checkShowcaseEligibility({
    channel,
    firestoreData: { forumId: record.eligibility?.forumId ?? record.expectedThread?.forumId },
    sourceForumIds: new Set([record.eligibility?.forumId ?? record.expectedThread?.forumId]),
    publishTagId,
  });
  return eligibility.status === 'ok';
}

// F5: every stop path after (or during) the record loop leaves a structured report of
// what committed and what failed; a failure to WRITE the report never masks the
// original error — it is appended to the thrown message.
async function writeFailureReport(outDir, payload) {
  const reportPath = path.join(outDir, `apply-failed-${Date.now()}.json`);
  try {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`);
    return reportPath;
  } catch (writeErr) {
    throw new Error(`${payload.error} — additionally, the failure report could not be written to ${reportPath}: ${writeErr.message}; committed records: ${JSON.stringify(payload.outcomes)}`);
  }
}

async function applyPlan({ db, rest, reviewed, fresh, publishTagId, outDir }) {
  planIsApplicable(reviewed);
  planIsApplicable(fresh);

  // F4: the approval is bound to the reviewed plan's target environment and consent
  // configuration — a plan reviewed against a different Firebase project, database, or
  // publish tag than the current live ones is not this approval.
  if (JSON.stringify(reviewed.target) !== JSON.stringify(fresh.target)) {
    throw new Error(`reviewed plan target ${JSON.stringify(reviewed.target)} does not match live target ${JSON.stringify(fresh.target)}; refusing to apply`);
  }
  if (reviewed.publishTagId !== fresh.publishTagId || reviewed.publishTagId !== publishTagId) {
    throw new Error(`reviewed plan publishTagId ${reviewed.publishTagId} does not match the current consent tag ${publishTagId}; refusing to apply`);
  }

  const drift = diffPlans(reviewed, fresh);
  if (drift.length) {
    throw new Error(`live state no longer matches the reviewed plan (stale): ${drift.join(', ')}`);
  }

  const outcomes = [];
  for (const record of fresh.records) {
    if (record.disposition !== 'create') continue;

    try {
      if (!(await consentStillActive(rest, record, publishTagId))) {
        throw new Error('thread lost Publish-to-site consent (or source/guild state changed) immediately before apply');
      }

      const threadRef = db.collection('threads').doc(record.threadId);
      const projectRef = db.collection('projects').doc(record.plannedProjectId);
      const project = await db.runTransaction((transaction) => applyMigrationRecordTransaction({
        transaction, threadRef, projectRef, planRecord: record, timestamp: serverTimestamp(),
      }));
      outcomes.push({ threadId: record.threadId, projectId: record.plannedProjectId, result: 'committed' });
      console.log(`[migrate] committed ${record.threadId} -> ${record.plannedProjectId} (${project.slug})`);
    } catch (err) {
      outcomes.push({ threadId: record.threadId, projectId: record.plannedProjectId, result: 'failed', error: err.message });
      const reportPath = await writeFailureReport(outDir, {
        version: 1, stoppedAt: record.threadId, error: err.message, outcomes,
      });
      throw new Error(`apply failed at ${record.threadId}: ${err.message} — already committed records are listed in ${reportPath}; rerun preflight to produce a fresh plan and apply again`);
    }
  }
  return outcomes;
}

// ---------- main ----------

async function run({ db, rest, publishTagId, args }) {
  const target = {
    // F2: project identity comes from the initialised service-account credential (public
    // `project_id` claim), never from SDK internals like db.app.
    firebaseProject: getFirebaseProjectId(),
    database: typeof db.databaseId === 'string' ? db.databaseId : '(default)',
  };

  let baseline = null;
  if (args.baseline) {
    baseline = await readJson(args.baseline);
    if (baseline.version !== 2 || !Array.isArray(baseline.games)) {
      throw new Error('baseline file must be a v2 showcase.json (games array)');
    }
  }

  const { candidates, excluded } = await buildCandidates(db, rest, publishTagId);
  const existingProjects = await loadExistingProjects(db);

  if (!args.apply) {
    const fresh = assemblePlan({ db, target, publishTagId, candidates, excluded, existingProjects, baseline });
    await fs.mkdir(args.out, { recursive: true });
    const planPath = path.join(args.out, `plan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await fs.writeFile(planPath, `${JSON.stringify(fresh, null, 2)}\n`);
    console.log(summarise(fresh));
    console.log(`\nplan written: ${planPath}`);
    if (fresh.counts.blocked > 0 || fresh.counts.conflict > 0) process.exitCode = 2;
    return { plan: fresh, planPath };
  }

  // Apply path: verify the explicit target, then require the live state to still match
  // the reviewed plan (with the reviewed plan's own ids replayed) before any write.
  if (args.firebaseProject !== target.firebaseProject || args.database !== target.database) {
    throw new Error(
      `target mismatch: credentials point at ${target.firebaseProject}/${target.database}, ` +
      `--firebase-project/--database say ${args.firebaseProject}/${args.database}; refusing to apply`,
    );
  }
  const reviewed = await readJson(args.plan);
  planIsApplicable(reviewed);
  const replayIds = new Map(
    reviewed.records.filter((r) => r.disposition === 'create').map((r) => [r.threadId, r.plannedProjectId]),
  );
  const fresh = assemblePlan({ db, target, publishTagId, candidates, excluded, existingProjects, baseline, replayIds });
  const outcomes = await applyPlan({ db, rest, reviewed, fresh, publishTagId, outDir: args.out });

  const reportPath = path.join(args.out, `apply-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  try {
    await fs.mkdir(args.out, { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify({ version: 1, target, outcomes }, null, 2)}\n`);
  } catch (writeErr) {
    // All records committed safely; only the report failed. Surface outcomes inline.
    throw new Error(`apply committed ${outcomes.length} record(s) but the final report could not be written to ${reportPath}: ${writeErr.message} — outcomes: ${JSON.stringify(outcomes)}`);
  }
  console.log(`[migrate] apply complete: ${outcomes.filter((o) => o.result === 'committed').length} committed, report: ${reportPath}`);
  return { outcomes, reportPath };
}

export { buildCandidates, assemblePlan, applyPlan, run, reconcileBaseline, diffPlans, consentStillActive, PLAN_VERSION };

if (isDirectRun(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    console.error(`[migrate] error: ${err.message}`);
    process.exit(1);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const publishTagId = validateEnv(args);
  args.out = path.resolve(args.out);

  initFirebase();
  const db = getDb();
  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  await run({ db, rest, publishTagId, args });
}
