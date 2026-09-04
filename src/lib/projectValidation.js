import { normalizeProjectUrl } from './publicMetadata.js';

export const PROJECT_STATUSES = ['development', 'playable', 'released', 'paused'];
export const PROJECT_PLATFORMS = ['web', 'windows', 'macos', 'linux', 'ios', 'android', 'other'];
export const THREAD_PURPOSES = ['feedback', 'project-update', 'jam-entry'];

const DISCORD_ID_RE = /^\d{17,20}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requiredString(value, name, maxLength) {
  if (typeof value !== 'string') throw new Error(`${name} is required`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > maxLength) throw new Error(`${name} must be at most ${maxLength} characters`);
  return normalized;
}

export function assertDiscordId(value, name) {
  const normalized = requiredString(value, name, 20);
  if (!DISCORD_ID_RE.test(normalized)) throw new Error(`${name} must be a valid Discord ID`);
  return normalized;
}

export function assertProjectId(value) {
  const projectId = requiredString(value, 'project ID', 1500);
  if (projectId.includes('/')) throw new Error('project ID must not contain /');
  return projectId;
}

export function normalizeProjectTitle(value) {
  return requiredString(value, 'title', 120);
}

export function normalizeProjectSlug(value) {
  const slug = requiredString(value, 'slug', 100);
  if (!SLUG_RE.test(slug)) {
    throw new Error('slug must use lowercase URL-safe hyphen-separated segments');
  }
  return slug;
}

export function normalizeProjectSummary(value) {
  return requiredString(value, 'summary', 280);
}

export function normalizeProjectStatus(value) {
  if (!PROJECT_STATUSES.includes(value)) {
    throw new Error(`status must be one of: ${PROJECT_STATUSES.join(', ')}`);
  }
  return value;
}

export function normalizeProjectPlatforms(value) {
  if (!Array.isArray(value)) throw new Error('platforms must be an array');
  const platforms = value.map((platform) => {
    if (!PROJECT_PLATFORMS.includes(platform)) {
      throw new Error(`platform must be one of: ${PROJECT_PLATFORMS.join(', ')}`);
    }
    return platform;
  });
  if (new Set(platforms).size !== platforms.length) throw new Error('platforms must not contain duplicates');
  return platforms;
}

export function normalizeProjectUrlValue(value) {
  if (value == null) return null;
  const projectUrl = normalizeProjectUrl(value);
  if (!projectUrl) throw new Error('project URL must be an http(s) URL');
  return projectUrl;
}

export function normalizePublishToSite(value) {
  if (typeof value !== 'boolean') throw new Error('publishToSite must be a boolean');
  return value;
}

export function normalizeThreadPurpose(value) {
  if (!THREAD_PURPOSES.includes(value)) {
    throw new Error(`purpose must be one of: ${THREAD_PURPOSES.join(', ')}`);
  }
  return value;
}

export function normalizeNullableProfileThreadId(value) {
  if (value == null) return null;
  return assertDiscordId(value, 'profile thread ID');
}

export function normalizeProjectInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('project input is required');
  return {
    ownerId: assertDiscordId(input.ownerId, 'owner ID'),
    title: normalizeProjectTitle(input.title),
    slug: normalizeProjectSlug(input.slug),
    summary: normalizeProjectSummary(input.summary),
    status: normalizeProjectStatus(input.status),
    projectUrl: normalizeProjectUrlValue(input.projectUrl),
    platforms: normalizeProjectPlatforms(input.platforms),
  };
}
