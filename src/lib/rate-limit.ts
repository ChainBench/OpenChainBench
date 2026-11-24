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

import { AI_CRAWLER_RE } from "@/data/ai-crawlers";
import { MS_PER_SECOND } from "@/lib/time-constants";

const MAX_BUCKETS = 5000;

type Bucket = {
  tokens: number;
  updatedAt: number;
  fullAt: number;
  heldUntil?: number;
};

const buckets = new Map<string, Bucket>();
const GLOBAL_PREFIX = "__global__:";

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
};

const MISCONFIGURED: RateLimitResult = {
  ok: false,
  remaining: 0,
  retryAfterSec: 60,
};

/** Known AI crawler User-Agent substrings. Matched case-insensitively.
 *  Requests from these agents bypass the per-IP throttle on read-only
 *  endpoints because the crawlers route many independent user queries
 *  through a small pool of shared egress IPs (PerplexityBot,
 *  ChatGPT-User, ClaudeBot, etc.). A burst from one IP usually means
 *  many distinct human questions, not abuse. UA spoofing is possible
 *  but the affected endpoints are read-only and explicitly designed to
 *  be cited, so the worst case of a spoofer is what we already want. */
// Derived from src/data/ai-crawlers.ts, the same list robots.ts publishes.
// This used to be a literal with "keep in sync with robots.txt" above it, and
// it drifted: ExaSearchBot, the biggest crawler on the site at 13,142 requests
// a week, and Meta-WebIndexer at 4,632 were in neither. Deriving both from one
// array is what makes the instruction true instead of hopeful.

/** True when the given User-Agent matches a known AI crawler pattern. */
export function isAiCrawler(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return AI_CRAWLER_RE.test(userAgent);
}

/** Open-ended success used when bypassing the bucket for an AI crawler.
 *  Same shape every caller already handles. */
function aiBypassResult(): RateLimitResult {
  return { ok: true, remaining: Number.POSITIVE_INFINITY, retryAfterSec: 0 };
}

/**
 * Check & consume a token for `key`. Returns ok:false when the bucket is
 * empty, with retryAfterSec hint for clients.
 *
 * Bucket refills linearly: `capacity` tokens over `windowSec` seconds.
 *
 * Optional `req`: when provided, the request's User-Agent is inspected
 * and a match against the AI crawler allowlist short-circuits the bucket
 * (no token consumed). Pass it on read-only endpoints meant to be cited
 * (citable, llm-context, stat, mcp, etc.). Omit on write endpoints or
 * anywhere UA-based bypass is undesired.
 */
export function rateLimit(
  key: string,
  capacity: number,
  windowSec: number,
  req?: Request,
): RateLimitResult {
  if (req) {
    const ua = req.headers.get("user-agent");
    if (isAiCrawler(ua)) {
      if (process.env.AI_BYPASS_DEBUG === "true") {
        // Trimmed to keep noisy UA blobs out of the log line.
        console.log(`[ai-bypass] granted to ${(ua ?? "").slice(0, 80)}`);
      }
      return aiBypassResult();
    }
  }
  if (capacity <= 0 || windowSec <= 0) {
    // Defensive: a misconfigured caller would otherwise produce Infinity
    // retry-after via /0 below. Treat as "denied with finite backoff".
    return MISCONFIGURED;
  }

  const now = Date.now();
  const held = heldResult(key, now);
  if (held) return held;
  const refillPerMs = capacity / (windowSec * 1000);
  let tokens = tokensAt(key, { capacity, refillPerMs, now });
  if (tokens < 1) {
    // Don't re-`set` on the rejected path - avoids Map churn under
    // sustained 429 spam and preserves the original updatedAt for refill.
    return emptyBucket(tokens, refillPerMs);
  }
  tokens -= 1;
  const fullAt = now + (capacity - tokens) / refillPerMs;
  buckets.set(key, { tokens, updatedAt: now, fullAt });
  if (buckets.size > MAX_BUCKETS) evictSoonestFull(key);
  return { ok: true, remaining: Math.floor(tokens), retryAfterSec: 0 };
}

type Refill = { capacity: number; refillPerMs: number; now: number };

function tokensAt(key: string, { capacity, refillPerMs, now }: Refill): number {
  const prev = buckets.get(key);
  if (!prev) return capacity;
  const elapsed = Math.max(0, now - prev.updatedAt);
  return Math.max(0, Math.min(capacity, prev.tokens + elapsed * refillPerMs));
}

