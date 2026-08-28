const MAX_URL_LENGTH = 2048;
const JAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function normalizeProjectUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeJamId(value) {
  const jamId = String(value || '').trim();
  return JAM_ID_RE.test(jamId) ? jamId : null;
}
