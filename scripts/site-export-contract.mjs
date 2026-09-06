import { normalizeJamId, normalizeProjectUrl } from '../src/lib/publicMetadata.js';
import {
  assertDiscordId,
  assertProjectId,
  normalizeNullableProfileThreadId,
  normalizeProjectInput,
  normalizeProjectSlug,
} from '../src/lib/projectValidation.js';

const PROJECT_LINK_TYPES = new Set(['play', 'website', 'download', 'steam', 'itch', 'devlog', 'other']);
const PROJECT_ACTIVITY_TYPES = new Set(['feedback', 'project-update', 'jam-entry', 'release', 'build', 'milestone']);

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value, name, maxLength) {
  if (typeof value !== 'string') throw new Error(`${name} is required`);
  const text = value.trim();
  if (!text) throw new Error(`${name} is required`);
  if (text.length > maxLength) throw new Error(`${name} must be at most ${maxLength} characters`);
  return text;
}

export function normalizeOptionalText(value, name, maxLength) {
  if (value == null) return null;
  return requiredText(value, name, maxLength);
}

function requiredHttpUrl(value, name) {
  const text = requiredText(value, name, 2048);
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw new Error(`${name} must be a public http(s) URL`);
  }
  return text;
}

function isoTimestamp(value, name, { required = false } = {}) {
  if (value == null) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }

  let text = value;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (value && typeof value.toDate === 'function') {
    const date = value.toDate();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new Error(`${name} must be an ISO timestamp`);
    }
    text = date.toISOString();
  }

  if (typeof text !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)
    || Number.isNaN(Date.parse(text))
    || new Date(text).toISOString().slice(0, 19) !== text.slice(0, 19)) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return text;
}

function normalizeProjectLinks(value, projectId) {
  const links = value ?? [];
  if (!Array.isArray(links)) throw new Error(`Project ${projectId} links must be an array`);
  if (links.length > 12) throw new Error(`Project ${projectId} may contain at most 12 links`);
  return links.map((link, index) => {
    const name = `Project ${projectId} link ${index + 1}`;
    if (!isRecord(link) || !PROJECT_LINK_TYPES.has(link.type)) {
      throw new Error(`${name} has an invalid type`);
    }
    if (!Number.isInteger(link.priority) || link.priority < 0 || link.priority > 100) {
      throw new Error(`${name} priority must be an integer from 0 to 100`);
    }
    return {
      type: link.type,
      label: requiredText(link.label, `${name} label`, 80),
      url: requiredHttpUrl(link.url, `${name} URL`),
      priority: link.priority,
    };
  }).sort((a, b) => a.priority - b.priority);
}

export function normalizeProjectActivity(value, name = 'Project activity') {
  if (!isRecord(value) || !PROJECT_ACTIVITY_TYPES.has(value.type)) {
    throw new Error(`${name} has an invalid type`);
  }
  return {
    type: value.type,
    title: requiredText(value.title, `${name} title`, 160),
    date: isoTimestamp(value.date, `${name} date`, { required: true }),
    summary: normalizeOptionalText(value.summary, `${name} summary`, 500),
    url: requiredHttpUrl(value.url, `${name} URL`),
  };
}

function normalizeProjectActivities(value, projectId) {
  const activities = value ?? [];
  if (!Array.isArray(activities)) throw new Error(`Project ${projectId} activities must be an array`);
  if (activities.length > 50) throw new Error(`Project ${projectId} may contain at most 50 activities`);
  return activities.map((activity, index) =>
    normalizeProjectActivity(activity, `Project ${projectId} activity ${index + 1}`));
}