function heldResult(key: string, now: number): RateLimitResult | null {
  const until = buckets.get(key)?.heldUntil ?? now;
  if (until <= now) return null;
  const retryAfterSec = Math.ceil((until - now) / MS_PER_SECOND);
  return { ok: false, remaining: 0, retryAfterSec };
}

function emptyBucket(tokens: number, refillPerMs: number): RateLimitResult {
  const retryAfterMs = Math.ceil((1 - tokens) / refillPerMs);
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return { ok: false, remaining: 0, retryAfterSec };
}

export function peekLimit(
  key: string,
  capacity: number,
  windowSec: number,
): RateLimitResult {
  if (capacity <= 0 || windowSec <= 0) return MISCONFIGURED;
  const now = Date.now();
  const held = heldResult(key, now);
  if (held) return held;
  const refillPerMs = capacity / (windowSec * 1000);
  const tokens = tokensAt(key, { capacity, refillPerMs, now });
  if (tokens < 1) return emptyBucket(tokens, refillPerMs);
  return { ok: true, remaining: Math.floor(tokens), retryAfterSec: 0 };
}

export function holdLimit(key: string, seconds: number): void {
  const now = Date.now();
  const until = now + seconds * MS_PER_SECOND;
  buckets.set(key,
    { tokens: 1, updatedAt: now, fullAt: until, heldUntil: until });
  if (buckets.size > MAX_BUCKETS) evictSoonestFull(key);
}

function evictSoonestFull(kept: string) {
  let soonestKey: string | null = null;
  let soonestAt = Infinity;
  for (const [k, v] of buckets) {
    if (k === kept || k.startsWith(GLOBAL_PREFIX)) continue;
    if (v.fullAt < soonestAt) {
      soonestAt = v.fullAt;
      soonestKey = k;
    }
  }
  if (soonestKey !== null) buckets.delete(soonestKey);
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

const IPV6_GROUPS = 8;
const IPV6_GROUP_BITS = 16;

const HOST_PREFIX = 64;
const SITE_PREFIX = 48;
const MAPPED_IPV4 = /^::ffff:(.+)$/i;
const HEX_PAIR = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;

function unmappedIpv4(ip: string): string {
  const mapped = MAPPED_IPV4.exec(ip)?.[1];
  if (!mapped) return ip;
  if (mapped.includes(".")) return mapped;
  const pair = HEX_PAIR.exec(mapped);
  if (!pair) return ip;
  const word = (hex: string | undefined) => Number.parseInt(hex ?? "0", 16);
  return [word(pair[1]), word(pair[2])]
    .flatMap((w) => [w >> BYTE_BITS, w & BYTE_MASK])
    .join(".");
}

function ipv6Network(ip: string, prefix: number): string | null {
  if (!ip.includes(":") || ip.includes(".")) return null;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const missing = Math.max(0, IPV6_GROUPS - front.length - back.length);
  const groups = ip.includes("::")
    ? [...front, ...Array<string>(missing).fill("0"), ...back]
    : front;
  const network = groups
    .slice(0, prefix / IPV6_GROUP_BITS)
    .map((g) => g.replace(/^0+(?=.)/, ""));
  return `${network.join(":")}::/${prefix}`;
}

export function clientNetworkKey(req: Request, suffix: string): string {
  const ip = unmappedIpv4(resolveClientIp(req));
  return `${ipv6Network(ip, HOST_PREFIX) ?? ip}:${suffix}`;
}

const IPV4_ADDRESS = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/;

function ipv4Subnet(ip: string): string | null {
  const prefix = IPV4_ADDRESS.exec(ip)?.[1];
  return prefix ? `${prefix}.0/24` : null;
}

export function clientSubnetKey(req: Request, suffix: string): string {
  const ip = unmappedIpv4(resolveClientIp(req));
  return `${ipv6Network(ip, SITE_PREFIX) ?? ipv4Subnet(ip) ?? ip}:${suffix}`;
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
  return rateLimit(`${GLOBAL_PREFIX}${suffix}`, capacity, windowSec);
}

export function peekGlobalLimit(
  suffix: string,
  capacity: number,
  windowSec: number,
): RateLimitResult {
  return peekLimit(`${GLOBAL_PREFIX}${suffix}`, capacity, windowSec);
}

const LOG_WINDOW_SEC = 60;

export function logAtMost(
  perMinute: number,
  name: string,
  log: () => void,
): void {
  if (globalLimit(`${name}-log`, perMinute, LOG_WINDOW_SEC).ok) log();
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
