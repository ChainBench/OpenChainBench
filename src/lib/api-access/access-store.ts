import { z } from "zod";
import {
  type Command,
  type PipelineReply,
  RedisReplyError,
  type RedisTransport,
  RedisUnavailableError,
  pipelineValues,
} from "@/lib/materialize/store";
import { MS_PER_SECOND, SECONDS_PER_DAY } from "@/lib/time-constants";
import { type AccessRequest, accessRequestSchema } from "./access-request";
import {
  ACCESS_STATUSES,
  type AccessStatus,
  DECLINED_KEPT_DAYS,
  MAX_PENDING,
  type StatusCounts,
  statusCountsSchema,
} from "./contract";

const TIMEOUT_MS = 3000;
const PRUNE_TIMEOUT_MS = 1000;
const LIST_LIMIT = 500;
const MAX_LOGGED_REPLY = 100;
const DECLINED_KEPT_SEC = DECLINED_KEPT_DAYS * SECONDS_PER_DAY;

const CREATE = `
local sent = tonumber(redis.call('GET', KEYS[4]) or '0')
if sent >= tonumber(ARGV[5]) then return {-2, redis.call('TTL', KEYS[4])} end
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[4]) then return {-1, 0} end
if redis.call('EXISTS', KEYS[1]) == 1 then return {0, 0} end
redis.call('HSET', KEYS[1], 'doc', ARGV[1], 'version', '1')
redis.call('SET', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[2])
if redis.call('INCR', KEYS[4]) == 1 then
  redis.call('EXPIRE', KEYS[4], ARGV[6])
end
return {1, 0}`;

const createReply = z.tuple([z.number(), z.number()]);

const COMMIT = `
local current = redis.call('HGET', KEYS[1], 'version') or '0'
if current ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'doc', ARGV[2],
  'version', tostring(tonumber(current) + 1))
if KEYS[2] ~= KEYS[3] then
  redis.call('ZREM', KEYS[2], ARGV[4])
  redis.call('ZADD', KEYS[3], ARGV[5], ARGV[4])
end
if ARGV[6] ~= '' then redis.call('HDEL', KEYS[4], ARGV[6]) end
if ARGV[7] ~= '' then redis.call('HSET', KEYS[4], ARGV[7], ARGV[4]) end
local drops = tonumber(ARGV[3])
for i = 6, #KEYS do
  if i <= drops + 5 then
    redis.call('DEL', KEYS[i])
  else
    redis.call('SET', KEYS[i], ARGV[4])
  end
end
if ARGV[8] ~= '' then redis.call('EXPIRE', KEYS[1], ARGV[8]) end
local left = redis.call('TTL', KEYS[1])
if left > 0 then redis.call('EXPIRE', KEYS[5], left) end
return 1`;

export type StoredRequest = { request: AccessRequest; version: string };

type SenderCap = { sender: string; perWindow: number; windowSec: number };
type Inserted = "stored" | "full" | { waitSec: number };

type StoreFailure =
  | "store_unavailable"
  | "store_unexpected"
  | "record_unreadable";

export class AccessStoreError extends Error {
  override name = "AccessStoreError";

  constructor(
    readonly code: StoreFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  get unsent(): boolean {
    return this.cause instanceof RedisUnavailableError && this.cause.unsent;
  }
}

type Listed = {
  requests: AccessRequest[];
  counts: StatusCounts;
  unreadable: string[];
};

const unexpected = (what: string, reply: unknown) =>
  new AccessStoreError(
    "store_unexpected",
    `unexpected Redis reply to ${what}: ` +
      String(JSON.stringify(reply)).slice(0, MAX_LOGGED_REPLY),
  );

const activeKeyHash = (req: AccessRequest): string | null =>
  req.status === "approved" ? (req.key?.hash ?? null) : null;

const refusedAsWrongType = (err: AccessStoreError) =>
  err.cause instanceof RedisReplyError && err.cause.wrongType;

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof RedisReplyError) {
      throw new AccessStoreError("store_unexpected",
        "access store refused the command", { cause });
    }
    if (cause instanceof RedisUnavailableError) {
      throw new AccessStoreError("store_unavailable",
        "access store unreachable", { cause });
    }
    throw cause;
  }
}

