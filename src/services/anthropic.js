// Shared Anthropic plumbing for the features that call Claude (the digest's chat recap,
// the /gameidea generator). Everything model-related funnels through here so the safety
// properties live in one place:
//
//   - callClaude() is a single bounded, no-tools text call. On the default model it adds
//     the server-side refusal fallback (a safety decline reroutes to another Claude model
//     inside the same request) and returns null on a refusal that survives the chain, so
//     callers always degrade to their template fallback instead of erroring out.
//   - scrubModelOutput() runs on every model reply before it can reach a channel:
//     mass-pings are neutralised with a zero-width space, raw mention syntax is dropped,
//     and the length is capped. Callers additionally send with allowedMentions: parse [].
//
// The API key is env-only (it's a secret; the Firestore config doc is not for secrets).

import Anthropic from '@anthropic-ai/sdk';
import { config as envConfig } from '../config.js';

let client = null;

export function anthropicConfigured() {
  return Boolean(envConfig.anthropicApiKey);
}

export function getAnthropic() {
  if (!client) client = new Anthropic({ apiKey: envConfig.anthropicApiKey });
  return client;
}

// Scrub model output before it can reach a channel: neutralise mass-pings (zero-width
// space after the @), drop raw mention syntax, and enforce the length cap.
//
// Over-length text is cut at the last complete LINE under the cap (the digest recap is
// line-structured, so dropping the final line reads as intended, not injured); a single
// huge line falls back to the last sentence end, then the last word + an ellipsis. The
// >50%-of-cap guards stop a pathological input from truncating to almost nothing.
export function scrubModelOutput(text, { maxChars = 1100 } = {}) {
  let out = text
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    .replace(/<@[!&]?\d+>/g, '')
    .trim();
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const lastLine = cut.lastIndexOf('\n');
    const lastSentence = cut.lastIndexOf('. ');
    if (lastLine > maxChars * 0.5) {
      out = cut.slice(0, lastLine).trimEnd();
    } else if (lastSentence > maxChars * 0.5) {
      out = cut.slice(0, lastSentence + 1);
    } else {
      out = `${cut.slice(0, cut.lastIndexOf(' ')).trimEnd()}…`;
    }
  }
  return out;
}

// One bounded text-only call. Returns { text, model, usage } or null (refusal / empty).
// Throws on transport/API errors — callers catch and fall back.
//
// The extras (refusal-fallback beta, effort control) are only attached on the known
// default model; any other configured model gets a plain request, so swapping in e.g.
// claude-haiku-4-5 for cost never trips on a parameter that model doesn't support.
export async function callClaude({ model, system, userContent, maxTokens = 8000, effort = null }) {
  const request = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userContent }],
  };

  const api = getAnthropic();
  const res =
    model === 'claude-opus-5'
      ? await api.beta.messages.create({
          ...request,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          ...(effort ? { output_config: { effort } } : {}),
        })
      : await api.messages.create(request);

  if (res.stop_reason === 'refusal') return null;

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) return null;

  return { text, model: res.model, usage: res.usage };
}
