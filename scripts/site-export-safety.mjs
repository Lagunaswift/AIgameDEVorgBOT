import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeJamId, normalizeProjectUrl } from '../src/lib/publicMetadata.js';

export const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;
const PROJECT_STATUSES = new Set(['development', 'playable', 'released', 'paused']);
const PROJECT_PLATFORMS = new Set(['web', 'windows', 'macos', 'linux', 'ios', 'android', 'other']);
const PROJECT_LINK_TYPES = new Set(['play', 'website', 'download', 'steam', 'itch', 'devlog', 'other']);
const PROJECT_ACTIVITY_TYPES = new Set(['feedback', 'project-update', 'jam-entry', 'release', 'build', 'milestone']);
const PROJECT_ENVELOPE_KEYS = new Set(['version', 'generatedAt', 'projects']);
const PROJECT_PUBLIC_KEYS = new Set([
  'id', 'slug', 'title', 'creatorName', 'summary', 'description', 'status', 'projectUrl',
  'platforms', 'hero', 'media', 'links', 'activities', 'wiki', 'createdAt', 'updatedAt',
]);
const PROJECT_MEDIA_KEYS = new Set(['kind', 'src', 'alt', 'width', 'height', 'caption']);
const PROJECT_LINK_KEYS = new Set(['type', 'label', 'url', 'priority']);
const PROJECT_ACTIVITY_KEYS = new Set(['type', 'title', 'date', 'summary', 'url']);
const PROJECT_WIKI_KEYS = new Set(['url', 'entries']);
const PROJECT_WIKI_ENTRY_KEYS = new Set(['title', 'summary', 'url']);
const FORBIDDEN_PROJECT_KEYS = new Set([
  'ownerid',
  'profilethreadid',
  'mediathreadids',
  'publish',
  'publishtosite',
  'publishonproject',
  'forumid',
  'discorduserid',
  'session',
  'sessiondata',
  'oauth',
  'firestorepath',
]);

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function containsForbiddenProjectKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenProjectKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    FORBIDDEN_PROJECT_KEYS.has(key.toLowerCase()) || containsForbiddenProjectKey(nested));
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported public field(s): ${unknown.join(', ')}`);
}

function isText(value, maxLength) {
  return typeof value === 'string' && Boolean(value.trim()) && value.trim().length <= maxLength;
}

function isNullableText(value, maxLength) {
  return value == null || isText(value, maxLength);
}

function isHttpUrl(value) {
  if (!isText(value, 2048)) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isIsoTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

export function isSafeAssetPath(value) {
  return isText(value, 512)
    && /^\/assets\/[^\s?#]+$/.test(value)
    && !value.includes('\\')
    && !value.split('/').some((segment) => segment === '..');
}

function validateProjectMedia(media, label) {
  if (!isRecord(media) || media.kind !== 'image' || !isSafeAssetPath(media.src)) {
    throw new Error(`${label} must be an image with a safe asset path`);
  }
  assertOnlyKeys(media, PROJECT_MEDIA_KEYS, label);
  if (!isText(media.alt, 240)) throw new Error(`${label} must have meaningful alt text`);
  if (!Number.isInteger(media.width) || media.width < 1 || media.width > 10000
    || !Number.isInteger(media.height) || media.height < 1 || media.height > 10000) {
    throw new Error(`${label} has invalid intrinsic dimensions`);
  }
  if (!isNullableText(media.caption, 280)) throw new Error(`${label} has an invalid caption`);
}

function validateProjectLink(link, label) {
  if (!isRecord(link) || !PROJECT_LINK_TYPES.has(link.type)) throw new Error(`${label} has an invalid type`);
  assertOnlyKeys(link, PROJECT_LINK_KEYS, label);
  if (!isText(link.label, 80) || !isHttpUrl(link.url)) throw new Error(`${label} is malformed`);
  if (!Number.isInteger(link.priority) || link.priority < 0 || link.priority > 100) {
    throw new Error(`${label} has an invalid priority`);
  }
}

function validateProjectActivity(activity, label) {
  if (!isRecord(activity) || !PROJECT_ACTIVITY_TYPES.has(activity.type)) {
    throw new Error(`${label} has an invalid type`);
  }
  assertOnlyKeys(activity, PROJECT_ACTIVITY_KEYS, label);
  if (!isText(activity.title, 160) || !isIsoTimestamp(activity.date)
    || !isNullableText(activity.summary, 500) || !isHttpUrl(activity.url)) {
    throw new Error(`${label} is malformed`);
  }
}

function validateProjectWiki(wiki, projectId) {
  if (wiki == null) return;
  if (!isRecord(wiki) || !isHttpUrl(wiki.url) || !Array.isArray(wiki.entries)) {
    throw new Error(`candidate Project ${projectId} wiki is malformed`);
  }
  assertOnlyKeys(wiki, PROJECT_WIKI_KEYS, `candidate Project ${projectId} wiki`);
  if (wiki.entries.length > 6) throw new Error(`candidate Project ${projectId} wiki may contain at most 6 entries`);
  for (const [index, entry] of wiki.entries.entries()) {
    if (!isRecord(entry) || !isText(entry.title, 120)
      || !isNullableText(entry.summary, 240) || !isHttpUrl(entry.url)) {
      throw new Error(`candidate Project ${projectId} wiki entry ${index + 1} is malformed`);
    }
    assertOnlyKeys(entry, PROJECT_WIKI_ENTRY_KEYS, `candidate Project ${projectId} wiki entry ${index + 1}`);
  }
}

export function parsePublishTagId(value) {
  const tagId = String(value || '').trim();
  if (!DISCORD_SNOWFLAKE_RE.test(tagId)) {
    throw new Error('SITE_PUBLISH_TAG_ID must be a Discord snowflake');
  }
  return tagId;
}

export function isExplicitlyOptedOut(game) {
  return game && game.publish === false;
}

export function validateExportReport(report) {
  if (!report || report.version !== 1 || !Array.isArray(report.withheldIds)) {
    throw new Error('export report must contain version 1 and a withheldIds array');
  }
  const ids = new Set();
  for (const id of report.withheldIds) {
    if (!DISCORD_SNOWFLAKE_RE.test(String(id || ''))) {
      throw new Error('export report contains an invalid withheld id');
    }
    if (ids.has(id)) throw new Error(`export report contains duplicate withheld id ${id}`);
    ids.add(id);
  }
  const unpublishedProjectIds = report.unpublishedProjectIds ?? [];
  if (!Array.isArray(unpublishedProjectIds)) throw new Error('export report unpublishedProjectIds must be an array');
  const projectIds = new Set();
  for (const id of unpublishedProjectIds) {
    if (!isText(id, 1500) || id.includes('/')) throw new Error('export report contains an invalid unpublished Project id');
    if (projectIds.has(id)) throw new Error(`export report contains duplicate unpublished Project id ${id}`);
    projectIds.add(id);
  }
  return report;
}

export function semanticSnapshot(snapshot) {
  const { generatedAt, ...semantic } = snapshot;
  return semantic;
}

export function preserveGeneratedAtIfUnchanged(previous, candidate) {
  if (!previous || JSON.stringify(semanticSnapshot(previous)) !== JSON.stringify(semanticSnapshot(candidate))) {
    return candidate;
  }
  return { ...candidate, generatedAt: previous.generatedAt };
}

export function validateShowcaseSnapshot(candidate, previous, report = { version: 1, withheldIds: [] }) {
  validateExportReport(report);
  if (!candidate || candidate.version !== 2 || !Array.isArray(candidate.games)) {
    throw new Error('candidate showcase.json must contain version 2 and a games array');
  }
  if (!Number.isNaN(Date.parse(candidate.generatedAt || ''))) {
    // Valid ISO timestamps are required; Date.parse alone also accepts some non-ISO forms.
    if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(candidate.generatedAt)) {
      throw new Error('candidate showcase.json generatedAt must be an ISO timestamp');
    }
  } else {
    throw new Error('candidate showcase.json generatedAt must be an ISO timestamp');
  }

  const candidateIds = new Set();
  for (const game of candidate.games) {
    if (!game || !DISCORD_SNOWFLAKE_RE.test(String(game.id || ''))) {
      throw new Error('candidate showcase.json contains a game with an invalid id');
    }
    if (candidateIds.has(game.id)) {
      throw new Error(`candidate showcase.json contains duplicate game id ${game.id}`);
    }
    if (game.publish !== true) {
      throw new Error(`candidate game ${game.id} must set publish: true`);
    }
    if (typeof game.title !== 'string' || !game.title.trim()) {
      throw new Error(`candidate game ${game.id} must have a title`);
    }
    if (Object.hasOwn(game, 'authorId') || Object.hasOwn(game, 'forumId')) {
      throw new Error(`candidate game ${game.id} contains private metadata`);
    }
    if (!Object.hasOwn(game, 'activityTitle') || !isNullableText(game.activityTitle, 160)) {
      throw new Error(`candidate game ${game.id} has an invalid activityTitle`);
    }
    if (!Object.hasOwn(game, 'projectId') || !Object.hasOwn(game, 'projectSlug') || !Object.hasOwn(game, 'state')) {
      throw new Error(`candidate game ${game.id} must include nullable Project linkage fields`);
    }
    const linked = game.projectId !== null || game.projectSlug !== null;
    if ((game.projectId === null) !== (game.projectSlug === null)) {
      throw new Error(`candidate game ${game.id} has an incomplete Project link`);
    }
    if (linked) {
      if (!isText(game.projectId, 1500) || game.projectId.includes('/')) {
        throw new Error(`candidate game ${game.id} has an invalid projectId`);
      }
      if (!isText(game.projectSlug, 100)
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(game.projectSlug)
        || !['open', 'archived'].includes(game.state)) {
        throw new Error(`candidate game ${game.id} has an invalid Project link`);
      }
    } else if (game.state !== null) {
      throw new Error(`candidate game ${game.id} has Project state without a Project link`);
    }
    if (!['project', 'jam-entry'].includes(game.kind)) {
      throw new Error(`candidate game ${game.id} must have a valid kind`);
    }
    if (!Object.hasOwn(game, 'jamId') || (game.jamId !== null && !normalizeJamId(game.jamId))) {
      throw new Error(`candidate game ${game.id} has an invalid jamId`);
    }
    if ((game.kind === 'jam-entry') !== (game.jamId !== null)) {
      throw new Error(`candidate game ${game.id} has inconsistent kind and jamId`);
    }
    if (!Object.hasOwn(game, 'projectUrl') || (game.projectUrl !== null && !normalizeProjectUrl(game.projectUrl))) {
      throw new Error(`candidate game ${game.id} has an invalid projectUrl`);
    }
    if (!Number.isInteger(game.feedbackPoints) || game.feedbackPoints < 0) {
      throw new Error(`candidate game ${game.id} has an invalid feedbackPoints count`);
    }
    // v2 retains this legacy no-recognised-feedback marker for compatibility; it is derived
    // from feedbackPoints and must not be interpreted as current feedback intent or Test/Play state.
    if (typeof game.needsFeedback !== 'boolean' || game.needsFeedback !== (game.feedbackPoints === 0)) {
      throw new Error(`candidate game ${game.id} has inconsistent needsFeedback`);
    }
    candidateIds.add(game.id);
  }

  // v1 is accepted only as the prior snapshot during the one-way v2 migration. It is
  // never a valid candidate contract, so a site loader cannot render it by accident.
  if (!previous || ![1, 2].includes(previous.version) || !Array.isArray(previous.games)) return;
  const withheldIds = new Set(report.withheldIds);
  const unpublishedProjectIds = new Set(report.unpublishedProjectIds ?? []);
  const previousById = new Map(previous.games.filter(Boolean).map((game) => [game.id, game]));
  for (const game of candidate.games) {
    const prior = previousById.get(game.id);
    if (prior?.projectId != null
      && (game.projectId !== prior.projectId || game.projectSlug !== prior.projectSlug)) {
      if (game.projectId === null && unpublishedProjectIds.has(prior.projectId)) continue;
      throw new Error(`candidate game ${game.id} would change its exact Project relationship`);
    }
  }
  const missing = previous.games
    // Every v1 record was previously public. During the one-way migration, a
    // record can disappear only when the exporter saw it and recorded it as
    // withheld (for example because the owner did not add the opt-in tag).
    .filter((game) => game && (previous.version === 1 || game.publish === true) && !candidateIds.has(game.id) && !withheldIds.has(game.id))
    .map((game) => game.id);
  if (missing.length) {
    throw new Error(`candidate showcase.json would remove non-opted-out project(s): ${missing.join(', ')}`);
  }
}

export function validateProjectsSnapshot(candidate) {
  if (!isRecord(candidate) || candidate.version !== 1 || !Array.isArray(candidate.projects)) {
    throw new Error('candidate projects.json must contain version 1 and a projects array');
  }
  if (!isIsoTimestamp(candidate.generatedAt)) {
    throw new Error('candidate projects.json generatedAt must be an ISO timestamp');
  }
  if (containsForbiddenProjectKey(candidate)) {
    throw new Error('candidate projects.json contains private metadata');
  }
  assertOnlyKeys(candidate, PROJECT_ENVELOPE_KEYS, 'candidate projects.json');

  const ids = new Set();
  const slugs = new Set();
  for (const value of candidate.projects) {
    if (!isRecord(value)) throw new Error('candidate projects.json contains a malformed Project');
    assertOnlyKeys(value, PROJECT_PUBLIC_KEYS, `candidate Project ${value.id ?? '(unknown)'}`);
    const id = value.id;
    if (!isText(id, 1500) || id.includes('/')) throw new Error('candidate Project has an invalid id');
    if (ids.has(id)) throw new Error(`candidate projects.json contains duplicate Project id ${id}`);
    ids.add(id);

    if (!isText(value.slug, 100) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug)) {
      throw new Error(`candidate Project ${id} has an invalid slug`);
    }
    if (slugs.has(value.slug)) throw new Error(`candidate projects.json contains duplicate Project slug ${value.slug}`);
    slugs.add(value.slug);

    if (!isText(value.title, 120) || !isText(value.summary, 280)) {
      throw new Error(`candidate Project ${id} has invalid required text`);
    }
    if (!isNullableText(value.creatorName, 120) || !isNullableText(value.description, 4000)) {
      throw new Error(`candidate Project ${id} has invalid optional text`);
    }
    if (!PROJECT_STATUSES.has(value.status)) throw new Error(`candidate Project ${id} has an invalid status`);
    if (value.projectUrl != null && !isHttpUrl(value.projectUrl)) {
      throw new Error(`candidate Project ${id} has an invalid projectUrl`);
    }
    if (!Array.isArray(value.platforms)
      || value.platforms.some((platform) => !PROJECT_PLATFORMS.has(platform))
      || new Set(value.platforms).size !== value.platforms.length) {
      throw new Error(`candidate Project ${id} has invalid platforms`);
    }
    if (value.createdAt != null && !isIsoTimestamp(value.createdAt)) {
      throw new Error(`candidate Project ${id} has an invalid createdAt`);
    }
    if (value.updatedAt != null && !isIsoTimestamp(value.updatedAt)) {
      throw new Error(`candidate Project ${id} has an invalid updatedAt`);
    }

    if (value.hero != null) validateProjectMedia(value.hero, `candidate Project ${id} hero`);
    const media = value.media ?? [];
    const links = value.links ?? [];
    const activities = value.activities ?? [];
    if (!Array.isArray(media) || media.length > 12) {
      throw new Error(`candidate Project ${id} may contain at most 12 media items`);
    }
    if (!Array.isArray(links) || links.length > 12) {
      throw new Error(`candidate Project ${id} may contain at most 12 links`);
    }
    if (!Array.isArray(activities) || activities.length > 50) {
      throw new Error(`candidate Project ${id} may contain at most 50 activities`);
    }
    media.forEach((item, index) => validateProjectMedia(item, `candidate Project ${id} media ${index + 1}`));
    links.forEach((item, index) => validateProjectLink(item, `candidate Project ${id} link ${index + 1}`));
    activities.forEach((item, index) => validateProjectActivity(item, `candidate Project ${id} activity ${index + 1}`));
    validateProjectWiki(value.wiki, id);
  }
}

export function validateProjectLinks(showcase, projects) {
  if (!showcase || !Array.isArray(showcase.games) || !projects || !Array.isArray(projects.projects)) {
    throw new Error('Showcase and Project snapshots are required for cross-snapshot validation');
  }
  const projectsById = new Map(projects.projects.map((project) => [project.id, project]));
  for (const game of showcase.games) {
    if (game.projectId == null) continue;
    const project = projectsById.get(game.projectId);
    if (!project) throw new Error(`candidate game ${game.id} has a dangling Project link ${game.projectId}`);
    if (project.slug !== game.projectSlug) {
      throw new Error(`candidate game ${game.id} Project slug mismatch for ${game.projectId}`);
    }
  }
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function removeStaleAssets(directory, referencedPaths) {
  await fs.mkdir(directory, { recursive: true });
  const expected = new Set(referencedPaths.map((assetPath) => path.basename(assetPath)));
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && !expected.has(entry.name)) {
      await fs.unlink(path.join(directory, entry.name));
    }
  }
}
