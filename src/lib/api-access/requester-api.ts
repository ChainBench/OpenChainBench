import { z } from "zod";
import {
  clientSubnetKey,
  logAtMost,
  peekLimit,
  rateLimit,
  tooManyRequests,
} from "@/lib/rate-limit";
import { sha256Hex } from "@/lib/sha256";
import { SECONDS_PER_MINUTE } from "@/lib/time-constants";
import type { AccessRequest } from "./access-request";
import { AccessStoreError } from "./access-store";
import type { ApiAccess } from "./api-access";
import {
  type InvalidRequest,
  type LinkRefusal,
  MAX_PENDING,
  type RequestRefusal,
  keyBodySchema,
  requesterSchema,
  tokenBodySchema,
} from "./contract";
import {
  type Gate,
  type LinkGate,
  orUnavailable,
  privateJson,
  readJsonBody,
} from "./http";
import { requesterView } from "./requester-view";
import { newStatusToken } from "./secrets";

const TRAP_LOGS_PER_MINUTE = 10;
const SENDER_SCOPE = "api-access-sender";
const LINK_READS_SCOPE = "api-access-link";
const READS_PER_LINK = 10;

const honeypotSchema = z.object({
  ocb_check: z.string().min(1),
  email: z.string().optional(),
});
const MAX_LOGGED_DOMAIN = 100;

type Submission = {
  access: ApiAccess;
  now: number;
  gate: Gate;
  onSubmitted: (request: AccessRequest) => void;
  onQueueFull: () => void;
};

const QUEUE_FULL: RequestRefusal = "queue_full";
const queueFull = () => privateJson({ error: QUEUE_FULL }, 503);
const NOT_SAVED: RequestRefusal = "not_saved";

async function orNotSaved(
  work: () => Promise<Response>,
): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    if (!(err instanceof AccessStoreError) || !err.unsent) throw err;
    console.error("api access request not saved", err);
    return privateJson({ error: NOT_SAVED }, 503);
  }
}

function trapped(body: unknown): boolean {
  const trap = honeypotSchema.safeParse(body);
  if (!trap.success) return false;
  const domain = trap.data.email?.split("@")[1] ?? "";
  logAtMost(TRAP_LOGS_PER_MINUTE, "api-access-trap", () =>
    console.warn("api access honeypot hit", {
      emailDomain: domain.slice(0, MAX_LOGGED_DOMAIN),
      trapLength: trap.data.ocb_check.length,
    }));
  return true;
}

export async function submitRequest(
  req: Request,
  { access, now, gate, onSubmitted, onQueueFull }: Submission,
): Promise<Response> {
  const body = await readJsonBody(req);
  if (trapped(body)) return privateJson({ token: newStatusToken() }, 201);
  const parsed = requesterSchema.safeParse(body);
  if (!parsed.success) {
    const named = parsed.error.issues.flatMap((i) => {
      const [field] = i.path;
      return typeof field === "string" ? [field] : [];
    });
    const invalid: InvalidRequest = {
      error: "invalid",
      fields: [...new Set(named)],
    };
    return privateJson(invalid, 400);
  }
  const refused = gate.admit();
  if (refused) return refused;
  return orUnavailable(() => orNotSaved(async () => {
    const submitted = await access.submit(parsed.data, {
      now,
      sender: clientSubnetKey(req, SENDER_SCOPE),
    });
    if (!submitted.ok && submitted.error === "sender_capped") {
      gate.capped(submitted.retryAfterSec);
      return tooManyRequests(submitted.retryAfterSec);
    }
    if (!submitted.ok) {
      logAtMost(1, "api-access-queue-full", () =>
        console.error("api access queue full", MAX_PENDING, "waiting"));
      onQueueFull();
      return queueFull();
    }
    gate.served();
    onSubmitted(submitted.request);
    return privateJson({ token: submitted.token }, 201);
  }));
}

const UNKNOWN_LINK: LinkRefusal = "unknown_link";
const unknownLink = () => privateJson({ error: UNKNOWN_LINK }, 404);

type Lookup = { access: ApiAccess; gate: LinkGate };

function linkUses(token: string) {
  const key = `${LINK_READS_SCOPE}:${sha256Hex(token)}`;
  return {
    refused: (): Response | null => {
      const left = peekLimit(key, READS_PER_LINK, SECONDS_PER_MINUTE);
      return left.ok ? null : tooManyRequests(left.retryAfterSec);
    },
    spend: () => rateLimit(key, READS_PER_LINK, SECONDS_PER_MINUTE),
    firstThisMinute: () =>
      rateLimit(`${key}:served`, 1, SECONDS_PER_MINUTE).ok,
  };
}

export async function showStatus(
  req: Request,
  { access, gate }: Lookup,
): Promise<Response> {
  const parsed = tokenBodySchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return unknownLink();
  const link = linkUses(parsed.data.token);
  const refused = link.refused() ?? gate.admit();
  if (refused) return refused;
  return orUnavailable(async () => {
    const request = await access.byToken(parsed.data.token);
    if (!request) {
      gate.missed();
      return unknownLink();
    }
    const use = link.spend();
    if (!use.ok) return tooManyRequests(use.retryAfterSec);
    if (link.firstThisMinute()) gate.served();
    return privateJson(requesterView(request));
  });
}

export async function createKey(
  req: Request,
  { access, gate, now }: Lookup & { now: number },
): Promise<Response> {
  const parsed = keyBodySchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return unknownLink();
  const { token, replacing } = parsed.data;
  const link = linkUses(token);
  const refused = link.refused() ?? gate.admit();
  if (refused) return refused;
  return orUnavailable(async () => {
    const issued = await access.issueKey({ token, replacing, now });
    if (!issued.ok && issued.error === UNKNOWN_LINK) {
      gate.missed();
      return unknownLink();
    }
    link.spend();
    if (!issued.ok) return privateJson({ error: issued.error }, 409);
    gate.served();
    const view = requesterView(issued.request);
    return privateJson({ key: issued.key, view }, 201);
  });
}
