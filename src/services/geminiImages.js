// Gemini Interactions REST API. No new SDK dependency; Node >=22 provides fetch.
// Docs: https://ai.google.dev/gemini-api/docs/image-generation
// https://ai.google.dev/gemini-api/docs/structured-output
import { BRIEF_SCHEMA, REVIEW_SCHEMA, DIRECTOR_SYSTEM, directorInput, imagePrompt, reviewPrompt, validateBrief, validateReview } from '../lib/gameIdeaScreenshot.js';

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function readBoundedJson(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('gemini_response_too_large');
  if (!response.body) throw new Error('gemini_empty_response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('gemini_response_too_large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export function outputBlocks(response) {
  if (response?.status !== 'completed' || !Array.isArray(response.steps)) throw new Error('gemini_incomplete');
  return response.steps.filter(s => s.type === 'model_output').flatMap(s => Array.isArray(s.content) ? s.content : []);
}
export function decodeGeneratedImage(response) {
  const images = outputBlocks(response).filter(p => p.type === 'image');
  if (images.length !== 1) throw new Error('gemini_expected_one_image');
  const image = images[0];
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mime_type) ||
      typeof image.data !== 'string' || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      image.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error('gemini_invalid_image');
  const buffer = Buffer.from(image.data, 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || buffer.toString('base64') !== image.data) throw new Error('gemini_invalid_image');
  return { buffer, mimeType: image.mime_type };
}

export function createGeminiImageClient(cfg, fetchImpl = globalThis.fetch) {
  async function post(body, image = false) {
    if (!cfg.apiKey) throw new Error('gemini_missing_key');
    let response;
    try {
      response = await fetchImpl(GEMINI_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(cfg.timeoutMs),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body: JSON.stringify({ ...body, store: false }),
      });
    } catch {
      // Do not log provider bodies, headers, keys or user prompts. Do not retry ambiguous paid calls.
      throw new Error('gemini_network_or_timeout');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`gemini_http_${response.status}`);
    }
    try {
      return await readBoundedJson(response, image ? 12 * 1024 * 1024 : 128 * 1024);
    } catch (err) {
      if (err.message === 'gemini_response_too_large') throw err;
      throw new Error('gemini_invalid_response');
    }
  }
  async function structured(input, schema, system = '') {
    const res = await post({
      model: cfg.textModel, input, ...(system ? { system_instruction: system } : {}),
      response_format: { type: 'text', mime_type: 'application/json', schema },
      generation_config: { max_output_tokens: 4096 },
    });
    const text = outputBlocks(res).filter(p => p.type === 'text').map(p => p.text).join('');
    if (!text || text.length > 20000) throw new Error('gemini_invalid_json');
    try { return JSON.parse(text); } catch { throw new Error('gemini_invalid_json'); }
  }
  return {
    async direct(idea, style, theme) {
      return validateBrief(await structured(directorInput(idea, style, theme), BRIEF_SCHEMA, DIRECTOR_SYSTEM), style);
    },
    async render(brief, failedReview = null) {
      return decodeGeneratedImage(await post({
        model: cfg.imageModel, input: imagePrompt(brief, failedReview),
        response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '16:9', image_size: '1K' },
      }, true));
    },
    async review(image, brief) {
      return validateReview(await structured([
        { type: 'text', text: reviewPrompt(brief) },
        { type: 'image', mime_type: image.mimeType, data: image.buffer.toString('base64') },
      ], REVIEW_SCHEMA));
    },
  };
}
