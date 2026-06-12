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

const URL_ENV = ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"] as const;
const TOKEN_ENV = ["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"] as const;

function creds(): { url: string; token: string } | null {
  const url = URL_ENV.map((k) => process.env[k]).find(Boolean);
  const token = TOKEN_ENV.map((k) => process.env[k]).find(Boolean);
  return url && token ? { url, token } : null;
}

export function storeConfigured(): boolean {
  return creds() !== null;
}

async function redis(
  cmd: (string | number)[],
  timeoutMs = 4000,
): Promise<unknown> {
  const c = creds();
  if (!c) throw new Error("materialize store: KV_REST_API_* not configured");
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

const BLOB_TTL_SEC = 24 * 3600;

/** Atomic publish: blob first, pointer swap second. */
export async function publishSnapshot(
  snap: MaterializedSnapshot,
): Promise<void> {
  const json = JSON.stringify(snap);
  const hash = contentHash(json);
  const blobKey = matKeys.blob(snap.slug, snap.sig, hash);
  const ptrKey = matKeys.pointer(snap.slug, snap.sig);
  await redis(["SET", blobKey, json, "EX", BLOB_TTL_SEC], 15_000);
  await redis(["SET", ptrKey, hash], 8_000);
}

export async function heartbeat(now = Date.now()): Promise<void> {
  await redis(["SET", matKeys.heartbeat, String(Math.floor(now / 1000))]);
}

export async function readHeartbeat(): Promise<number | null> {
  const v = await redis(["GET", matKeys.heartbeat]);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Read the current snapshot for (slug, sig). Null on miss, parse
 *  failure, or version mismatch — callers fall back to the live path. */
export async function readMaterialized(
  slug: string,
  sig: string,
): Promise<MaterializedSnapshot | null> {
  try {
    const hash = await redis(["GET", matKeys.pointer(slug, sig)]);
    if (typeof hash !== "string" || !hash) return null;
    const raw = await redis(["GET", matKeys.blob(slug, sig, hash)], 8_000);
    if (typeof raw !== "string" || !raw) return null;
    return parseSnapshot(raw);
  } catch (err) {
    console.warn(
      `materialize read failed for ${slug}/${sig || "all"}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
