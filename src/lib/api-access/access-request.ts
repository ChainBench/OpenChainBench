import { z } from "zod";
import {
  type HistoryEvent,
  KEY_SUFFIX_CHARS,
  REQUEST_ID,
  type Requester,
  changeSchema,
  storedRequesterSchema,
} from "./contract";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_HISTORY = 50;

const keySchema = z.object({
  hash: z.string().regex(SHA256_HEX),
  last4: z.string().length(KEY_SUFFIX_CHARS),
  createdAt: z.number(),
});
export type KeyInfo = z.infer<typeof keySchema>;

const base = {
  id: z.string().regex(REQUEST_ID),
  requester: storedRequesterSchema,
  createdAt: z.number(),
  tokenHash: z.string().regex(SHA256_HEX),
  history: z.array(changeSchema),
};

export const accessRequestSchema = z.discriminatedUnion("status", [
  z.object({ ...base, status: z.literal("pending") }),
  z.object({
    ...base,
    status: z.literal("approved"),
    approvedAt: z.number(),
    key: keySchema.nullable(),
  }),
  z.object({
    ...base,
    status: z.literal("declined"),
    declinedAt: z.number(),
    reason: z.string(),
  }),
  z.object({
    ...base,
    status: z.literal("revoked"),
    revokedAt: z.number(),
    lastKey: keySchema.nullable(),
  }),
]);
export type AccessRequest = z.infer<typeof accessRequestSchema>;
type Status = AccessRequest["status"];
export type Approved = Extract<AccessRequest, { status: "approved" }>;

export type Decision =
  | { to: "approved" }
  | { to: "declined"; reason: string }
  | { to: "revoked" };

type Decided =
  | { ok: true; next: AccessRequest }
  | { ok: false; error: "illegal_transition" };

const ALLOWED: Readonly<Record<Status, readonly Decision["to"][]>> = {
  pending: ["approved", "declined"],
  approved: ["revoked"],
  declined: [],
  revoked: [],
};

type Change = AccessRequest["history"][number];

const KEPT_EVENTS: readonly HistoryEvent[] = [
  "requested",
  "approved",
  "declined",
  "revoked",
];
const isTrimmable = (c: Change) => !KEPT_EVENTS.includes(c.event);

function capped(history: Change[]): Change[] {
  const extra = history.length - MAX_HISTORY;
  if (extra <= 0) return history;
  const trimmable = history.flatMap((c, i) => (isTrimmable(c) ? [i] : []));
  const dropped = new Set(trimmable.slice(0, extra));
  return history.filter((_, i) => !dropped.has(i));
}

const appendEvent = (req: AccessRequest, change: Change) =>
  capped([...req.history, change]);

export function openRequest(input: {
  id: string;
  requester: Requester;
  tokenHash: string;
  now: number;
}): AccessRequest {
  return {
    id: input.id,
    requester: input.requester,
    createdAt: input.now,
    tokenHash: input.tokenHash,
    history: [{ event: "requested", at: input.now, source: "requester" }],
    status: "pending",
  };
}

function applyDecision(
  req: AccessRequest,
  decision: Decision,
  now: number,
): AccessRequest {
  const common = {
    id: req.id,
    requester: req.requester,
    createdAt: req.createdAt,
    tokenHash: req.tokenHash,
    history: appendEvent(req, { event: decision.to, source: "team", at: now }),
  };
  switch (decision.to) {
    case "approved":
      return { ...common, status: "approved", approvedAt: now, key: null };
    case "declined":
      return {
        ...common,
        status: "declined",
        declinedAt: now,
        reason: decision.reason,
      };
    case "revoked":
      return {
        ...common,
        status: "revoked",
        revokedAt: now,
        lastKey: req.status === "approved" ? req.key : null,
      };
    default: {
      const unreachable: never = decision;
      return unreachable;
    }
  }
}

export function decide(
  req: AccessRequest,
  decision: Decision,
  now: number,
): Decided {
  if (!ALLOWED[req.status].includes(decision.to)) {
    return { ok: false, error: "illegal_transition" };
  }
  return { ok: true, next: applyDecision(req, decision, now) };
}

export function withKey(req: Approved, key: KeyInfo): Approved {
  const event = req.key ? "key_replaced" : "key_created";
  return {
    ...req,
    key,
    history: appendEvent(req, {
      event,
      source: "requester",
      at: key.createdAt,
    }),
  };
}

export function withToken(
  req: AccessRequest,
  tokenHash: string,
  now: number,
): AccessRequest {
  return {
    ...req,
    tokenHash,
    history: appendEvent(req, {
      event: "link_reissued",
      source: "team",
      at: now,
    }),
  };
}
