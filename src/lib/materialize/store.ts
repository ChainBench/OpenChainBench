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

import { z } from "zod";
import { causeCode } from "@/lib/error-cause";
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

const HTTP_BAD_REQUEST = 400;

const WRONG_TYPE_REPLY = /\bWRONGTYPE\b/;

export class RedisReplyError extends Error {
  readonly code = "redis_refused";
  override name = "RedisReplyError";

  get wrongType(): boolean {
    return WRONG_TYPE_REPLY.test(this.message);
  }
}

export class RedisUnavailableError extends Error {
  readonly code = "redis_unavailable";
  override name = "RedisUnavailableError";
}

const restReplySchema = z
  .object({ result: z.unknown().optional(), error: z.string().optional() })
  .refine((reply) => "result" in reply || reply.error !== undefined);

const unreadableReply = (cause: unknown) =>
  new RedisUnavailableError("materialize store: unreadable reply", { cause });
const notConfigured = () =>
  new RedisUnavailableError("materialize store: no redis configured");

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw unreadableReply(err);
  }
}

async function replyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (cause) {
    throw new RedisUnavailableError("materialize store: reply cut off",
      { cause });
  }
}

async function restReplies<T>(res: Response, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(parseJson(await replyText(res)));
  if (!parsed.success) throw unreadableReply(parsed.error);
  return parsed.data;
}

const STORE_DOWN_REPLY =
  /\b(?:OOM|LOADING|READONLY|BUSY|MASTERDOWN)\b|\bERR max\b/;

function refusal(message: string, options?: ErrorOptions): Error {
  return STORE_DOWN_REPLY.test(message)
    ? new RedisUnavailableError(message, options)
    : new RedisReplyError(message, options);
}

async function httpFailure(res: Response, what: string): Promise<Error> {
  const detail = await res.text().catch(() => "");
  const message =
    `materialize store: ${what} http ${res.status}: ${detail.slice(0, 200)}`;
  return res.status === HTTP_BAD_REQUEST
    ? refusal(message)
    : new RedisUnavailableError(message);
}

function described(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = causeCode(err);
  return `${err.name}: ${err.message}${code ? ` (${code})` : ""}`;
}

async function upstashPost(
  url: string,
  token: string,
  { body, timeoutMs }: { body: unknown; timeoutMs: number },
): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new RedisUnavailableError(
      `materialize store: unreachable: ${described(cause)}`, { cause });
  }
}

async function tcpFailure(err: unknown): Promise<never> {
  const { ReplyError } = await import("ioredis");
  if (err instanceof ReplyError && err instanceof Error) {
    throw refusal(`materialize store: ${err.message}`, { cause: err });
  }
  throw new RedisUnavailableError(
    `materialize store: redis tcp failed: ${described(err)}`, { cause: err });
}

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

function tcpCommand(
  client: RedisClient,
  cmd: (string | number)[],
  timeoutMs: number,
): Promise<unknown> {
  const [name, ...args] = cmd.map(String);
  if (name === undefined) throw new TypeError("materialize store: no command");
  const result = client.call(name, ...args).catch(tcpFailure);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new RedisUnavailableError(
        `materialize store: redis tcp timeout ${name}`)),
      timeoutMs,
    );
  });
  return Promise.race([result, timeout]).finally(() => clearTimeout(timer));
}

async function redis(
  cmd: (string | number)[],
  timeoutMs = 4000,
): Promise<unknown> {
  if (tcpUrl()) return tcpTransport(await tcp()).command(cmd, timeoutMs);
  const c = creds();
  if (!c) throw notConfigured();
  const res = await upstashPost(c.url, c.token, { body: cmd, timeoutMs });
  if (!res.ok) throw await httpFailure(res, "redis");
  const body = await restReplies(res, restReplySchema);
  if (body.error) throw refusal(`materialize store: ${body.error}`);
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

// ─── Shared low-level access for other KV consumers ──────────────────
// The speedtest contribution store (src/app/api/speedtest/*) reuses this
// transport instead of dragging in a second Redis client.

/** Single command. Exported alias of the private helper above. */
export const redisCommand = redis;

/** Batched commands. Uses the Upstash REST /pipeline endpoint (one HTTP
 *  round trip for N commands); falls back to sequential execution on the
 *  TCP transport (VPS worker context, where latency is sub-ms anyway). */
export async function redisPipeline(
  cmds: (string | number)[][],
  timeoutMs = 6000,
): Promise<unknown[]> {
  return pipelineValues(await redisPipelineSettled(cmds, timeoutMs));
}

export type PipelineReply =
  | { result: unknown }
  | { refused: RedisReplyError };

export function pipelineValues(replies: PipelineReply[]): unknown[] {
  return replies.map((reply) => {
    if ("refused" in reply) throw reply.refused;
    return reply.result;
  });
}

function settled(failure: unknown): PipelineReply {
  if (failure instanceof RedisReplyError) return { refused: failure };
  throw failure;
}

async function tcpPipelineSettled(
  client: RedisClient,
  cmds: (string | number)[][],
  timeoutMs: number,
): Promise<PipelineReply[]> {
  const out: PipelineReply[] = [];
  for (const cmd of cmds) {
    const reply = tcpCommand(client, cmd, timeoutMs)
      .then((result) => ({ result }));
    out.push(await reply.catch(settled));
  }
  return out;
}

export type Command = (string | number)[];

export type RedisTransport = {
  command: (cmd: Command, timeoutMs: number) => Promise<unknown>;
  pipeline: (cmds: Command[], timeoutMs: number) => Promise<PipelineReply[]>;
};

export function tcpTransport(client: RedisClient): RedisTransport {
  return {
    command: (cmd, timeoutMs) => tcpCommand(client, cmd, timeoutMs),
    pipeline: (cmds, timeoutMs) => tcpPipelineSettled(client, cmds, timeoutMs),
  };
}

export async function redisPipelineSettled(
  cmds: (string | number)[][],
  timeoutMs = 6000,
): Promise<PipelineReply[]> {
  if (cmds.length === 0) return [];
  if (tcpUrl()) return tcpTransport(await tcp()).pipeline(cmds, timeoutMs);
  const c = creds();
  if (!c) throw notConfigured();
  const res = await upstashPost(`${c.url}/pipeline`, c.token,
    { body: cmds, timeoutMs });
  if (!res.ok) throw await httpFailure(res, "pipeline");
  const body = await restReplies(res, z.array(restReplySchema));
  if (body.length !== cmds.length) {
    throw unreadableReply(`${body.length} replies to ${cmds.length}`);
  }
  return body.map((b) =>
    b.error
      ? settled(refusal(`materialize store: ${b.error}`))
      : { result: b.result });
}
