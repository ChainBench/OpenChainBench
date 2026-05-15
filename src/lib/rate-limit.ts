/**
 * In-memory per-IP token bucket. Best-effort rate limiting for public
 * routes where we have no external store (no Redis / no Upstash).
 *
 * Caveats:
 *  - State is per Vercel function instance. Fluid Compute reuses instances
 *    so a hot path benefits, but a burst across cold instances will get
 *    a higher effective ceiling than the configured value. Acceptable
 *    for our use case (abuse mitigation, not strict quotas).
 *  - Keyed on the first hop of x-forwarded-for; an attacker behind a
 *    rotating IP pool can sidestep this. Pair with platform-level
 *    protection (Vercel firewall, BotID) when bigger guarantees are needed.
 */
const buckets = new Map<string, { tokens: number; updatedAt: number }>();

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
};

/**
 * Check & consume a token for `key`. Returns ok:false when the bucket is
 * empty, with retryAfterSec hint for clients.
 *
 * Bucket refills linearly: `capacity` tokens over `windowSec` seconds.
 */
export function rateLimit(
  key: string,
  capacity: number,
  windowSec: number,
): RateLimitResult {
  const now = Date.now();
  const refillPerMs = capacity / (windowSec * 1000);
  const prev = buckets.get(key);
  let tokens: number;
  if (!prev) {
    tokens = capacity;
  } else {
    const elapsed = now - prev.updatedAt;
    tokens = Math.min(capacity, prev.tokens + elapsed * refillPerMs);
  }
  if (tokens < 1) {
    const need = 1 - tokens;
    const retryAfterMs = Math.ceil(need / refillPerMs);
    buckets.set(key, { tokens, updatedAt: now });
    return { ok: false, remaining: 0, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  }
  tokens -= 1;
  buckets.set(key, { tokens, updatedAt: now });
  if (buckets.size > 5000) pruneOldest();
  return { ok: true, remaining: Math.floor(tokens), retryAfterSec: 0 };
}

function pruneOldest() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of buckets) {
    if (v.updatedAt < cutoff) buckets.delete(k);
  }
}

/** Extract a stable client identifier from request headers. */
export function clientKey(req: Request, suffix = ""): string {
  const xff = req.headers.get("x-forwarded-for");
  const ip = xff ? xff.split(",")[0]?.trim() : req.headers.get("x-real-ip") ?? "unknown";
  return `${ip}:${suffix}`;
}

/** Helper: build a 429 JSON Response with the standard headers. */
export function tooManyRequests(retryAfterSec: number): Response {
  return new Response(
    JSON.stringify({ error: "rate_limited", retryAfterSec }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
        "Cache-Control": "no-store",
      },
    },
  );
}