function normalizeProjectWiki(value, projectId) {
  if (value == null) return null;
  if (!isRecord(value)) throw new Error(`Project ${projectId} wiki must be an object`);
  if (value.draft === true || value.published === false) return null;
  if (!Array.isArray(value.entries)) {
    throw new Error(`Project ${projectId} wiki must contain an entries array`);
  }
  const publicEntries = value.entries.filter((entry) => entry?.draft !== true && entry?.published !== false);
  if (publicEntries.length > 6) throw new Error(`Project ${projectId} wiki may contain at most 6 entries`);
  return {
    url: requiredHttpUrl(value.url, `Project ${projectId} wiki URL`),
    entries: publicEntries.map((entry, index) => {
      const name = `Project ${projectId} wiki entry ${index + 1}`;
      if (!isRecord(entry)) throw new Error(`${name} must be an object`);
      return {
        title: requiredText(entry.title, `${name} title`, 120),
        summary: normalizeOptionalText(entry.summary, `${name} summary`, 240),
        url: requiredHttpUrl(entry.url, `${name} URL`),
      };
    }),
  };
}

function normalizeMediaThreadIds(value, projectId) {
  const ids = value ?? [];
  if (!Array.isArray(ids)) throw new Error(`Project ${projectId} mediaThreadIds must be an array`);
  if (ids.length > 12) throw new Error(`Project ${projectId} may contain at most 12 mediaThreadIds`);
  const normalized = ids.map((id) => assertDiscordId(id, `Project ${projectId} media thread ID`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Project ${projectId} mediaThreadIds must not contain duplicates`);
  }
  return normalized;
}

export function normalizePublicProjectMedia(value, name = 'Project media') {
  if (!isRecord(value) || value.kind !== 'image') throw new Error(`${name} must be an image`);
  const src = requiredText(value.src, `${name} src`, 512);
  if (!/^\/assets\/[^\s?#]+$/.test(src)
    || src.includes('\\')
    || src.split('/').some((segment) => segment === '..')) {
    throw new Error(`${name} has an unsafe asset path`);
  }
  if (!Number.isInteger(value.width) || value.width < 1 || value.width > 10000) {
    throw new Error(`${name} width must be an integer from 1 to 10000`);
  }
  if (!Number.isInteger(value.height) || value.height < 1 || value.height > 10000) {
    throw new Error(`${name} height must be an integer from 1 to 10000`);
  }
  return {
    kind: 'image',
    src,
    alt: requiredText(value.alt, `${name} alt`, 240),
    width: value.width,
    height: value.height,
    caption: normalizeOptionalText(value.caption, `${name} caption`, 280),
  };
}

function preparePublishedProject(id, data) {
  const input = normalizeProjectInput({
    ownerId: data.ownerId,
    title: data.title,
    slug: data.slug,
    summary: data.summary,
    status: data.status,
    projectUrl: data.projectUrl ?? null,
    platforms: data.platforms,
  });
  const profileThreadId = normalizeNullableProfileThreadId(data.profileThreadId ?? null);
  const mediaThreadIds = normalizeMediaThreadIds(data.mediaThreadIds, id);
  const activities = normalizeProjectActivities(data.activities, id);

  return {
    id,
    ownerId: input.ownerId,
    profileThreadId,
    mediaThreadIds,
    project: {
      id,
      slug: input.slug,
      title: input.title,
      creatorName: normalizeOptionalText(data.creatorName, `Project ${id} creatorName`, 120),
      summary: input.summary,
      description: normalizeOptionalText(data.description, `Project ${id} description`, 4000),
      status: input.status,
      projectUrl: input.projectUrl,
      platforms: input.platforms,
      hero: null,
      media: [],
      links: normalizeProjectLinks(data.links, id),
      activities,
      wiki: normalizeProjectWiki(data.wiki, id),
      createdAt: isoTimestamp(data.createdAt, `Project ${id} createdAt`),
      updatedAt: isoTimestamp(data.updatedAt, `Project ${id} updatedAt`),
    },
  };
}

// Validates physical identity before applying publication filtering. This prevents a
// malformed embedded id from becoming a second identity for links or media lookups.
export function prepareProjectExports(projectDocs) {
  const allById = new Map();
  for (const doc of projectDocs || []) {
    const id = assertProjectId(doc?.id);
    if (allById.has(id)) throw new Error(`duplicate Project document id ${id}`);
    const data = doc && typeof doc.data === 'function' ? doc.data() : null;
    if (!isRecord(data)) throw new Error(`Project ${id} data must be an object`);
    if (Object.hasOwn(data, 'projectId')) {
      const embeddedId = assertProjectId(data.projectId);
      if (embeddedId !== id) {
        throw new Error(`Project embedded projectId ${embeddedId} does not match document id ${id}`);
      }
    }
    allById.set(id, { id, data, prepared: null });
  }

  const published = [];
  const slugs = new Set();
  for (const record of allById.values()) {
    if (record.data.publishToSite !== true) continue;
    const prepared = preparePublishedProject(record.id, record.data);
    if (slugs.has(prepared.project.slug)) {
      throw new Error(`duplicate published Project slug ${prepared.project.slug}`);
    }
    slugs.add(prepared.project.slug);
    record.prepared = prepared;
    published.push(prepared);
  }
  published.sort((a, b) => a.project.slug.localeCompare(b.project.slug));
  return { allById, published };
}

export function mergeProjectActivities(ownerManaged, discordDerived) {
  return [...(ownerManaged || []), ...(discordDerived || [])]
    .map((value, index) => normalizeProjectActivity(value, `Merged Project activity ${index + 1}`))
    .sort((a, b) => b.date.localeCompare(a.date) || a.url.localeCompare(b.url) || a.title.localeCompare(b.title))
    .slice(0, 50);
}

export function finalizeProjectExport(prepared, { hero = null, media = [], derivedActivities = [] } = {}) {
  if (!prepared || !prepared.project) throw new Error('prepared Project is required');
  if (!Array.isArray(media) || media.length > 12) {
    throw new Error(`Project ${prepared.id} may contain at most 12 media items`);
  }
  return {
    ...prepared.project,
    hero: hero == null ? null : normalizePublicProjectMedia(hero, `Project ${prepared.id} hero`),
    media: media.map((item, index) =>
      normalizePublicProjectMedia(item, `Project ${prepared.id} media ${index + 1}`)),
    activities: mergeProjectActivities(prepared.project.activities, derivedActivities),
  };
}

export function buildPublicGame({
  id,
  title,
  author,
  description,
  image,
  threadUrl,
  createdAt,
  feedbackPoints,
  tags,
  award,
  projectUrl,
  jamId,
  activityTitle = null,
  projectId = null,
  projectSlug = null,
  state = null,
}) {
  const normalizedJamId = normalizeJamId(jamId);
  if (jamId != null && !normalizedJamId) {
    throw new Error(`game ${id} has an invalid jamId`);
  }
  const normalizedProjectUrl = projectUrl == null ? null : normalizeProjectUrl(projectUrl);
  if (projectUrl != null && !normalizedProjectUrl) {
    throw new Error(`game ${id} has an invalid projectUrl`);
  }

  const normalizedActivityTitle = normalizeOptionalText(activityTitle, `game ${id} activityTitle`, 160);
  let normalizedProjectId = null;
  let normalizedProjectSlug = null;
  let normalizedState = null;
  if (projectId != null || projectSlug != null || state != null) {
    if (projectId == null || projectSlug == null) {
      throw new Error(`game ${id} has an incomplete Project link`);
    }
    normalizedProjectId = assertProjectId(projectId);
    normalizedProjectSlug = normalizeProjectSlug(projectSlug);
    if (state !== 'open' && state !== 'archived') {
      throw new Error(`game ${id} has an invalid Project state`);
    }
    normalizedState = state;
  }

  return {
    id,
    title,
    author,
    description,
    image,
    threadUrl,
    createdAt,
    feedbackPoints,
    tags,
    award,
    kind: normalizedJamId ? 'jam-entry' : 'project',
    jamId: normalizedJamId,
    projectId: normalizedProjectId,
    projectSlug: normalizedProjectSlug,
    state: normalizedState,
    activityTitle: normalizedActivityTitle,
    projectUrl: normalizedProjectUrl,
    // Legacy compatibility marker: derived solely from recognised feedbackPoints, not current
    // feedback intent. It is not used for Test/Play decisions.
    needsFeedback: feedbackPoints === 0,
    publish: true,
  };
}
