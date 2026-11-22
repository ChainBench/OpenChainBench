import { randomUUID } from "node:crypto";
import { redisCommand, redisPipelineSettled } from "@/lib/materialize/store";
import { sha256Hex } from "@/lib/sha256";
import { SECONDS_PER_HOUR } from "@/lib/time-constants";
import {
  type AccessRequest,
  type Decision,
  decide,
  openRequest,
  withKey,
  withToken,
} from "./access-request";
import {
  type AccessStore,
  type StoredRequest,
  createAccessStore,
} from "./access-store";
import {
  type AccessStatus,
  KEY_SUFFIX_CHARS,
  type KeyRefusal,
  type LinkRefusal,
  type Requester,
} from "./contract";
import { newApiKey, newStatusToken } from "./secrets";

type Failure<E extends string> = { ok: false; error: E };
type Outcome<T, E extends string> = ({ ok: true } & T) | Failure<E>;

type Submitted =
  | Outcome<{ token: string; request: AccessRequest }, "full">
  | { ok: false; error: "sender_capped"; retryAfterSec: number };

const REQUESTS_PER_SENDER_HOUR = 5;
type KeyIssue = Outcome<
  { key: string; request: AccessRequest },
  LinkRefusal | KeyRefusal
>;
type DecisionOutcome = Outcome<
  { request: AccessRequest },
  "not_found" | "illegal_transition" | "conflict"
>;
type LinkReissue = Outcome<
  { token: string; request: AccessRequest },
  "not_found" | "conflict"
>;

type DeployEnv = { VERCEL_ENV?: string; NODE_ENV?: string };

export function namespaceFor(env: DeployEnv): string {
  return `ocb:apiaccess:${env.VERCEL_ENV ?? env.NODE_ENV ?? "development"}:`;
}

async function commitOrConflict<T extends object>(
  store: AccessStore,
  change: { prev: StoredRequest; next: AccessRequest },
  done: T,
): Promise<({ ok: true } & T) | Failure<"conflict">> {
  if (!(await store.commit(change.prev, change.next))) {
    return { ok: false, error: "conflict" };
  }
  return { ok: true, ...done };
}

type KeyAsk = { token: string; replacing: string | null; now: number };

async function issueKey(
  store: AccessStore,
  { token, replacing, now }: KeyAsk,
): Promise<KeyIssue> {
  const stored = await store.byTokenHash(sha256Hex(token));
  if (!stored) return { ok: false, error: "unknown_link" };
  if (stored.request.status !== "approved") {
    return { ok: false, error: "not_approved" };
  }
  if ((stored.request.key?.last4 ?? null) !== replacing) {
    return { ok: false, error: "key_changed" };
  }
  const key = newApiKey();
  const next = withKey(stored.request, {
    hash: sha256Hex(key),
    last4: key.slice(-KEY_SUFFIX_CHARS),
    createdAt: now,
  });
  return commitOrConflict(store, { prev: stored, next },
    { key, request: next });
}

async function reissueLink(
  store: AccessStore,
  id: string,
  now: number,
): Promise<LinkReissue> {
  const stored = await store.byId(id);
  if (!stored) return { ok: false, error: "not_found" };
  const token = newStatusToken();
  const next = withToken(stored.request, sha256Hex(token), now);
  return commitOrConflict(store, { prev: stored, next },
    { token, request: next });
}

export function createApiAccess(store: AccessStore) {
  async function submit(
    requester: Requester,
    { now, sender }: { now: number; sender: string },
  ): Promise<Submitted> {
    const token = newStatusToken();
    const request = openRequest({
      id: randomUUID(),
      requester,
      tokenHash: sha256Hex(token),
      now,
    });
    const stored = await store.insert(request, {
      sender: sha256Hex(sender),
      perWindow: REQUESTS_PER_SENDER_HOUR,
      windowSec: SECONDS_PER_HOUR,
    });
    if (stored === "full") return { ok: false, error: "full" };
    if (stored !== "stored") {
      return { ok: false, error: "sender_capped",
        retryAfterSec: stored.waitSec };
    }
    return { ok: true, token, request };
  }

  async function byToken(token: string): Promise<AccessRequest | null> {
    const stored = await store.byTokenHash(sha256Hex(token));
    return stored?.request ?? null;
  }

  async function decideOn(
    id: string,
    decision: Decision,
    now: number,
  ): Promise<DecisionOutcome> {
    const stored = await store.byId(id);
    if (!stored) return { ok: false, error: "not_found" };
    const decided = decide(stored.request, decision, now);
    if (!decided.ok) return { ok: false, error: decided.error };
    const next = decided.next;
    return commitOrConflict(store, { prev: stored, next },
      { request: next });
  }

  return {
    submit,
    byToken,
    issueKey: (ask: KeyAsk) => issueKey(store, ask),
    decideOn,
    reissueLink: (id: string, now: number) => reissueLink(store, id, now),
    keyIndex: () => store.keyIndex(),
    list: (status: AccessStatus, now: number) => store.list(status, now),
  };
}

export type ApiAccess = ReturnType<typeof createApiAccess>;

export function apiAccess(): ApiAccess {
  const redis = { command: redisCommand, pipeline: redisPipelineSettled };
  return createApiAccess(createAccessStore(namespaceFor(process.env), redis));
}
