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
//
// TRANSACTION SCOPE (honest limits): one transaction guards exactly one (thread, planned
// Project doc) pair — creation plus backlink. It does NOT detect competing slugs or
// profile-thread claims introduced by concurrent unrelated Project writers between
// preflight and commit; preventing those is an explicit operator precondition for
// --apply (see docs/phase3-migration.md), not something this code guarantees.

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
// Values found here are NOT trusted: the full Project validator runs in preflight, so
// an unrecognised value (e.g. "beta") becomes a per-record blocker.
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

// Validates a pre-existing Project document (physical Firestore doc id + stored data).
// Returns an array of issues — empty means the record satisfies the full Phase 2
// contract, so relying on it for already-linked/conlict decisions is safe.
export function existingProjectIssues(project) {
  const issues = [];
  const docId = project && project._docId;
  if (!docId) issues.push('missing physical document id');
  try {
    const input = normalizeProjectInput({
      ownerId: project.ownerId,
      title: project.title,
      slug: project.slug,
      summary: project.summary,
      status: project.status,
      projectUrl: project.projectUrl,
      platforms: project.platforms,
    });
    if (project.projectId !== docId) {
      issues.push(`embedded projectId ${project.projectId} does not match document id ${docId}`);
    }
    if (input.slug !== project.slug) issues.push('stored slug is not canonical');
    if (typeof project.publishToSite !== 'boolean') issues.push('publishToSite is not a boolean');
    if (project.profileThreadId != null) assertDiscordId(project.profileThreadId, 'profile thread ID');
    if (project.createdAt == null || project.updatedAt == null) issues.push('missing timestamps');
  } catch (err) {
    issues.push(err.message);
  }
  return issues;
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
  // Keep physical occupancy independent from validation diagnostics. A malformed
  // Firestore document remains a real occupied document until an operator repairs it.
  const existingProjectList = [...(existingProjects || [])].sort((a, b) => {
    const aKey = `${a?._docId ?? ''}\u0000${a?.projectId ?? ''}`;
    const bKey = `${b?._docId ?? ''}\u0000${b?.projectId ?? ''}`;
    return aKey.localeCompare(bKey);
  });
  const validProjects = new Map();
  const invalidProjects = new Map(); // embedded/physical project id -> Set<issue>
  const addInvalidProject = (identifiers, issue) => {
    for (const id of identifiers.filter((value) => value != null)) {
      const issues = invalidProjects.get(id) || new Set();
      issues.add(issue);
      invalidProjects.set(id, issues);
    }
  };
  const invalidIssue = (id) => [...(invalidProjects.get(id) || [])].sort().join('; ');
  for (const project of existingProjectList) {
    const issues = existingProjectIssues(project);
    const key = project._docId;
    const identifiers = [project._docId, project.projectId];
    if (issues.length) {
      // Index malformed records by both identities. A mismatched embedded id must not
      // hide the physical Firestore document from backlink or planned-id checks.
      addInvalidProject(identifiers, issues.join('; '));
      continue;
    }
    validProjects.set(key, project);
  }
  const profileClaims = new Map(); // profileThreadId -> [{ id, identifiers }]
  // Claims made by malformed records still occupy a profile thread. Index every
  // physical Project so an invalid claimant cannot be silently ignored.
  for (const project of existingProjectList) {
    if (project.profileThreadId == null) continue;
    let threadId;
    try {
      threadId = assertDiscordId(project.profileThreadId, 'profile thread ID');
    } catch {
      continue;
    }
    const identifiers = [project._docId, project.projectId];
    const claims = profileClaims.get(threadId) || [];
    claims.push({ id: project._docId ?? project.projectId ?? '(unknown Project)', identifiers });
    profileClaims.set(threadId, claims);
  }
  for (const [threadId, claims] of profileClaims) {
    claims.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (claims.length > 1) {
      const issue = `profile thread ${threadId} is claimed by multiple Projects (${claims.map((claim) => claim.id).join(', ')})`;
      for (const claim of claims) {
        addInvalidProject(claim.identifiers, issue);
        validProjects.delete(claim.id);
      }
    }
  }

  const plans = [];
  // Malformed records still physically store their slugs and document ids. Reserve
  // both before planning so preflight cannot create collisions that apply discovers
  // only after operator approval.
  const takenSlugs = new Set();
  for (const project of existingProjectList) {
    try {
      takenSlugs.add(normalizeProjectSlug(project.slug));
    } catch {
      // An unusable stored value cannot collide with a valid planned slug; its
      // validation diagnostic remains available through existingProjectIssues.
    }
  }
  const existingIds = new Set(existingProjectList
    .flatMap((project) => [project.projectId, project._docId])
    .filter((id) => id != null));

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
      expectedThread: candidate.expectedThread || null,
      metadata: null,
      plannedProjectId: null,
      slug: null,
      unknownTags: candidate.unknownTags || [],
      blockers: [],
      reason: null,
    };

    const linkedKey = candidate.thread.projectId != null ? candidate.thread.projectId : null;

    if (linkedKey != null && !validProjects.has(linkedKey) && !invalidProjects.has(linkedKey)) {
      record.disposition = 'conflict';
      record.reason = `thread.projectId ${linkedKey} points at a missing Project (dangling link)`;
      plans.push(record);
      continue;
    }

    if (linkedKey != null && invalidProjects.has(linkedKey)) {
      record.disposition = 'conflict';
      record.reason = `linked Project ${linkedKey} is malformed: ${invalidIssue(linkedKey)}`;
      record.plannedProjectId = linkedKey;
      plans.push(record);
      continue;
    }

    if (linkedKey != null) {
      const existing = validProjects.get(linkedKey);
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
        record.plannedProjectId = linkedKey;
        plans.push(record);
        continue;
      }
      record.disposition = 'already-linked';
      record.plannedProjectId = linkedKey;
      record.slug = existing.slug;
      plans.push(record);
      continue;
    }

    // No backlink on the thread. Any Project claiming this thread as its profile thread
    // is a contradictory mapping, including a malformed claimant.
    const claimants = profileClaims.get(candidate.threadId) || [];
    if (claimants.length) {
      record.disposition = 'conflict';
      record.reason = `Project(s) ${claimants.map((claim) => claim.id).join(', ')} claim this thread as their profile thread while the thread has no backlink`;
      record.plannedProjectId = claimants[0]?.id ?? null;
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
    if (existingIds.has(plannedProjectId)) {
      record.disposition = 'conflict';
      record.plannedProjectId = plannedProjectId;
      record.reason = 'planned Project id is already occupied by an existing Project';
      plans.push(record);
      continue;
    }

    const base = slugifyBase(candidate.title);
    const slug = resolveSlug({ base, projectId: plannedProjectId, taken: takenSlugs });
    if (!slug) {
      record.disposition = 'blocked';
      record.plannedProjectId = plannedProjectId;
      record.blockers = [{ field: 'slug', reason: 'slug collision not resolvable', provenance: `base "${base}"` }];
      plans.push(record);
      continue;
    }

    // Full Phase 2 contract validation in preflight (F10): any defect — including an
    // unrecognised status value that slipped past deriveProjectStatus — blocks the
    // record here, before a single transaction can commit.
    let project;
    try {
      project = buildMigrationProjectRecord({
        projectId: plannedProjectId,
        ownerId: candidate.ownerId,
        title: candidate.title,
        slug,
        summary: candidate.summary,
        status: statusDerivation.status,
        projectUrl: candidate.projectUrl ?? null,
        platforms: candidate.platforms,
        profileThreadId: candidate.threadId,
        timestamp: 'preflight',
      });
    } catch (err) {
      record.disposition = 'blocked';
      record.plannedProjectId = plannedProjectId;
      record.blockers = [{ field: 'record', reason: err.message, provenance: 'Phase 2 project contract' }];
      plans.push(record);
      continue;
    }

    record.disposition = 'create';
    record.plannedProjectId = plannedProjectId;
    record.slug = slug;
    record.metadata = {
      ownerId: project.ownerId,
      title: project.title,
      slug: project.slug,
      summary: project.summary,
      status: project.status,
      projectUrl: project.projectUrl,
      platforms: project.platforms,
      profileThreadId: project.profileThreadId,
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

const sameField = (a, b) => (a ?? null) === (b ?? null);

// One record = one transaction: the Project doc is created and the original thread's
// projectId backlink is written atomically. All validation happens inside the
// transaction against freshly read state. Scope (F6): this guards exactly the
// (thread, planned Project) pair — see the module header for the concurrent-writer
// precondition it deliberately does not cover.
export async function applyMigrationRecordTransaction({
  transaction, threadRef, projectRef, planRecord, timestamp,
}) {
  const [threadSnap, projectSnap] = await Promise.all([transaction.get(threadRef), transaction.get(projectRef)]);
  if (!threadSnap.exists) throw new Error(`thread ${planRecord.threadId} disappeared before apply`);
  if (projectSnap.exists) throw new Error(`planned Project id ${planRecord.plannedProjectId} is already occupied`);

  const thread = threadSnap.data();
  // A create was planned against a null backlink: ANY non-null projectId now — even one
  // equal to the planned id — means state changed since planning and must not be
  // silently repaired or accepted (F8).
  if (thread.projectId != null) {
    throw new Error(`thread ${planRecord.threadId} gained a Project link (${thread.projectId}) after planning; refusing to create`);
  }
  // Stale Firestore-side state fails closed (F7): the source fields the metadata was
  // derived from must be unchanged, and the owner must still be present and identical.
  if (!planRecord.expectedThread) {
    throw new Error(`plan record for ${planRecord.threadId} lacks the expectedThread snapshot; refusing to apply`);
  }
  const expected = planRecord.expectedThread;
  if (!sameField(thread.mode, expected.mode)) {
    throw new Error(`thread ${planRecord.threadId} mode changed since planning (${thread.mode} vs ${expected.mode})`);
  }
  if (!sameField(thread.forumId, expected.forumId)) {
    throw new Error(`thread ${planRecord.threadId} source forum changed since planning (${thread.forumId} vs ${expected.forumId})`);
  }
  if (!sameField(thread.projectUrl, expected.projectUrl)) {
    throw new Error(`thread ${planRecord.threadId} projectUrl changed since planning`);
  }
  const ownerId = assertDiscordId(planRecord.metadata.ownerId, 'owner ID');
  if (thread.ownerId == null || thread.ownerId !== ownerId) {
    throw new Error(`thread ${planRecord.threadId} owner changed since planning (${thread.ownerId})`);
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
