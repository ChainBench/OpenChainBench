/**
 * In-memory per-IP token bucket. Best-effort rate limiting for public
 * routes where we have no external store (no Redis / no Upstash).
 *
 * Caveats:
 *  - State is per Vercel function instance. Fluid Compute reuses instances
 *    so a hot path benefits, but a burst across cold instances will get
 *    a higher effective ceiling than the configured value. Acceptable
 *    for our use case (abuse mitigation, not strict quotas).
 *  - Pair with platform-level protection (Vercel firewall, BotID) when
 *    bigger guarantees are needed.
 */

/** Hard cap on the in-memory bucket Map. Prevents an attacker rotating
 *  X-Forwarded-For across millions of fake IPs from growing the Map
 *  unboundedly. When the cap is hit we evict the least-recently-updated
 *  entry, which under attack will be the spoofed keys (they don't come
 *  back) rather than the real victim IP buckets. */
const MAX_BUCKETS = 5000;

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
  if (capacity <= 0 || windowSec <= 0) {
    // Defensive: a misconfigured caller would otherwise produce Infinity
    // retry-after via /0 below. Treat as "denied with finite backoff".
    return { ok: false, remaining: 0, retryAfterSec: 60 };
  }

  const now = Date.now();
  const refillPerMs = capacity / (windowSec * 1000);
  const prev = buckets.get(key);
  let tokens: number;
  if (!prev) {
    tokens = capacity;
  } else {
    // Clamp `elapsed` so a clock step backward (NTP correction) can't
    // produce negative tokens that lock the bucket forever.
    const elapsed = Math.max(0, now - prev.updatedAt);
    tokens = Math.max(0, Math.min(capacity, prev.tokens + elapsed * refillPerMs));
  }
  if (tokens < 1) {
    const need = 1 - tokens;
    const retryAfterMs = Math.ceil(need / refillPerMs);
    // Don't re-`set` on the rejected path - avoids Map churn under
    // sustained 429 spam and preserves the original updatedAt for refill.
    return { ok: false, remaining: 0, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  }
  tokens -= 1;
  buckets.set(key, { tokens, updatedAt: now });
  if (buckets.size > MAX_BUCKETS) evictOne();
  return { ok: true, remaining: Math.floor(tokens), retryAfterSec: 0 };
}

/** Evict the least-recently-updated bucket. Single-pass O(n) - n is
 *  bounded to MAX_BUCKETS, so amortised O(1) per request. Cheaper than
 *  the previous age-cutoff sweep that did full scans under load. */
function evictOne() {
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [k, v] of buckets) {
    if (v.updatedAt < oldestAt) {
      oldestAt = v.updatedAt;
      oldestKey = k;
    }
  }
  if (oldestKey !== null) buckets.delete(oldestKey);
}

/** Extract a stable client identifier from request headers.
 *
 *  Trust order (Vercel-aware):
 *  1. `x-vercel-forwarded-for` - Vercel's vetted client IP. Single value,
 *     not spoofable by the client (the platform sets it).
 *  2. `x-real-ip` - same in most reverse-proxy setups.
 *  3. **Last** hop of `x-forwarded-for` - Vercel APPENDS its observed
 *     client IP to whatever the request brought in. Reading the FIRST
 *     hop is exactly the spoofable value an attacker pre-injected; the
 *     last hop is the platform-attached one.
 *  4. `"unknown"` fallback - folds anonymous traffic into one shared
 *     bucket (acceptable: protects the route from /0 IP attribution). */
export function clientKey(req: Request, suffix = ""): string {
  const ip = resolveClientIp(req);
  return `${ip}:${suffix}`;
}

function resolveClientIp(req: Request): string {
  // Vercel sets x-vercel-forwarded-for to a single vetted IP. Prefer it
  // - it's the only header on this list that an external client cannot
  // forge.
  const vercel = req.headers.get("x-vercel-forwarded-for");
  if (vercel) {
    const v = vercel.split(",")[0]?.trim();
    if (v) return v;
  }
  // Fallback: the LAST hop of x-forwarded-for. Vercel APPENDS its observed
  // client IP to whatever the request brought in, so the last entry is
  // platform-attached. We DO NOT trust x-real-ip - Vercel never sets it,
  // so any value present came from the client and is fully attacker-
  // controlled.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "unknown";
}

/** Site-wide cap. Cheap "every-IP-bucket" limit composed on top of the
 *  per-IP bucket - guards against distributed amplification (many IPs
 *  flooding /api/report, e.g.) where the per-IP cap is per-actor but a
 *  coordinated swarm can still saturate the route. Key the global bucket
 *  by the route suffix, not by IP. */
export function globalLimit(suffix: string, capacity: number, windowSec: number): RateLimitResult {
  return rateLimit(`__global__:${suffix}`, capacity, windowSec);
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
