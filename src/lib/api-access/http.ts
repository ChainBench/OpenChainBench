import {
  clientNetworkKey,
  clientSubnetKey,
  globalLimit,
  holdLimit,
  logAtMost,
  peekGlobalLimit,
  peekLimit,
  rateLimit,
  tooManyRequests,
} from "@/lib/rate-limit";
import { SECONDS_PER_MINUTE } from "@/lib/time-constants";
import { AccessStoreError } from "./access-store";
import type { RequestRefusal, StoreRefusal } from "./contract";

const MAX_BODY_CHARS = 8_000;

export const PRIVATE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
} as const;

export function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: PRIVATE_HEADERS });
}

const BUSY: RequestRefusal = "busy";
const UNAVAILABLE: StoreRefusal = "unavailable";
const UNREADABLE: StoreRefusal = "unreadable";

function siteBusy(retryAfterSec: number): Response {
  return Response.json(
    { error: BUSY, retryAfterSec },
    {
      status: 503,
      headers: { ...PRIVATE_HEADERS, "Retry-After": String(retryAfterSec) },
    },
  );
}

export type Admission = {
  route: string;
  perNetwork: number;
  perInstance: number;
};
const ADMISSION_WINDOW_SEC = SECONDS_PER_MINUTE;
const ATTEMPTS_PER_SERVED = 4;

export const ADMISSIONS = {
  request: { route: "api-access-request", perNetwork: 3, perInstance: 60 },
  status: { route: "api-access-status", perNetwork: 10, perInstance: 120 },
  key: { route: "api-access-key", perNetwork: 5, perInstance: 40 },
} as const satisfies Record<string, Admission>;

export type Gate = {
  admit: () => Response | null;
  served: () => void;
  capped: (retryAfterSec: number) => void;
};

const UNKNOWN_LINKS_PER_NETWORK = 3;
const UNKNOWN_LINK_SCOPE = "api-access-unknown-link";

export type LinkGate = Gate & { missed: () => void };

export function linkGate(req: Request, admission: Admission): LinkGate {
  const misses = clientNetworkKey(req, UNKNOWN_LINK_SCOPE);
  const gate = requesterGate(req, admission);
  return {
    ...gate,
    admit: () => {
      const tries = peekLimit(
        misses,
        UNKNOWN_LINKS_PER_NETWORK,
        ADMISSION_WINDOW_SEC,
      );
      if (!tries.ok) return tooManyRequests(tries.retryAfterSec);
      return gate.admit();
    },
    missed: () =>
      void rateLimit(misses, UNKNOWN_LINKS_PER_NETWORK, ADMISSION_WINDOW_SEC),
  };
}

export function requesterGate(
  req: Request,
  { route, perNetwork, perInstance }: Admission,
): Gate {
  const networkKey = clientSubnetKey(req, route);
  return {
    admit: () => {
      const network = peekLimit(networkKey, perNetwork, ADMISSION_WINDOW_SEC);
      if (!network.ok) return tooManyRequests(network.retryAfterSec);
      const served = peekGlobalLimit(route, perInstance, ADMISSION_WINDOW_SEC);
      const site = served.ok
        ? globalLimit(`${route}-attempts`, perInstance * ATTEMPTS_PER_SERVED,
          ADMISSION_WINDOW_SEC)
        : served;
      if (!site.ok) {
        logAtMost(1, `${route}-busy`, () =>
          console.warn("api access refused: site busy", route));
        return siteBusy(site.retryAfterSec);
      }
      rateLimit(networkKey, perNetwork, ADMISSION_WINDOW_SEC);
      return null;
    },
    served: () =>
      void globalLimit(route, perInstance, ADMISSION_WINDOW_SEC),
    capped: (retryAfterSec) => holdLimit(networkKey, retryAfterSec),
  };
}

const isJson = (req: Request) =>
  (req.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("application/json");

async function readCapped(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
    if (text.length > MAX_BODY_CHARS) {
      await reader.cancel();
      return null;
    }
  }
}

export async function readJsonBody(req: Request): Promise<unknown> {
  if (!isJson(req)) return undefined;
  const text = await readCapped(req);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function orUnavailable(
  work: () => Promise<Response>,
): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    if (!(err instanceof AccessStoreError)) throw err;
    if (err.code === "store_unexpected") throw err;
    if (err.code === "record_unreadable") {
      console.error("api access record unreadable", err);
      return privateJson({ error: UNREADABLE }, 500);
    }
    console.error("api access store unavailable", err);
    return privateJson({ error: UNAVAILABLE }, 503);
  }
}
