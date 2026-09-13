// Project update selection v1. Keep this dependency-free contract identical in Site and Bot.
export const UPDATES_COLLECTION = 'projectUpdates';
export const UPDATES_LIMIT = 20;
export const UPDATES_REQUEST_BYTES = 32768;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
export const updatesDiscordId = (v) => typeof v === 'string' && /^[0-9]{17,20}$/.test(v);
export const updatesProjectId = (v) => typeof v === 'string' && v.trim().length > 0 && new TextEncoder().encode(v).length <= 1500 && !/[\/\x00-\x1f\x7f]/.test(v) && v !== '.' && v !== '..';
const revision = (v) => Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
export function parseUpdateItems(items) {
  if (!Array.isArray(items) || items.length > UPDATES_LIMIT) return null;
  const ids = new Set(), messages = new Set(), out = [];
  for (const item of items) {
    if (!exact(item, ['id', 'messageId', 'title', 'visibility'])
      || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,79}$/.test(item.id)
      || ids.has(item.id) || messages.has(item.messageId) || !updatesDiscordId(item.messageId)
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 160
      || /[\x00-\x1f\x7f]/.test(item.title) || !['draft', 'public'].includes(item.visibility)) return null;
    ids.add(item.id); messages.add(item.messageId);
    out.push({ id: item.id, messageId: item.messageId, title: item.title.trim(), visibility: item.visibility });
  }
  return out;
}
export function parseUpdatesInput(input, action = 'save') {
  if (action === 'clear') return exact(input, ['revision']) && revision(input.revision) ? { revision: input.revision } : null;
  if (action !== 'save' || !exact(input, ['revision', 'items']) || !revision(input.revision)) return null;
  const items = parseUpdateItems(input.items);
  return items ? { revision: input.revision, items } : null;
}
export function updatesState(value, projectId, threadId) {
  if (!updatesProjectId(projectId) || !updatesDiscordId(threadId)) return null;
  if (value === undefined) return { version: 1, projectId, threadId, revision: 0, items: [] };
  if (!exact(value, ['version', 'projectId', 'threadId', 'revision', 'items', 'updatedAt'])
    || value.version !== 1 || value.projectId !== projectId || value.threadId !== threadId || value.revision === 0) return null;
  const parsed = parseUpdatesInput({ revision: value.revision, items: value.items });
  return parsed ? { version: 1, projectId, threadId, ...parsed } : null;
}
// Extract IDs only. The browser and website never fetch a supplied message URL.
export function updatesMessageId(link, guildId, threadId) {
  if (!updatesDiscordId(guildId) || !updatesDiscordId(threadId) || typeof link !== 'string') return null;
  const match = /^https:\/\/discord\.com\/channels\/([0-9]{17,20})\/([0-9]{17,20})\/([0-9]{17,20})$/.exec(link.trim());
  return match && match[1] === guildId && match[2] === threadId ? match[3] : null;
}
