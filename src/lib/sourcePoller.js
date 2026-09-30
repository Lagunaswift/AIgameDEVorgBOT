const MINUTE_MS = 60_000;

export function retryAfterMilliseconds(value, nowMs) {
  if (value == null || String(value).trim() === '') return 0;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const milliseconds = Number(text) * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : 0;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : 0;
}

// Process-local, per-source circuit breaker. A redeploy makes one fresh probe.
// No cached success is returned during an outage: callers must retain degraded health.
export function createSourcePoller({ now = Date.now } = {}) {
  const failures = new Map();
  const inFlight = new Map();

  return async function pollSource(name, load) {
    if (inFlight.has(name)) return inFlight.get(name);
    const previous = failures.get(name);
    if (previous && now() < previous.nextAttemptAt) {
      return { ok: false, ...previous, skipped: true };
    }

    const pending = Promise.resolve().then(async () => {
      try {
        const value = await load();
        failures.delete(name);
        return { ok: true, value, recovered: Boolean(previous) };
      } catch (error) {
        const count = (previous?.count || 0) + 1;
        const base = [401, 403, 429].includes(error?.status) ? 30 * MINUTE_MS : 2 * MINUTE_MS;
        const exponential = Math.min(6 * 60 * MINUTE_MS, base * 2 ** Math.min(count - 1, 16));
        const failedAt = now();
        // Bound a malformed/extreme upstream Retry-After to one day; normal values
        // take precedence over our own backoff, including HTTP-date headers.
        const retryAfter = Math.min(24 * 60 * MINUTE_MS, retryAfterMilliseconds(error?.retryAfter, failedAt));
        const state = { count, error, nextAttemptAt: failedAt + Math.max(exponential, retryAfter) };
        failures.set(name, state);
        return { ok: false, ...state, skipped: false };
      }
    });
    inFlight.set(name, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(name);
    }
  };
}
