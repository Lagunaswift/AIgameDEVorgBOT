// Phase 3 migration core: pure decision logic + transactional apply, dependency-injected
// like the Phase 2 services so tests never touch Firebase or Discord.
//
// Architecture rules this encodes (docs/AIGAMEDEV Community Platform Architecture &
// Implementation Plan.md):
//   §22    Project identity is an opaque Firestore doc id — never a threadId/title/URL/owner.
//   §23    status/platforms are explicit structured values; never inferred from prose.
//   §27    one Project ↔ zero-or-many Threads; a Thread belongs to zero-or-one Project.
//   §29/30 deterministic migration: ONE Project per existing published Thread, copy only
//          deterministic metadata, publishToSite=true only because the thread already had
//          explicit Publish-to-site consent.
//   §31    private threads are never auto-published.
//   §71    structured state must come from explicit sources, not prose.

import {
  PROJECT_PLATFORMS,
  assertDiscordId,
  normalizeNullableProfileThreadId,
  normalizeProjectInput,
  normalizeProjectSlug,
} from '../lib/projectValidation.js';

export const MIGRATION_SCHEMA_SOURCES = Object.freeze([
  // Explicit structured sources a migrated Project's required `status` may come from.
  // The Phase 2 data model has none: the Thread schema carries no status field, Discord
  // tags carry none, and the site export contract carries none. When a real source is
  // added (e.g. a dedicated structured tag or /mygame backfill), register it here —
  // nothing else may relax this gate.
]);

// ---------- status gate ----------

// Returns { status, source } or { status: null, source: 'none' }. Absent, invalid, or
// ambiguous structured status must BLOCK the record (fail closed) — never defaulted.
// `sources` is injectable for tests; production callers use the frozen registry above.
export function deriveProjectStatus(firestoreThread, sources = MIGRATION_SCHEMA_SOURCES) {
  const found = [];
  for (const source of sources) {
    const value = source.read(firestoreThread);
    if (value != null) found.push({ source: source.name, value });
  }
  if (found.length === 0) return { status: null, source: 'none' };
  if (found.length > 1 && new Set(found.map((f) => f.value)).size > 1) {
    return { status: null, source: 'ambiguous', candidates: found };
  }
  const [first] = found;
  return { status: first.value, source: first.source };
}

// ---------- slugs ----------

export function slugifyBase(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // strip combining marks revealed by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
}

// Resolves one slug against the taken set (existing Project slugs + slugs already
// planned in this run). Returns the slug or null when even the projectId-suffixed
// candidate is occupied — the caller must block that record.
export function resolveSlug({ base, projectId, taken }) {
  const id = String(projectId).toLowerCase();
  // A free base longer than 100 is clamped (production callers pre-clamp via
  // slugifyBase; this guards direct/injected use).
  const clamped = base ? base.slice(0, 100).replace(/-+$/g, '') : '';
  const candidate = clamped && !taken.has(clamped)
    ? clamped
    : `${clamped ? `${clamped.slice(0, Math.max(0, 100 - id.length - 1)).replace(/-+$/g, '')}-` : 'project-'}${id}`;
  if (candidate.length > 100 || taken.has(candidate)) return null;
  return candidate;
}

// ---------- platforms ----------

// Exact recognised enum names only (trim + case-normalised), deduplicated and emitted in
// canonical enum order. Unknown tags are reported, never coerced to "other" and never
// inferred from prose or URLs.
export function platformsFromTagNames(tagNames) {
  const recognised = new Set(PROJECT_PLATFORMS);
  const seen = new Set();
  const ignored = [];
  for (const raw of tagNames || []) {
    const name = String(raw || '').trim().toLowerCase();
    if (!name) continue;
    if (recognised.has(name)) {
      seen.add(name);
    } else {
      ignored.push(String(raw));
    }
  }
  return {
    platforms: PROJECT_PLATFORMS.filter((platform) => seen.has(platform)),
    ignored,
  };
}

// ---------- record construction ----------

