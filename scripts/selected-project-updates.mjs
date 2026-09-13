import { UPDATES_COLLECTION, updatesState, updatesDiscordId } from '../src/lib/project-updates-contracts.mjs';
import { stripMarkdown } from './site-export-shared.mjs';

// Public excerpts contain only the selected author's own message.content. Never read
// referenced_message, embeds, attachments, snapshots or other members' replies.
export function updateExcerpt(content) {
  if (typeof content !== 'string' || content.length > 10000) return null;
  let text = content
    .replace(/(^|\n) {0,3}>>>[\s\S]*/g, '')
    .replace(/^ {0,3}>[^\n]*(?:\n|$)/gm, '')
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/\|\|[\s\S]*?(?:\|\||$)/g, '')
    .replace(/<@!?[0-9]+>|<@&[0-9]+>|<#[0-9]+>/g, '')
    .replace(/@everyone\b|@here\b/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s<>]+/gi, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  text = stripMarkdown(text).slice(0, 500).trim();
  // Do not leave a split surrogate at the end of a UTF-16 bounded excerpt.
  text = text.replace(/[\uD800-\uDBFF]$/, '').trim();
  return text || null;
}
export function verifiedUpdate(message, item, threadId, ownerId, guildId) {
  if (!message || message.id !== item.messageId || message.channel_id !== threadId
    || (message.guild_id !== undefined && message.guild_id !== guildId)
    || message.author?.id !== ownerId || message.author?.bot === true || message.webhook_id
    || ![0, 19].includes(message.type) || !Number.isSafeInteger(message.flags) || message.flags < 0
    || (message.flags & (2 | 8 | 64 | 128 | 16384))
    || message.message_snapshots?.length || message.message_reference?.type === 1) return null;
  if (typeof message.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(message.timestamp)) return null;
  const time = new Date(message.timestamp);
  if (!Number.isFinite(time.getTime()) || time.toISOString().slice(0,19) !== message.timestamp.slice(0,19)) return null;
  const summary = updateExcerpt(message.content);
  return summary ? { type: 'project-update', title: item.title, date: time.toISOString(), summary,
    url: `https://discord.com/channels/${guildId}/${threadId}/${item.messageId}` } : null;
}
// Called only after the existing live Project approval gate succeeds. A missing
// selection is backwards-compatible. Never enumerate the private collection.
export async function readSelectedUpdates({ rest, db, prepared, guildId }) {
  if (!updatesDiscordId(guildId) || !updatesDiscordId(prepared.ownerId)) throw new Error('Invalid update source identity.');
  const snap = await db.collection(UPDATES_COLLECTION).doc(prepared.id).get();
  if (snap.exists && snap.id !== prepared.id) throw new Error('Update selection identity mismatch.');
  const state = updatesState(snap.exists ? snap.data() : undefined, prepared.id, prepared.profileThreadId);
  if (!state) throw new Error('Saved update choices are malformed or belong to another source. Export stopped.');
  const activities = []; let omitted = 0;
  for (const item of state.items.filter((entry) => entry.visibility === 'public')) {
    let message;
    try { message = await rest.get(`/channels/${state.threadId}/messages/${item.messageId}`); }
    catch (err) {
      if ([403,404].includes(err?.status) || [10003,10008,50001,50013].includes(err?.code)) { omitted++; continue; }
      throw new Error('Selected development message could not be checked. Export stopped.');
    }
    const activity = verifiedUpdate(message, item, state.threadId, prepared.ownerId, guildId);
    if (activity) activities.push(activity); else omitted++;
  }
  return { activities, omitted };
}
