/**
 * Cohort-level snapshot layer for the hub pages (/perps, /hyperliquid).
 *
 * Mirrors the per-bench `src/lib/materialize/store.ts` pattern, simplified
 * for cohort aggregates: one blob per key, no pointer indirection, single
 * envelope `{ data, asOf }` with a TTL safety net.
 *
 * Why this exists: hub pages fetch live from Prom on every ISR cycle. A
 * single Prom hiccup (Railway redeploy, scrape miss, harness restart)
 * stores a null cohort in the Vercel ISR cache and the user sees "..."
 * everywhere until the next refresh. With this layer a Vercel cron writes
 * a fresh JSON every 60s, the fetcher reads it first, and only falls
 * through to Prom when the snapshot is missing or stale.
 *
 * Storage: Upstash REST (KV_REST_API_URL + KV_REST_API_TOKEN, falling back
 * to UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN for parity with the
 * materialize layer). When neither pair is configured, every function is a
 * silent no-op so the live Prom path keeps working in local dev.
 */

const URL_ENV = ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"] as const;
const TOKEN_ENV = ["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"] as const;

const KEY_PREFIX = "ocb:cohort:";
const KEY_SUFFIX = ":v1";
/** Safety-net TTL on the blob itself. Cron writes every minute so the
 *  blob normally rolls over well within this window; the TTL only kicks
 *  in if the cron is dead. 24h matches the materialize layer's intent
 *  ("data is always there for a day even if the writer dies"). */
const BLOB_TTL_SEC = 24 * 60 * 60;
/** Default staleness ceiling for the reader. 10 minutes covers ~10 cron
 *  misses; anything older and the reader prefers a fresh Prom hit. */
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

type Envelope<T> = { data: T; asOf: number };

function creds(): { url: string; token: string } | null {
  const url = URL_ENV.map((k) => process.env[k]?.trim()).find(Boolean);
  const token = TOKEN_ENV.map((k) => process.env[k]?.trim()).find(Boolean);
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

function isConfigured(): boolean {
  return creds() !== null;
}

function blobKey(key: string): string {
  return `${KEY_PREFIX}${key}${KEY_SUFFIX}`;
}

async function redisCommand(
  cmd: (string | number)[],
  timeoutMs = 4_000,
): Promise<unknown> {
  const c = creds();
  if (!c) throw new Error("cohort-snapshot: no upstash creds");
  const res = await fetch(c.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `cohort-snapshot: http ${res.status}: ${detail.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (body.error) throw new Error(`cohort-snapshot: ${body.error}`);
  return body.result;
}

/**
 * Write a fresh cohort snapshot. Called from the Vercel cron after a
 * successful live Prom fetch (or from the reader's own fall-through path
 * after a brownout-recovery fetch). Silently no-ops when creds are
 * absent. Failures throw so the cron logs them.
 */
export async function writeCohortSnapshot<T>(
  key: string,
  data: T,
): Promise<void> {
  if (!isConfigured()) return;
  const envelope: Envelope<T> = { data, asOf: Date.now() };
  const json = JSON.stringify(envelope);
  await redisCommand(
    ["SET", blobKey(key), json, "EX", BLOB_TTL_SEC],
    8_000,
  );
}

/**
 * Read the most recent cohort snapshot. Returns null when:
 *   - creds are not configured
 *   - the blob key is missing
 *   - the payload fails JSON parse / envelope shape check
 *   - the envelope's asOf is older than maxAgeMs
 *   - the network call fails or times out
 *
 * Caller is expected to fall through to the live Prom path on null.
 */
export async function readCohortSnapshot<T>(
  key: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<{ data: T; asOfMs: number; ageMs: number } | null> {
  if (!isConfigured()) return null;
  try {
    const raw = await redisCommand(["GET", blobKey(key)], 3_000);
    if (typeof raw !== "string" || !raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("data" in parsed) ||
      !("asOf" in parsed)
    ) {
      return null;
    }
    const envelope = parsed as Envelope<T>;
    const asOfMs = Number(envelope.asOf);
    if (!Number.isFinite(asOfMs) || asOfMs <= 0) return null;
    const ageMs = Date.now() - asOfMs;
    if (ageMs > maxAgeMs) return null;
    return { data: envelope.data, asOfMs, ageMs };
  } catch (err) {
    console.warn(
      `cohort-snapshot read failed for ${key}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

export function cohortSnapshotConfigured(): boolean {
  return isConfigured();
}