// Migration-only record builder. Unlike the ordinary createProject path (which always
// creates unpublished Projects with no profile thread), this carries the explicit
// publish consent the thread already gave via the Publish-to-site tag (§30) and the
// profile thread backlink to the original published thread.
export function buildMigrationProjectRecord({ projectId, ownerId, title, slug, summary, status, projectUrl, platforms, profileThreadId, timestamp }) {
  const input = normalizeProjectInput({
    ownerId, title, slug, summary, status, projectUrl, platforms,
  });
  const normalizedSlug = normalizeProjectSlug(input.slug);
  return {
    projectId,
    ...input,
    slug: normalizedSlug,
    publishToSite: true,
    profileThreadId: normalizeNullableProfileThreadId(profileThreadId),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

// ---------- planning ----------

function blockersForMetadata({ ownerId, title, summary, projectUrlInvalid, statusDerivation }) {
  const blockers = [];
  if (!ownerId) blockers.push({ field: 'ownerId', reason: 'missing', provenance: 'thread.ownerId/channel.owner_id' });
  if (!title || !String(title).trim()) blockers.push({ field: 'title', reason: 'missing', provenance: 'channel.name/thread.title' });
  if (!summary || !String(summary).trim()) blockers.push({ field: 'summary', reason: 'missing', provenance: 'starter message public description' });
  if (projectUrlInvalid) blockers.push({ field: 'projectUrl', reason: 'invalid http(s) URL', provenance: 'thread.projectUrl' });
  if (statusDerivation.status == null) {
    blockers.push({
      field: 'status',
      reason: statusDerivation.source === 'ambiguous' ? 'ambiguous structured sources' : 'no explicit structured status source exists',
      provenance: 'thread schema/Discord tags/export contract',
      ...(statusDerivation.candidates ? { candidates: statusDerivation.candidates } : {}),
    });
  }
  return blockers;
}

// Builds the full migration plan from eligible candidates plus existing Project state.
// Every candidate gets exactly one disposition:
//   create         — eligible, all metadata valid, no existing relationship
//   already-linked — existing consistent one-to-one backlink/profile/owner: no-op
//   blocked        — metadata gate failed (fail closed; apply is refused while any exist)
//   conflict       — inconsistent existing state; never auto-repaired
export function planMigration({ candidates, existingProjects, allocateProjectId, statusSources }) {
  const plans = [];
  const takenSlugs = new Set(existingProjects.map((project) => project.slug).filter(Boolean));
  const projectByLinkedThreadId = new Map(
    existingProjects.filter((project) => project.profileThreadId != null)
      .map((project) => [project.profileThreadId, project]),
  );

  // Stable thread-ID order (snowflake ascending) so slug allocation is deterministic.
  const ordered = [...candidates].sort((a, b) => {
    const an = /^\d+$/.test(a.threadId);
    const bn = /^\d+$/.test(b.threadId);
    if (an && bn) {
      const ab = BigInt(a.threadId);
      const bb = BigInt(b.threadId);
      if (ab < bb) return -1;
      if (ab > bb) return 1;
      return 0;
    }
    return String(a.threadId).localeCompare(String(b.threadId));
  });

  for (const candidate of ordered) {
    const record = {
      threadId: candidate.threadId,
      disposition: null,
      eligibility: candidate.eligibility || null,
      metadata: null,
      plannedProjectId: null,
      slug: null,
      unknownTags: candidate.unknownTags || [],
      blockers: [],
      reason: null,
    };

    const existing = candidate.thread.projectId != null
      ? existingProjects.find((project) => project.projectId === candidate.thread.projectId)
      : undefined;

    if (candidate.thread.projectId != null && !existing) {
      record.disposition = 'conflict';
      record.reason = `thread.projectId ${candidate.thread.projectId} points at a missing Project (dangling link)`;
      plans.push(record);
      continue;
    }

    if (existing) {
      const inconsistent = [];
      if (existing.profileThreadId !== candidate.threadId) {
        inconsistent.push(`profileThreadId ${existing.profileThreadId} does not point back at this thread`);
      }
      if (existing.ownerId !== candidate.ownerId) {
        inconsistent.push('Project owner differs from the live thread owner');
      }
      if (existing.publishToSite !== true) {
        inconsistent.push(`Project publishToSite is ${existing.publishToSite}; migration never republishes an existing Project`);
      }
      if (inconsistent.length) {
        record.disposition = 'conflict';
        record.reason = inconsistent.join('; ');
        record.plannedProjectId = existing.projectId;
        plans.push(record);
        continue;
      }
      record.disposition = 'already-linked';
      record.plannedProjectId = existing.projectId;
      record.slug = existing.slug;
      plans.push(record);
      continue;
    }

    const claimedBy = projectByLinkedThreadId.get(candidate.threadId);
    if (claimedBy) {
      record.disposition = 'conflict';
      record.reason = `Project ${claimedBy.projectId} claims this thread as its profile thread while the thread has no backlink`;
      record.plannedProjectId = claimedBy.projectId;
      plans.push(record);
      continue;
    }

    const statusDerivation = deriveProjectStatus(candidate.thread, statusSources);
    const blockers = [
      ...blockersForMetadata({
        ownerId: candidate.ownerId,
        title: candidate.title,
        summary: candidate.summary,
        projectUrlInvalid: Boolean(candidate.projectUrlInvalid),
        statusDerivation,
      }),
      ...(candidate.extraBlockers || []),
    ];
    if (blockers.length) {
      record.disposition = 'blocked';
      record.blockers = blockers;
      plans.push(record);
      continue;
    }

    const plannedProjectId = allocateProjectId(candidate);
    const base = slugifyBase(candidate.title);
    const slug = resolveSlug({ base, projectId: plannedProjectId, taken: takenSlugs });
    if (!slug) {
      record.disposition = 'blocked';
      record.plannedProjectId = plannedProjectId;
      record.blockers = [{ field: 'slug', reason: 'slug collision not resolvable', provenance: `base "${base}"` }];
      plans.push(record);
      continue;
    }

    record.disposition = 'create';
    record.plannedProjectId = plannedProjectId;
    record.slug = slug;
    record.metadata = {
      ownerId: candidate.ownerId,
      title: candidate.title,
      slug,
      summary: candidate.summary,
      status: statusDerivation.status,
      projectUrl: candidate.projectUrl ?? null,
      platforms: candidate.platforms,
      profileThreadId: candidate.threadId,
    };
    takenSlugs.add(slug);
    plans.push(record);
  }

  return {
    records: plans,
    counts: {
      create: plans.filter((p) => p.disposition === 'create').length,
      alreadyLinked: plans.filter((p) => p.disposition === 'already-linked').length,
      blocked: plans.filter((p) => p.disposition === 'blocked').length,
      conflict: plans.filter((p) => p.disposition === 'conflict').length,
    },
  };
}

// ---------- transactional apply ----------

// One record = one transaction: the Project doc is created and the original thread's
// projectId backlink is written atomically. All validation happens inside the
// transaction against freshly read state, so a concurrent attempt (or state changed
// after planning) fails closed instead of duplicating a Project.
export async function applyMigrationRecordTransaction({
  transaction, threadRef, projectRef, planRecord, timestamp,
}) {
  const [threadSnap, projectSnap] = await Promise.all([transaction.get(threadRef), transaction.get(projectRef)]);
  if (!threadSnap.exists) throw new Error(`thread ${planRecord.threadId} disappeared before apply`);
  if (projectSnap.exists) throw new Error(`planned Project id ${planRecord.plannedProjectId} is already occupied`);

  const thread = threadSnap.data();
  if (thread.projectId != null && thread.projectId !== planRecord.plannedProjectId) {
    throw new Error(`thread ${planRecord.threadId} is already linked to Project ${thread.projectId}`);
  }
  const ownerId = assertDiscordId(planRecord.metadata.ownerId, 'owner ID');
  if (thread.ownerId != null && thread.ownerId !== ownerId) {
    throw new Error(`thread ${planRecord.threadId} owner changed since planning`);
  }

  const project = buildMigrationProjectRecord({
    projectId: planRecord.plannedProjectId,
    ...planRecord.metadata,
    timestamp,
  });

  transaction.set(projectRef, project);
  // Only the backlink is written; every other Thread field (purpose, scoring identity,
  // jam linkage) is preserved untouched.
  transaction.update(threadRef, { projectId: planRecord.plannedProjectId });
  return project;
}
