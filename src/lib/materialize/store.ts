/**
 * Upstash Redis (ex-Vercel KV) client for materialized snapshots, REST
 * API so it works identically from Vercel functions and the Railway
 * worker, with zero connection management. Plain string keys only
 * (hash fields cap at 32KB; strings allow multi-MB values).
 *
 * Publish protocol (writer = worker only):
 *   1. SET ocb:mat:v1:<slug>:<sig>:<hash> = snapshot JSON (TTL 24h)
 *   2. SET ocb:mat:v1:<slug>:<sig>:current = <hash>
 * Readers GET the pointer then the blob: never a partial snapshot.
 */

import {
  matKeys,
  parseSnapshot,
  type MaterializedSnapshot,
} from "./schema";

// Type-only: erased at build time, ioredis itself stays a dynamic import.
type RedisClient = import("ioredis").Redis;

// Transport selection. OCB_REDIS_URL (or REDIS_URL) → plain Redis over
// TCP via ioredis: the Railway Redis next to the worker, no request
// quotas (the Upstash free tier's 500k commands/month died in 1.5 days
// under this architecture's ~300k commands/day). Falls back to the
// Upstash REST creds when no TCP URL is set. Reads from Vercel cross
// the public Railway TCP proxy (~50-100ms) — amortized to ~1/min/key by
// the ISR layer above, so latency is a non-issue; the payload is public
// benchmark data and the password is rotatable.
const TCP_ENV = ["OCB_REDIS_URL", "REDIS_URL"] as const;
const URL_ENV = ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"] as const;
const TOKEN_ENV = ["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"] as const;

function tcpUrl(): string | null {
  return TCP_ENV.map((k) => process.env[k]).find(Boolean) ?? null;
}

function creds(): { url: string; token: string } | null {
  const url = URL_ENV.map((k) => process.env[k]).find(Boolean);
  const token = TOKEN_ENV.map((k) => process.env[k]).find(Boolean);
  return url && token ? { url, token } : null;
}

export function storeConfigured(): boolean {
  return tcpUrl() !== null || creds() !== null;
}

// Lazy ioredis singleton: one connection per runtime instance, reused
// across invocations (Vercel Fluid keeps instances warm; the worker is
// a long-lived process anyway).
let tcpClient: RedisClient | null = null;
async function tcp(): Promise<RedisClient> {
  if (tcpClient) return tcpClient;
  const { default: Redis } = await import("ioredis");
  tcpClient = new Redis(tcpUrl()!, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    enableOfflineQueue: true,
  });
  return tcpClient;
}

async function redis(
  cmd: (string | number)[],
  timeoutMs = 4000,
): Promise<unknown> {
  if (tcpUrl()) {
    const client = await tcp();
    const [name, ...args] = cmd.map(String);
    const result = client.call(name, ...args);
    const timeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`materialize store: redis tcp timeout ${name}`)),
        timeoutMs,
      ),
    );
    return Promise.race([result, timeout]);
  }
  const c = creds();
  if (!c) throw new Error("materialize store: no redis configured");
  const res = await fetch(c.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `materialize store: redis http ${res.status}: ${detail.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (body.error) throw new Error(`materialize store: ${body.error}`);
  return body.result;
}

function contentHash(s: string): string {
  // FNV-1a 32-bit, hex. Collision risk is irrelevant: the hash only
  // namespaces blob keys under one (slug, sig) and old blobs expire.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// Short safety-net TTL only. Every sweep produces a new hash (dataAsOf
// changes), so blobs MUST be deleted on pointer swap: with a 24h TTL the
// per-minute tier-A cadence accumulated ~4300 orphan blobs in one night
// and blew the Upstash 256MB quota, turning every write into an http 400
// (worker looked alive, store silently froze).
const BLOB_TTL_SEC = 2 * 3600;

/** Atomic publish: blob first, pointer swap second, then delete the
 *  previously-pointed blob (readers that already fetched the old hash
 *  finish their GET; new readers see the new pointer). */
export async function publishSnapshot(
  snap: MaterializedSnapshot,
): Promise<void> {
  const json = JSON.stringify(snap);
  const hash = contentHash(json);
  const blobKey = matKeys.blob(snap.slug, snap.sig, hash);
  const ptrKey = matKeys.pointer(snap.slug, snap.sig);
  const prevHash = await redis(["GET", ptrKey], 5_000).catch(() => null);
  await redis(["SET", blobKey, json, "EX", BLOB_TTL_SEC], 15_000);
  await redis(["SET", ptrKey, hash], 8_000);
  if (typeof prevHash === "string" && prevHash && prevHash !== hash) {
    await redis(
      ["DEL", matKeys.blob(snap.slug, snap.sig, prevHash)],
      5_000,
    ).catch(() => {});
  }
  // Last-known-good copy, no TTL: the read-path's fallback when the
  // pointer/blob pair is gone (worker outage past BLOB_TTL_SEC, DEL
  // race, transient miss). Best-effort — a failed LKG write must not
  // fail the publish, the fresh path above is already committed.
  await redis(["SET", matKeys.lkg(snap.slug, snap.sig), json], 15_000).catch(
    (err) =>
      console.warn(
        `materialize lkg write failed for ${snap.slug}/${snap.sig || "all"}: ${err instanceof Error ? err.message : err}`,
      ),
  );
}

/** Refresh the current blob's safety-net TTL without rewriting it.
 *  Called when the worker decides to KEEP the previous snapshot (bench
 *  collapsed this sweep): without this, a bench that stays broken for
 *  longer than BLOB_TTL_SEC would silently lose its carried-forward
 *  data when the blob expires, defeating "the data is always there". */
export async function touchSnapshot(slug: string, sig: string): Promise<void> {
  const hash = await redis(["GET", matKeys.pointer(slug, sig)], 5_000);
  if (typeof hash !== "string" || !hash) return;
  await redis(["EXPIRE", matKeys.blob(slug, sig, hash), BLOB_TTL_SEC], 5_000);
}

export async function heartbeat(now = Date.now()): Promise<void> {
  await redis(["SET", matKeys.heartbeat, String(Math.floor(now / 1000))]);
}

export async function readHeartbeat(): Promise<number | null> {
  const v = await redis(["GET", matKeys.heartbeat]);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Read the current snapshot for (slug, sig), falling back to the
 *  last-known-good copy when the fresh pointer/blob path misses. Null
 *  only when the bench has never published (or on schema-version
 *  mismatch) — callers then render the draft placeholder. */
export async function readMaterialized(
  slug: string,
  sig: string,
): Promise<MaterializedSnapshot | null> {
  try {
    const hash = await redis(["GET", matKeys.pointer(slug, sig)]);
    if (typeof hash === "string" && hash) {
      const raw = await redis(["GET", matKeys.blob(slug, sig, hash)], 8_000);
      if (typeof raw === "string" && raw) {
        const snap = parseSnapshot(raw);
        if (snap) return snap;
      }
    }
  } catch (err) {
    console.warn(
      `materialize read failed for ${slug}/${sig || "all"}: ${err instanceof Error ? err.message : err}`,
    );
  }
  // Fresh path missed: serve the stamped-stale LKG copy instead of
  // collapsing to the "awaiting" placeholder. dataAsOf inside the
  // snapshot keeps the freshness badge honest about the age.
  try {
    const raw = await redis(["GET", matKeys.lkg(slug, sig)], 8_000);
    if (typeof raw !== "string" || !raw) return null;
    return parseSnapshot(raw);
  } catch (err) {
    console.warn(
      `materialize lkg read failed for ${slug}/${sig || "all"}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
