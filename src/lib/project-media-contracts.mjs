// Project media selection v1. Keep this dependency-free contract identical in Site and Bot.
export const MEDIA_COLLECTION = 'projectMedia';
export const MEDIA_LIMIT = 12;
export const MEDIA_REQUEST_BYTES = 32768;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
export const mediaDiscordId = (v) => typeof v === 'string' && /^[0-9]{17,20}$/.test(v);
export const mediaProjectId = (v) => typeof v === 'string' && v.trim().length > 0 && new TextEncoder().encode(v).length <= 1500 && !/[\/\x00-\x1f\x7f]/.test(v) && v !== '.' && v !== '..';
const revision = (v) => Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
const text = (v, n, required = false) => typeof v === 'string' && v.length <= n && (!required || v.trim()) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
export function parseMediaItems(items) {
  if (!Array.isArray(items) || items.length > MEDIA_LIMIT) return null;
  const ids = new Set(), attachments = new Set(), out = [];
  for (const item of items) {
    if (!exact(item, ['id', 'messageId', 'attachmentId', 'alt', 'caption', 'visibility'])
      || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,79}$/.test(item.id)
      || ids.has(item.id) || attachments.has(item.attachmentId)
      || !mediaDiscordId(item.messageId) || !mediaDiscordId(item.attachmentId)
      || !text(item.alt, 240, true) || !text(item.caption, 280)
      || !['draft', 'public'].includes(item.visibility)) return null;
    ids.add(item.id); attachments.add(item.attachmentId);
    out.push({ id: item.id, messageId: item.messageId, attachmentId: item.attachmentId,
      alt: item.alt.trim(), caption: item.caption.trim(), visibility: item.visibility });
  }
  return out;
}
export function parseMediaInput(input) {
  if (!exact(input, ['revision', 'mode', 'items']) || !revision(input.revision) || !['automatic', 'selected'].includes(input.mode)) return null;
  const items = parseMediaItems(input.items);
  return items ? { revision: input.revision, mode: input.mode, items } : null;
}
export function mediaState(value, projectId, threadId) {
  if (!mediaProjectId(projectId) || !mediaDiscordId(threadId)) return null;
  if (value === undefined) return { version: 1, projectId, threadId, revision: 0, mode: 'automatic', items: [] };
  if (!exact(value, ['version', 'projectId', 'threadId', 'revision', 'mode', 'items', 'updatedAt'])
    || value.version !== 1 || value.projectId !== projectId || value.threadId !== threadId || value.revision === 0) return null;
  const parsed = parseMediaInput({ revision: value.revision, mode: value.mode, items: value.items });
  return parsed ? { version: 1, projectId, threadId, ...parsed } : null;
}
// UI helpers only extract IDs. No user-supplied URL is fetched by the server.
export function mediaMessageId(link, guildId, threadId) {
  if (!mediaDiscordId(guildId) || !mediaDiscordId(threadId) || typeof link !== 'string') return null;
  const match = /^https:\/\/discord\.com\/channels\/([0-9]{17,20})\/([0-9]{17,20})\/([0-9]{17,20})$/.exec(link.trim());
  return match && match[1] === guildId && match[2] === threadId ? match[3] : null;
}
export function mediaAttachmentId(link, threadId) {
  if (typeof link !== 'string' || !mediaDiscordId(threadId)) return null;
  try {
    const url = new URL(link.trim());
    const match = /^\/attachments\/([0-9]{17,20})\/([0-9]{17,20})\/[^/]+$/.exec(url.pathname);
    return url.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
      && !url.port && !url.username && !url.password && !url.hash && match && match[1] === threadId ? match[2] : null;
  } catch { return null; }
}