function parseStored(id: string, reply: unknown): StoredRequest | null {
  if (!Array.isArray(reply)) {
    console.error("api access record reply is not a list", id);
    return null;
  }
  const [doc, version] = reply;
  if (doc === null || doc === undefined) {
    console.error("api access record missing", id);
    return null;
  }
  if (typeof doc !== "string" || typeof version !== "string") {
    console.error("api access record malformed", id);
    return null;
  }
  try {
    const parsed = accessRequestSchema.safeParse(JSON.parse(doc));
    if (parsed.success) return { request: parsed.data, version };
    console.error("api access record does not parse", id, parsed.error);
  } catch {
    console.error("api access record is not JSON", id);
  }
  return null;
}

function storeKeys(namespace: string) {
  return {
    record: (id: string) => `${namespace}req:${id}`,
    token: (hash: string) => `${namespace}token:${hash}`,
    keyIndex: `${namespace}keys`,
    status: (status: AccessStatus) => `${namespace}status:${status}`,
    sender: (hash: string) => `${namespace}sender:${hash}`,
  };
}

const flatPairs = z.array(z.string()).refine((r) => r.length % 2 === 0);
type StoreKeys = ReturnType<typeof storeKeys>;

const readRecord = (k: StoreKeys, id: string): Command => [
  "HMGET",
  k.record(id),
  "doc",
  "version",
];

function createCommand(
  k: StoreKeys,
  req: AccessRequest,
  cap: SenderCap,
): Command {
  const keys = [
    k.record(req.id),
    k.token(req.tokenHash),
    k.status(req.status),
    k.sender(cap.sender),
  ];
  const args = [
    JSON.stringify(req),
    req.id,
    req.createdAt,
    MAX_PENDING,
    cap.perWindow,
    cap.windowSec,
  ];
  return ["EVAL", CREATE, keys.length, ...keys, ...args];
}

function commitCommand(
  k: StoreKeys,
  prev: StoredRequest,
  next: AccessRequest,
): Command {
  const drops: string[] = [];
  const pointers: string[] = [];
  if (prev.request.tokenHash !== next.tokenHash) {
    drops.push(k.token(prev.request.tokenHash));
    pointers.push(k.token(next.tokenHash));
  }
  const before = activeKeyHash(prev.request);
  const after = activeKeyHash(next);
  const changed = before !== after;
  const keys = [
    k.record(next.id),
    k.status(prev.request.status),
    k.status(next.status),
    k.keyIndex,
    k.token(next.tokenHash),
    ...drops,
    ...pointers,
  ];
  const args = [
    prev.version,
    JSON.stringify(next),
    drops.length,
    next.id,
    next.createdAt,
    changed ? (before ?? "") : "",
    changed ? (after ?? "") : "",
    declinedNow(prev.request, next) ? DECLINED_KEPT_SEC : "",
  ];
  return ["EVAL", COMMIT, keys.length, ...keys, ...args];
}

function recordFrom(
  id: string,
  reply: PipelineReply | undefined,
): StoredRequest | null {
  if (!reply) {
    throw new AccessStoreError("store_unexpected",
      "access store got no reply for a record read");
  }
  if ("result" in reply) return parseStored(id, reply.result);
  if (!reply.refused.wrongType) {
    throw new AccessStoreError("store_unexpected",
      "access store refused a record read", { cause: reply.refused });
  }
  console.error("api access record refused", id, reply.refused.message);
  return null;
}

const declinedNow = (prev: AccessRequest, next: AccessRequest) =>
  next.status === "declined" && prev.status !== "declined";

async function forgetExpiredDeclines(
  redis: RedisTransport,
  k: StoreKeys,
  now: number,
): Promise<void> {
  const declined = k.status("declined");
  const cutoff = now - DECLINED_KEPT_SEC * MS_PER_SECOND;
  try {
    const old = await redis.command(
      ["ZRANGEBYSCORE", declined, "-inf", cutoff, "LIMIT", 0, LIST_LIMIT],
      PRUNE_TIMEOUT_MS,
    );
    if (!Array.isArray(old) || old.length === 0) return;
    const ids = old.map(String);
    const exists = pipelineValues(await redis.pipeline(
      ids.map((id): Command => ["EXISTS", k.record(id)]), PRUNE_TIMEOUT_MS));
    const gone = ids.filter((_, i) => exists[i] === 0);
    if (gone.length === 0) return;
    await redis.command(["ZREM", declined, ...gone], PRUNE_TIMEOUT_MS);
    console.info("api access declined requests deleted", gone.length);
  } catch (err) {
    if (!(err instanceof RedisReplyError ||
      err instanceof RedisUnavailableError)) throw err;
    console.error("api access declined requests not pruned", err);
  }
}

