// Optional /gameidea image sidecar. Missing/disabled configuration leaves text untouched.
import { ART_PRESETS, readImageConfig } from '../lib/gameIdeaScreenshot.js';
import { createGeminiImageClient } from './geminiImages.js';
import { createImageJobService, createImageJobStore } from './gameIdeaImageJobs.js';

export function imageReplyPayload(job, image, style) {
  return {
    files: [{ attachment: image.buffer, name: `gameplay-${job.messageId}.jpg`,
      description: `AI-generated gameplay mockup. Art direction: ${ART_PRESETS[style].name}.` }],
    reply: { messageReference: job.messageId, failIfNotExists: true },
    allowedMentions: { parse: [], repliedUser: false },
    nonce: `gi-${job.messageId}`, enforceNonce: true,
  };
}
export function createDiscordImageDelivery(client, expectedGuildId) {
  async function target(job) {
    if (!expectedGuildId || job.guildId !== expectedGuildId) return null;
    const channel = await client.channels.fetch(job.channelId, { force: true });
    if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== expectedGuildId || !channel.messages) return null;
    if (channel.isThread() && (channel.archived || channel.locked)) return null;
    const permissions = ['ViewChannel', 'ReadMessageHistory', 'AttachFiles',
      channel.isThread() ? 'SendMessagesInThreads' : 'SendMessages'];
    if (!channel.permissionsFor(client.user)?.has(permissions)) return null;
    const message = await channel.messages.fetch({ message: job.messageId, force: true });
    if (message.author?.id !== client.user.id || !message.content?.startsWith(job.idea)) return null;
    return channel;
  }
  return {
    async check(job) {
      if (process.env.GAME_IDEA_IMAGES_ENABLED !== 'true') return false;
      try { return Boolean(await target(job)); } catch { return false; }
    },
    async send(job, image, style) {
      const channel = await target(job);
      if (!channel) throw new Error('delivery_original_unavailable');
      return channel.send(imageReplyPayload(job, image, style));
    },
  };
}
export async function normaliseGameImage(image) {
  const { default: sharp } = await import('sharp');
  if (!Buffer.isBuffer(image?.buffer) || image.buffer.length > 8 * 1024 * 1024) throw new Error('image_invalid_bytes');
  const pipeline = sharp(image.buffer, { limitInputPixels: 16 * 1024 * 1024, failOn: 'warning' });
  const meta = await pipeline.metadata();
  const format = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[image.mimeType];
  if (!format || meta.format !== format || (meta.pages ?? 1) !== 1 || !meta.width || !meta.height ||
      meta.width < 640 || meta.height < 360 || Math.abs(meta.width / meta.height - 16 / 9) > 0.12) throw new Error('image_invalid_dimensions');
  const buffer = await pipeline.resize({ width: 1536, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  if (buffer.length > 6 * 1024 * 1024) throw new Error('image_upload_too_large');
  return { buffer, mimeType: 'image/jpeg' };
}

let servicePromise;
async function getService(client, cfg) {
  if (!servicePromise) {
    servicePromise = import('../firebase.js').then(({ getDb }) => createImageJobService({
      cfg, store: createImageJobStore(getDb()), model: createGeminiImageClient(cfg),
      delivery: createDiscordImageDelivery(client, process.env.GUILD_ID), normalise: normaliseGameImage,
    })).catch(err => { servicePromise = null; throw err; });
  }
  return servicePromise;
}
export async function queueGameIdeaImage({ result, message, client, style = null, theme = null }) {
  // Free madlibs and API fallbacks must stay free. Do not add images to quota errors.
  if (result?.status !== 'ok') return { status: 'skipped' };
  try {
    const cfg = readImageConfig();
    if (!cfg.enabled || !cfg.apiKey || !cfg.dailyCap) return { status: 'disabled' };
    const service = await getService(client, cfg);
    const queued = service.enqueue({ messageId: message.id, channelId: message.channelId,
      guildId: message.guildId, idea: result.text, style: style || cfg.style,
      theme: String(theme ?? '').slice(0, 120) });
    if (queued.status !== 'queued') console.info('[gameIdeaImages]', queued.status);
    return queued;
  } catch {
    // Never expose secrets/prompts or edit the successful written idea on image failure.
    console.error('[gameIdeaImages] image_setup_failed');
    return { status: 'failed' };
  }
}
