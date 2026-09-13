import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { mediaState, mediaDiscordId } from '../src/lib/project-media-contracts.mjs';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
class InvalidImage extends Error { constructor() { super('Selected image is not a supported bounded raster image.'); } }
export function trustedAttachmentUrl(value, threadId, attachmentId) {
  if (!mediaDiscordId(threadId) || !mediaDiscordId(attachmentId) || typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'cdn.discordapp.com' && !url.port
      && !url.username && !url.password && !url.hash
      && url.pathname.startsWith(`/attachments/${threadId}/${attachmentId}/`)
      && url.pathname.split('/').length === 5 && url.pathname.split('/')[4].length > 0;
  } catch { return false; }
}
export function verifiedImage(message, item, threadId, ownerId) {
  if (!message || message.id !== item.messageId || message.channel_id !== threadId
    || message.author?.id !== ownerId || message.author?.bot === true || message.webhook_id
    || ![0, 19].includes(message.type) || !Number.isSafeInteger(message.flags) || (message.flags & 64)
    || message.message_snapshots?.length || message.message_reference?.type === 1) return null;
  if (!Array.isArray(message.attachments)) return null;
  const matches = message.attachments.filter((att) => att.id === item.attachmentId);
  if (matches.length !== 1) return null;
  const att = matches[0];
  if (att.ephemeral === true || !TYPES.has(att.content_type) || !Number.isSafeInteger(att.size)
    || att.size < 1 || att.size > MAX_IMAGE_BYTES || !Number.isSafeInteger(att.width) || !Number.isSafeInteger(att.height)
    || att.width < 1 || att.height < 1 || att.width > 8192 || att.height > 8192 || att.width * att.height > MAX_PIXELS
    || !trustedAttachmentUrl(att.url, threadId, item.attachmentId)) return null;
  return att;
}
// Fetch only the fresh Discord-supplied CDN URL, never a saved/user-supplied URL.
// Never forward a bot token, cookies or credentials to the CDN, and never follow redirects.
export async function downloadSelectedImage(att, { threadId, attachmentId, fetchImpl = fetch }) {
  if (!trustedAttachmentUrl(att.url, threadId, attachmentId)) throw new InvalidImage();
  let response;
  try { response = await fetchImpl(att.url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000) }); }
  catch { throw new Error('Selected image transport failed. Export stopped without logging the signed URL.'); }
  if ([403, 404].includes(response.status)) { await response.body?.cancel(); throw new InvalidImage(); }
  if (!response.ok) { await response.body?.cancel(); throw new Error('Selected image CDN unavailable. Retry the export.'); }
  const declared = response.headers.get('content-length');
  if ((declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_IMAGE_BYTES))
    || !TYPES.has((response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase())) {
    await response.body?.cancel(); throw new InvalidImage();
  }
  const reader = response.body?.getReader(); if (!reader) throw new InvalidImage();
  let size = 0; const chunks = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new InvalidImage(); }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof InvalidImage) throw err;
    throw new Error('Selected image stream failed. Retry the export.');
  } finally { reader.releaseLock(); }
  if (size !== att.size) throw new InvalidImage();
  const bytes = Buffer.concat(chunks);
  // Reject SVG/HTML and mislabeled files before giving bytes to the image decoder.
  const raster = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    || (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP');
  if (!raster) throw new InvalidImage();
  try {
    const result = await sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false, failOn: 'warning' })
      .rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    if (result.info.format !== 'webp' || result.info.width < 1 || result.info.height < 1 || result.data.length > MAX_IMAGE_BYTES) throw new InvalidImage();
    return { bytes: result.data, width: result.info.width, height: result.info.height };
  } catch { throw new InvalidImage(); }
}
export async function buildSelectedGallery({ rest, selection, prepared, out, dryRun = false, fetchImpl = fetch }) {
  const checked = mediaState({ ...selection, updatedAt: null }, prepared.id, prepared.profileThreadId);
  if (!checked || checked.mode !== 'selected' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(prepared.project.slug)) throw new Error('Invalid selected gallery state. Export stopped.');
  const media = [], generatedAssets = [], messages = new Map(); let omitted = 0;
  for (const item of checked.items.filter((entry) => entry.visibility === 'public')) {
    if (!messages.has(item.messageId)) {
      try { messages.set(item.messageId, await rest.get(`/channels/${checked.threadId}/messages/${item.messageId}`)); }
      catch (err) {
        if ([403, 404].includes(err?.status) || [10008, 50001, 50013].includes(err?.code)) messages.set(item.messageId, null);
        else throw new Error('Selected Discord message could not be checked. Export stopped.');
      }
    }
    const att = verifiedImage(messages.get(item.messageId), item, checked.threadId, prepared.ownerId);
    if (!att) { omitted++; continue; }
    if (dryRun) continue; // structural/source checks only; not a real image-encoding pass
    let result;
    try { result = await downloadSelectedImage(att, { threadId: checked.threadId, attachmentId: item.attachmentId, fetchImpl }); }
    catch (err) { if (err instanceof InvalidImage) { omitted++; continue; } throw err; }
    const digest = createHash('sha256').update(item.id).update('\0').update(result.bytes).digest('hex');
    const file = `selected-${digest}.webp`;
    const src = `/assets/projects/${prepared.project.slug}/_discord-export/${file}`;
    const dest = path.join(out, 'public', 'assets', 'projects', prepared.project.slug, '_discord-export');
    await fs.mkdir(dest, { recursive: true }); await fs.writeFile(path.join(dest, file), result.bytes);
    media.push({ kind: 'image', src, alt: item.alt, caption: item.caption || null, width: result.width, height: result.height });
    generatedAssets.push(src);
  }
  return { media, generatedAssets, omitted };
}