async function listStatus(
  redis: RedisTransport,
  k: StoreKeys,
  status: AccessStatus,
  now: number,
): Promise<Listed> {
  await forgetExpiredDeclines(redis, k, now);
  const [ids, ...cards] = await guarded(async () => {
    const replies = await redis.pipeline(
      [
        ["ZREVRANGE", k.status(status), 0, LIST_LIMIT - 1],
        ...ACCESS_STATUSES.map((s): Command => ["ZCARD", k.status(s)]),
      ],
      TIMEOUT_MS,
    );
    return pipelineValues(replies);
  });
  const counts = statusCountsSchema.safeParse(
    Object.fromEntries(ACCESS_STATUSES.map((s, i) => [s, cards[i]])),
  );
  if (!counts.success) throw unexpected("ZCARD", cards);
  if (!Array.isArray(ids)) throw unexpected("ZREVRANGE", ids);
  const found = ids.map(String);
  if (found.length === 0) {
    return { requests: [], counts: counts.data, unreadable: [] };
  }
  const replies = await guarded(() =>
    redis.pipeline(found.map((id) => readRecord(k, id)), TIMEOUT_MS),
  );
  const requests: AccessRequest[] = [];
  const unreadable: string[] = [];
  found.forEach((id, i) => {
    const stored = recordFrom(id, replies[i]);
    if (stored) requests.push(stored.request);
    else unreadable.push(id);
  });
  if (unreadable.length > 0) {
    console.error("api access records unreadable", status, unreadable);
  }
  return { requests, counts: counts.data, unreadable };
}

export type AccessStore = ReturnType<typeof createAccessStore>;

export function createAccessStore(namespace: string, redis: RedisTransport) {
  const call = (cmd: Command) =>
    guarded(() => redis.command(cmd, TIMEOUT_MS));
  const k = storeKeys(namespace);

  const unreadableRecord = (id: string, options?: ErrorOptions) =>
    new AccessStoreError("record_unreadable",
      `api access record ${id} unreadable`, options);

  async function byId(id: string): Promise<StoredRequest | null> {
    const reply = await call(readRecord(k, id)).catch((err: unknown) => {
      if (err instanceof AccessStoreError && refusedAsWrongType(err)) {
        throw unreadableRecord(id, { cause: err });
      }
      throw err;
    });
    if (!Array.isArray(reply)) throw unexpected("HMGET", reply);
    if (reply[0] === null) return null;
    const stored = parseStored(id, reply);
    if (stored) return stored;
    throw unreadableRecord(id);
  }

  async function idAt(pointer: string): Promise<string | null> {
    const id = await call(["GET", pointer]);
    if (id === null || typeof id === "string") return id;
    throw unexpected("GET", id);
  }

  async function insert(
    req: AccessRequest,
    cap: SenderCap,
  ): Promise<Inserted> {
    const reply = await call(createCommand(k, req, cap));
    const parsed = createReply.safeParse(reply);
    if (!parsed.success) throw unexpected("CREATE", reply);
    const [code, ttl] = parsed.data;
    if (code === 1) return "stored";
    if (code === -1) return "full";
    if (code === -2) return { waitSec: Math.max(1, ttl) };
    throw unexpected("CREATE", reply);
  }

  async function commit(
    prev: StoredRequest,
    next: AccessRequest,
  ): Promise<boolean> {
    const reply = await call(commitCommand(k, prev, next));
    if (reply === 0 || reply === 1) return reply === 1;
    throw unexpected("COMMIT", reply);
  }

  async function byTokenHash(hash: string): Promise<StoredRequest | null> {
    const id = await idAt(k.token(hash));
    if (!id) return null;
    const stored = await byId(id);
    if (stored?.request.tokenHash === hash) return stored;
    if (stored) {
      console.warn("api access status link moved during the read", id);
    } else {
      console.error("api access status link points to no request", id);
    }
    return null;
  }

  async function keyIndex(): Promise<ReadonlyMap<string, string>> {
    const reply = await call(["HGETALL", k.keyIndex]);
    const pairs = flatPairs.safeParse(reply);
    if (!pairs.success) throw unexpected("HGETALL", reply);
    const ids = new Map<string, string>();
    for (let i = 0; i < pairs.data.length; i += 2) {
      ids.set(pairs.data[i] ?? "", pairs.data[i + 1] ?? "");
    }
    return ids;
  }

  const list = (status: AccessStatus, now: number) =>
    listStatus(redis, k, status, now);

  return { insert, byId, byTokenHash, commit, keyIndex, list };
}
